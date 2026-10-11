SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE continuum_extension_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $profiles$
DECLARE candidate RECORD;
BEGIN
  FOR candidate IN SELECT profile.database_role_oid,role.rolname,profile.profile_kind
    FROM continuum_pgvector_role_profiles profile JOIN pg_catalog.pg_roles role ON role.oid=profile.database_role_oid
    WHERE profile.profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_extension_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN CONTINUE;
    END;
  END LOOP;
END;
$profiles$;

CREATE TABLE promotion_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_memory_id         UUID NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  destination_memory_id    UUID NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  destination_scope_id     UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  destination_scope_kind   TEXT NOT NULL CHECK (destination_scope_kind IN ('org', 'team', 'project', 'user', 'role')),
  destination_scope_name   TEXT NOT NULL,
  principal_id             UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_memory_id)
);

CREATE TABLE promotion_event_deliveries (
  event_id         UUID NOT NULL REFERENCES promotion_events(id) ON DELETE CASCADE,
  webhook_id       TEXT NOT NULL CHECK (webhook_id ~ '^[a-z][a-z0-9.-]{0,63}$'),
  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'delivered', 'dead_letter', 'privacy_cancelled')),
  available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_owner      TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error       TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 256),
  delivered_at     TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  PRIMARY KEY (event_id, webhook_id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX promotion_event_deliveries_claim_idx
  ON promotion_event_deliveries (available_at, lease_expires_at)
  WHERE state = 'pending';

REVOKE ALL ON promotion_events,promotion_event_deliveries FROM PUBLIC;
DO $extend$
DECLARE definition TEXT; revised TEXT; candidate RECORD; schema_name TEXT:=current_schema();
BEGIN
  SELECT pg_catalog.pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure) INTO definition;
  revised:=replace(definition,'(''embedding_backfill_failures'',''DELETE'')',
    '(''embedding_backfill_failures'',''DELETE''),(''promotion_events'',''SELECT''),(''promotion_events'',''INSERT''),(''promotion_event_deliveries'',''SELECT''),(''promotion_event_deliveries'',''INSERT''),(''promotion_event_deliveries'',''UPDATE'')');
  IF revised=definition THEN RAISE EXCEPTION 'extension profile requires the installed embedding allowlist'; END IF;
  EXECUTE revised;
  FOR candidate IN SELECT * FROM continuum_extension_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    EXECUTE format('GRANT SELECT,INSERT ON TABLE %I.promotion_events TO %I',schema_name,candidate.role_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE %I.promotion_event_deliveries TO %I',schema_name,candidate.role_name);
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END;
$extend$;

-- Erasure retains UUID accounting, never a personal scope snapshot or a retryable callback.
CREATE INDEX promotion_events_scope_privacy_idx ON promotion_events(destination_scope_id,id);
CREATE FUNCTION continuum_operator_scrub_promotion_scope(
  authorization_principal_id UUID,target_principal_id UUID,target_scope_id UUID,batch_limit INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE scope_name TEXT; names_processed INTEGER; deliveries_processed INTEGER; clean BOOLEAN;
BEGIN
  IF batch_limit NOT BETWEEN 1 AND 1000 THEN RAISE check_violation USING MESSAGE='promotion privacy batch is outside the supported range'; END IF;
  -- This accessor checks the bound approve caller, current manual org admin,
  -- disabled user mapping and matching immutable approval evidence.
  PERFORM * FROM continuum_operator_coordination_scope_privacy_state(authorization_principal_id,target_scope_id);
  IF NOT EXISTS(SELECT 1 FROM principal_user_scopes WHERE principal_id=target_principal_id AND scope_id=target_scope_id) THEN
    RAISE insufficient_privilege USING MESSAGE='promotion privacy requires the approved target mapping';
  END IF;
  PERFORM 1 FROM continuum_operator_get_offboarding_run(target_principal_id,authorization_principal_id) WHERE scope_id=target_scope_id;
  IF NOT FOUND THEN RAISE insufficient_privilege USING MESSAGE='promotion privacy requires an authorized offboarding run'; END IF;
  SELECT name INTO scope_name FROM scopes WHERE id=target_scope_id;
  WITH batch AS (
    SELECT id FROM promotion_events WHERE destination_scope_id=target_scope_id AND destination_scope_name<>scope_name
    ORDER BY id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ) UPDATE promotion_events event SET destination_scope_name=scope_name FROM batch WHERE event.id=batch.id;
  GET DIAGNOSTICS names_processed=ROW_COUNT;
  WITH batch AS (
    SELECT delivery.event_id,delivery.webhook_id FROM promotion_event_deliveries delivery
    JOIN promotion_events event ON event.id=delivery.event_id
    WHERE event.destination_scope_id=target_scope_id
      AND (delivery.state<>'privacy_cancelled' OR delivery.last_error IS NOT NULL OR delivery.lease_owner IS NOT NULL)
    ORDER BY delivery.event_id,delivery.webhook_id LIMIT batch_limit FOR UPDATE OF delivery SKIP LOCKED
  ) UPDATE promotion_event_deliveries delivery SET state='privacy_cancelled',last_error=NULL,
      lease_owner=NULL,lease_expires_at=NULL,lease_generation=delivery.lease_generation+1
    FROM batch WHERE delivery.event_id=batch.event_id AND delivery.webhook_id=batch.webhook_id;
  GET DIAGNOSTICS deliveries_processed=ROW_COUNT;
  clean:=NOT EXISTS(SELECT 1 FROM promotion_events WHERE destination_scope_id=target_scope_id AND destination_scope_name<>scope_name)
    AND NOT EXISTS(SELECT 1 FROM promotion_event_deliveries delivery JOIN promotion_events event ON event.id=delivery.event_id
      WHERE event.destination_scope_id=target_scope_id AND (delivery.state<>'privacy_cancelled' OR delivery.last_error IS NOT NULL OR delivery.lease_owner IS NOT NULL));
  IF names_processed+deliveries_processed>0 THEN
    INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(authorization_principal_id,'archive',target_scope_id,
      continuum_offboarding_expected_audit_metadata('{}'::jsonb));
  END IF;
  RETURN jsonb_build_object('complete',clean,'processed',names_processed+deliveries_processed);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_scrub_promotion_scope(UUID,UUID,UUID,INTEGER) FROM PUBLIC;

ALTER FUNCTION continuum_offboarding_lifecycle_state_is_erased(UUID) RENAME TO continuum_offboarding_lifecycle_state_is_erased_pre_extensions;
CREATE FUNCTION continuum_offboarding_lifecycle_state_is_erased(target_run_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_offboarding_lifecycle_state_is_erased_pre_extensions(target_run_id)
    AND COALESCE((SELECT NOT EXISTS(SELECT 1 FROM promotion_events event
        WHERE event.destination_scope_id=run.scope_id AND event.destination_scope_name<>scope.name)
      AND NOT EXISTS(SELECT 1 FROM promotion_event_deliveries delivery JOIN promotion_events event ON event.id=delivery.event_id
        WHERE event.destination_scope_id=run.scope_id AND (delivery.state<>'privacy_cancelled' OR delivery.last_error IS NOT NULL OR delivery.lease_owner IS NOT NULL))
      FROM principal_offboarding_runs run JOIN scopes scope ON scope.id=run.scope_id WHERE run.run_id=target_run_id),FALSE);
$$;
REVOKE ALL ON FUNCTION continuum_offboarding_lifecycle_state_is_erased(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION continuum_offboarding_lifecycle_state_is_erased_pre_extensions(UUID) FROM PUBLIC;

CREATE FUNCTION continuum_guard_promotion_privacy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_TABLE_NAME='promotion_events' THEN
    IF NOT EXISTS(SELECT 1 FROM scopes scope JOIN memories destination ON destination.scope_id=scope.id
      JOIN memories source ON source.id=NEW.source_memory_id
      JOIN principals principal ON principal.id=NEW.principal_id AND principal.disabled_at IS NULL
      WHERE destination.id=NEW.destination_memory_id AND source.promoted_to_id=destination.id
        AND scope.id=NEW.destination_scope_id AND scope.kind=NEW.destination_scope_kind AND scope.name=NEW.destination_scope_name
        AND destination.state='live') THEN
      RAISE check_violation USING MESSAGE='promotion event requires canonical live promotion provenance';
    END IF;
    IF EXISTS(SELECT 1 FROM principal_user_scopes mapping JOIN principals principal ON principal.id=mapping.principal_id
      WHERE mapping.scope_id=NEW.destination_scope_id AND principal.disabled_at IS NOT NULL) THEN
      RAISE check_violation USING MESSAGE='promotion event destination is disabled';
    END IF;
  ELSIF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM promotion_events event JOIN principal_user_scopes mapping ON mapping.scope_id=event.destination_scope_id
    JOIN principals principal ON principal.id=mapping.principal_id AND principal.disabled_at IS NOT NULL WHERE event.id=NEW.event_id) THEN
    RAISE check_violation USING MESSAGE='promotion delivery destination is disabled';
  ELSIF TG_OP='UPDATE' AND OLD.state='privacy_cancelled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE check_violation USING MESSAGE='erased promotion delivery is immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_promotion_privacy() FROM PUBLIC;
CREATE TRIGGER guard_promotion_event_privacy BEFORE INSERT ON promotion_events
FOR EACH ROW EXECUTE FUNCTION continuum_guard_promotion_privacy();
CREATE TRIGGER guard_promotion_delivery_privacy BEFORE INSERT OR UPDATE ON promotion_event_deliveries
FOR EACH ROW EXECUTE FUNCTION continuum_guard_promotion_privacy();
DO $privacy_roles$
DECLARE definition TEXT; revised TEXT; candidate RECORD; schema_name TEXT:=current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN SELECT proname,pg_catalog.pg_get_function_identity_arguments(oid) arguments FROM pg_catalog.pg_proc
    WHERE pronamespace=pg_catalog.to_regnamespace(schema_name) AND proname=ANY(ARRAY[
      'continuum_operator_scrub_promotion_scope','continuum_offboarding_lifecycle_state_is_erased',
      'continuum_offboarding_lifecycle_state_is_erased_pre_extensions','continuum_guard_promotion_privacy']) LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path=pg_catalog,%I,pg_temp',schema_name,function_record.proname,function_record.arguments,schema_name);
  END LOOP;
  SELECT pg_catalog.pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure) INTO definition;
  revised:=replace(definition,'(''continuum_operator_coordination_scope_privacy_state(uuid,uuid)''),',
    '(''continuum_operator_coordination_scope_privacy_state(uuid,uuid)''),(''continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)''),');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend promotion operator allowlist'; END IF;
  EXECUTE revised;
  FOR candidate IN SELECT * FROM continuum_extension_upgrade_roles WHERE operator LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_scrub_promotion_scope(UUID,UUID,UUID,INTEGER) TO %I',schema_name,candidate.role_name);
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,TRUE);
  END LOOP;
END;
$privacy_roles$;
