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
                   CHECK (state IN ('pending', 'delivered', 'dead_letter')),
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
