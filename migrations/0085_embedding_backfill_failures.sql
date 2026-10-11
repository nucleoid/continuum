SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TEMP TABLE continuum_embedding_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $profiles$
DECLARE candidate RECORD;
BEGIN
  FOR candidate IN SELECT profile.database_role_oid,role.rolname,profile.profile_kind
    FROM continuum_pgvector_role_profiles profile JOIN pg_catalog.pg_roles role ON role.oid=profile.database_role_oid
    WHERE profile.profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_embedding_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN CONTINUE;
    END;
  END LOOP;
END;
$profiles$;
CREATE TABLE IF NOT EXISTS embedding_backfill_failures (
  memory_id  UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  dim        INT NOT NULL CHECK (dim > 0),
  disposition TEXT NOT NULL DEFAULT 'durable'
    CHECK (disposition IN ('durable', 'suspect')),
  reason      TEXT NOT NULL DEFAULT 'EMBEDDING_ITEM_FAILED',
  failed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, provider, dim)
);

REVOKE ALL ON embedding_backfill_failures,embedding_backfill_checkpoints FROM PUBLIC;
DO $extend$
DECLARE definition TEXT; revised TEXT; candidate RECORD; schema_name TEXT:=current_schema();
BEGIN
  SELECT pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure) INTO definition;
  revised:=replace(definition,'(''tag_vocabularies'',''DELETE'')',
    '(''tag_vocabularies'',''DELETE''),(''embedding_backfill_checkpoints'',''SELECT''),(''embedding_backfill_checkpoints'',''INSERT''),(''embedding_backfill_checkpoints'',''UPDATE''),(''embedding_backfill_checkpoints'',''DELETE''),(''embedding_backfill_failures'',''SELECT''),(''embedding_backfill_failures'',''INSERT''),(''embedding_backfill_failures'',''UPDATE''),(''embedding_backfill_failures'',''DELETE'')');
  IF revised=definition THEN RAISE EXCEPTION 'embedding profile extension requires the installed tag allowlist'; END IF;
  EXECUTE revised;
  FOR candidate IN SELECT * FROM continuum_embedding_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I.embedding_backfill_checkpoints,%I.embedding_backfill_failures TO %I',schema_name,schema_name,candidate.role_name);
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END;
$extend$;
