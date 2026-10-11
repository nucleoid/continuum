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
  ON promotion_event_deliveries (webhook_id, available_at, event_id)
  INCLUDE(lease_expires_at,attempt_count)
  WHERE state = 'pending';
CREATE INDEX promotion_event_deliveries_exhausted_idx
  ON promotion_event_deliveries(webhook_id,attempt_count,available_at,event_id)
  INCLUDE(lease_expires_at,lease_generation)
  WHERE state='pending' AND attempt_count>0;

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
DECLARE scope_name TEXT; names_processed INTEGER; deliveries_processed INTEGER; clean BOOLEAN; privacy_run principal_offboarding_runs%ROWTYPE;
BEGIN
  IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 1000 THEN RAISE check_violation USING MESSAGE='promotion privacy batch is outside the supported range'; END IF;
  -- This accessor checks the bound approve caller, current manual org admin,
  -- disabled user mapping and matching immutable approval evidence.
  PERFORM * FROM continuum_operator_coordination_scope_privacy_state(authorization_principal_id,target_scope_id);
  IF NOT EXISTS(SELECT 1 FROM principal_user_scopes WHERE principal_id=target_principal_id AND scope_id=target_scope_id) THEN
    RAISE insufficient_privilege USING MESSAGE='promotion privacy requires the approved target mapping';
  END IF;
  SELECT * INTO privacy_run FROM continuum_operator_get_offboarding_run(target_principal_id,authorization_principal_id) WHERE scope_id=target_scope_id;
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
      jsonb_build_object('operation','principal_promotion_privacy_repaired','principal_id',target_principal_id,
        'run_id',privacy_run.run_id,'approval_id',privacy_run.approval_id::text,
        'acknowledged_evidence_hash',privacy_run.approval_evidence_hash,'rows_processed',names_processed+deliveries_processed));
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

  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_promotion_privacy() FROM PUBLIC;
CREATE TRIGGER guard_promotion_event_privacy BEFORE INSERT ON promotion_events
FOR EACH ROW EXECUTE FUNCTION continuum_guard_promotion_privacy();
CREATE TRIGGER guard_promotion_delivery_privacy BEFORE INSERT OR UPDATE ON promotion_event_deliveries
FOR EACH ROW EXECUTE FUNCTION continuum_guard_promotion_privacy();
-- Invoker identity is essential here: the validated owner-definer scrub reaches
-- this trigger as owner, while a direct APP or OP table write does not.
CREATE FUNCTION continuum_guard_promotion_cancellation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE trusted_owner BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW.state='privacy_cancelled' OR (TG_OP='UPDATE' AND OLD.state='privacy_cancelled') THEN
    SELECT relation.relowner=role.oid INTO trusted_owner FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_roles role ON role.rolname=current_user WHERE relation.oid=TG_RELID;
    IF trusted_owner IS DISTINCT FROM TRUE THEN
      RAISE check_violation USING MESSAGE='promotion cancellation requires the trusted erasure capability';
    END IF;
    -- The schema owner can import a historical terminal row. An authorized
    -- scrub may repair its dirty shape; runtime writers cannot manufacture it.
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    IF NEW.state<>'privacy_cancelled' OR NEW.last_error IS NOT NULL OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
      OR NEW.lease_generation<>OLD.lease_generation+1
      OR (to_jsonb(NEW)-ARRAY['state','last_error','lease_owner','lease_expires_at','lease_generation'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','last_error','lease_owner','lease_expires_at','lease_generation']) THEN
      RAISE check_violation USING MESSAGE='erased promotion delivery only permits canonical trusted cleanup';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_promotion_cancellation() FROM PUBLIC;
CREATE TRIGGER guard_promotion_delivery_cancellation BEFORE INSERT OR UPDATE ON promotion_event_deliveries
FOR EACH ROW EXECUTE FUNCTION continuum_guard_promotion_cancellation();
DO $privacy_roles$
DECLARE definition TEXT; revised TEXT; candidate RECORD; schema_name TEXT:=current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN SELECT proname,pg_catalog.pg_get_function_identity_arguments(oid) arguments FROM pg_catalog.pg_proc
    WHERE pronamespace=(SELECT namespace.oid FROM pg_catalog.pg_namespace namespace WHERE namespace.nspname=schema_name) AND proname=ANY(ARRAY[
      'continuum_operator_scrub_promotion_scope','continuum_offboarding_lifecycle_state_is_erased',
      'continuum_offboarding_lifecycle_state_is_erased_pre_extensions','continuum_guard_promotion_privacy','continuum_guard_promotion_cancellation']) LOOP
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

-- Canonical receipts need authority before the older definer audit guard.
CREATE FUNCTION continuum_guard_promotion_privacy_audit() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    IF OLD.metadata->>'operation'='principal_promotion_privacy_repaired'
      OR (TG_OP='UPDATE' AND NEW.metadata->>'operation'='principal_promotion_privacy_repaired') THEN
      RAISE check_violation USING MESSAGE='promotion privacy evidence is immutable';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF NEW.metadata->>'operation'<>'principal_promotion_privacy_repaired' OR NEW.metadata->>'operation' IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_roles role ON role.rolname=current_user
    WHERE relation.oid=TG_RELID AND relation.relowner=role.oid) THEN
    RAISE insufficient_privilege USING MESSAGE='promotion privacy audit requires the trusted erasure capability';
  END IF;
  PERFORM * FROM continuum_operator_coordination_scope_privacy_state(NEW.principal_id,NEW.scope_id);
  IF NEW.action<>'archive' OR NEW.query IS NOT NULL OR NEW.memory_id IS NOT NULL
    OR NEW.metadata IS DISTINCT FROM continuum_offboarding_expected_audit_metadata(NEW.metadata)
    OR jsonb_typeof(NEW.metadata->'rows_processed')<>'number'
    OR COALESCE(NEW.metadata->>'rows_processed','')!~'^[0-9]+$'
    OR (NEW.metadata->>'rows_processed')::numeric NOT BETWEEN 1 AND 2000
    OR NOT EXISTS(SELECT 1 FROM principal_offboarding_runs run
      WHERE run.run_id::text=NEW.metadata->>'run_id' AND run.scope_id=NEW.scope_id
        AND run.principal_id::text=NEW.metadata->>'principal_id'
        AND run.approval_id::text=NEW.metadata->>'approval_id'
        AND run.approval_evidence_hash=NEW.metadata->>'acknowledged_evidence_hash') THEN
    RAISE check_violation USING MESSAGE='promotion privacy audit requires canonical approved run evidence';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_promotion_privacy_audit() FROM PUBLIC;
CREATE TRIGGER promotion_privacy_audit_capability BEFORE INSERT OR UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION continuum_guard_promotion_privacy_audit();
DO $privacy_audit$
DECLARE definition TEXT; revised TEXT; signature TEXT; begin_at INTEGER; schema_name TEXT:=current_schema();
BEGIN
  definition:=pg_catalog.pg_get_functiondef('continuum_offboarding_expected_audit_metadata(jsonb)'::regprocedure);
  revised:=replace(definition,'  SELECT CASE',$branch$  SELECT CASE
    WHEN audit_metadata->>'operation'='principal_promotion_privacy_repaired' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb) FROM jsonb_each(audit_metadata) entry
        WHERE entry.key=ANY(ARRAY['operation','principal_id','run_id','approval_id','acknowledged_evidence_hash','rows_processed']::text[]))$branch$);
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend promotion privacy audit classifier'; END IF;
  EXECUTE revised;
  definition:=pg_catalog.pg_get_functiondef('continuum_reject_offboarded_principal_audit()'::regprocedure);
  begin_at:=position(E'BEGIN\n' IN definition);
  IF begin_at=0 THEN RAISE EXCEPTION 'unable to extend promotion privacy audit admission'; END IF;
  revised:=substr(definition,1,begin_at+length(E'BEGIN\n')-1)
    || E'  IF NEW.metadata->>''operation''=''principal_promotion_privacy_repaired'' THEN RETURN NEW; END IF;\n'
    || substr(definition,begin_at+length(E'BEGIN\n'));
  EXECUTE revised;
  FOREACH signature IN ARRAY ARRAY[
    'continuum_redact_offboarding_audit(uuid,uuid,bigint[])',
    'continuum_protect_offboarded_audit_tombstone()',
    'continuum_apply_audit_retention_internal_v44(uuid,timestamp with time zone,integer,uuid,integer,jsonb,text,text)'
  ] LOOP
    definition:=pg_catalog.pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'''principal_offboarding_access_revoked''',
      '''principal_offboarding_access_revoked'', ''principal_promotion_privacy_repaired''');
    IF revised=definition THEN RAISE EXCEPTION 'unable to protect promotion privacy audit evidence in %',signature; END IF;
    EXECUTE revised;
  END LOOP;
  EXECUTE format('ALTER FUNCTION %I.continuum_guard_promotion_privacy_audit() SET search_path=pg_catalog,%I,pg_temp',schema_name,schema_name);
END;
$privacy_audit$;
