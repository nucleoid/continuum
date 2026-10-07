-- Bounded offboarding selectors, durable phase state, and hardened ledger capabilities.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE principal_offboarding_runs
  ADD COLUMN memory_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN scope_cleanup_complete BOOLEAN NOT NULL DEFAULT FALSE;

-- Every pre-existing run has already executed the one-time scope cleanup. A
-- completed run has also traversed its immutable owned-scope memory set.
UPDATE principal_offboarding_runs SET scope_cleanup_complete = TRUE;
UPDATE principal_offboarding_runs run SET memory_complete = TRUE
 WHERE EXISTS (
   SELECT 1 FROM principal_offboarding_run_events event
    WHERE event.run_id = run.run_id AND event.phase = 'completed'
 );

-- Persist the two selector relationships that cannot be served by an ordered
-- audit_log index. New audit rows maintain this relation synchronously; the
-- upgrade backfill makes historical traversal use the same keyset path. The
-- relation starts empty so this schema/trigger transaction never copies audit
-- history or blocks ordinary audit inserts for the duration of that copy.
CREATE TABLE audit_log_offboarding_scopes (
  selector_kind TEXT NOT NULL CHECK (selector_kind IN ('memory', 'scope_ids')),
  scope_id UUID NOT NULL,
  audit_id BIGINT NOT NULL REFERENCES audit_log(id) ON DELETE CASCADE,
  PRIMARY KEY (selector_kind, scope_id, audit_id)
);

CREATE INDEX audit_log_offboarding_scopes_audit_idx
  ON audit_log_offboarding_scopes (audit_id);

CREATE FUNCTION continuum_capture_audit_offboarding_scopes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.memory_id IS NOT NULL THEN
    INSERT INTO audit_log_offboarding_scopes (selector_kind, scope_id, audit_id)
    SELECT 'memory', memory.scope_id, NEW.id
      FROM memories memory WHERE memory.id = NEW.memory_id
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO audit_log_offboarding_scopes (selector_kind, scope_id, audit_id)
  SELECT 'scope_ids', carried.value::uuid, NEW.id
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(NEW.metadata->'scope_ids') = 'array'
           THEN NEW.metadata->'scope_ids' ELSE '[]'::jsonb END
    ) carried(value)
   WHERE carried.value ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capture_audit_offboarding_scopes
AFTER INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION continuum_capture_audit_offboarding_scopes();

CREATE TABLE audit_log_offboarding_backfill_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  fence_id BIGINT NOT NULL,
  cursor_id BIGINT NOT NULL DEFAULT 0,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO audit_log_offboarding_backfill_state (fence_id, completed)
SELECT COALESCE(max(id), 0), COALESCE(max(id), 0) = 0 FROM audit_log;

-- One call processes at most batch_size ordered audit rows and commits through
-- the migrator before the next call. The insert trigger captures concurrent
-- rows above fence_id, while this function fills the immutable historical gap.
CREATE FUNCTION continuum_backfill_audit_offboarding_scopes(batch_size INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '30s'
AS $$
DECLARE
  state audit_log_offboarding_backfill_state%ROWTYPE;
  last_id BIGINT;
  examined INTEGER;
BEGIN
  IF batch_size < 1 OR batch_size > 5000 THEN
    RAISE EXCEPTION 'selector backfill batch size must be between 1 and 5000';
  END IF;

  SELECT * INTO state FROM audit_log_offboarding_backfill_state
   WHERE singleton = TRUE FOR UPDATE;
  IF state.completed THEN RETURN TRUE; END IF;

  CREATE TEMP TABLE IF NOT EXISTS continuum_selector_backfill_batch (
    id BIGINT PRIMARY KEY, memory_id UUID, metadata JSONB
  ) ON COMMIT DROP;
  TRUNCATE continuum_selector_backfill_batch;
  INSERT INTO continuum_selector_backfill_batch (id, memory_id, metadata)
  SELECT id, memory_id, metadata FROM audit_log
   WHERE id > state.cursor_id AND id <= state.fence_id
   ORDER BY id LIMIT batch_size;
  GET DIAGNOSTICS examined = ROW_COUNT;

  INSERT INTO audit_log_offboarding_scopes (selector_kind, scope_id, audit_id)
  SELECT 'memory', memory.scope_id, audit.id
    FROM continuum_selector_backfill_batch audit
    JOIN memories memory ON memory.id = audit.memory_id
  ON CONFLICT DO NOTHING;

  INSERT INTO audit_log_offboarding_scopes (selector_kind, scope_id, audit_id)
  SELECT 'scope_ids', carried.value::uuid, audit.id
    FROM continuum_selector_backfill_batch audit
   CROSS JOIN LATERAL jsonb_array_elements_text(
     CASE WHEN jsonb_typeof(audit.metadata->'scope_ids') = 'array'
          THEN audit.metadata->'scope_ids' ELSE '[]'::jsonb END
   ) carried(value)
   WHERE carried.value ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  ON CONFLICT DO NOTHING;

  SELECT max(id) INTO last_id FROM continuum_selector_backfill_batch;
  UPDATE audit_log_offboarding_backfill_state
     SET cursor_id = COALESCE(last_id, fence_id),
         completed = examined < batch_size OR COALESCE(last_id, fence_id) >= fence_id,
         updated_at = now()
   WHERE singleton = TRUE;
  RETURN (SELECT completed FROM audit_log_offboarding_backfill_state
           WHERE singleton = TRUE);
END;
$$;
REVOKE ALL ON FUNCTION continuum_backfill_audit_offboarding_scopes(INTEGER) FROM PUBLIC;

-- A completed event is accepted only while the SECURITY DEFINER completion
-- function holds a backend-local, transaction-local capability.
CREATE TABLE continuum_offboarding_completion_requests (
  run_id UUID PRIMARY KEY,
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL
);
REVOKE ALL ON TABLE continuum_offboarding_completion_requests FROM PUBLIC;

CREATE FUNCTION continuum_require_offboarding_completion_capability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.phase = 'completed' AND NOT EXISTS (
    SELECT 1 FROM continuum_offboarding_completion_requests request
     WHERE request.run_id = NEW.run_id
       AND request.backend_pid = pg_backend_pid()
       AND request.transaction_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'offboarding completed event requires the guarded completion capability';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER require_offboarding_completion_capability
BEFORE INSERT ON principal_offboarding_run_events
FOR EACH ROW EXECUTE FUNCTION continuum_require_offboarding_completion_capability();

-- The rejected round-seven build could persist normalized-selector cursors
-- before the historical relation was complete. Rewind every idempotent
-- normalized/linked cursor on incomplete runs; immutable completed runs remain
-- evidence of the earlier fully traversed algorithm.
ALTER TABLE principal_offboarding_runs DISABLE TRIGGER guard_offboarding_run_progress;
UPDATE principal_offboarding_runs
   SET audit_memory_key_cursor = NULL,
       audit_memory_item_cursor = 0,
       audit_memory_complete = FALSE,
       audit_memory_cursor = 0,
       audit_scope_ids_cursor = 0,
       audit_linked_request_cursor = NULL,
       audit_linked_request_item_cursor = 0,
       audit_linked_request_exhausted = FALSE,
       audit_linked_complete = FALSE,
       audit_linked_cursor = 0
 WHERE NOT EXISTS (
   SELECT 1 FROM principal_offboarding_run_events event
    WHERE event.run_id = principal_offboarding_runs.run_id
      AND event.phase = 'completed'
 );
ALTER TABLE principal_offboarding_runs ENABLE TRIGGER guard_offboarding_run_progress;

CREATE FUNCTION continuum_protect_principal_user_scope_identity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'principal user-scope owner mapping cannot be deleted';
  END IF;
  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id THEN
    RAISE EXCEPTION 'principal user-scope owner mapping identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_principal_user_scope_identity
BEFORE UPDATE OR DELETE ON principal_user_scopes
FOR EACH ROW EXECUTE FUNCTION continuum_protect_principal_user_scope_identity();

-- Embedding insertion only needs to prevent a concurrent memory update. KEY
-- SHARE preserves that ordering while avoiding an unnecessarily exclusive lock.
CREATE OR REPLACE FUNCTION continuum_require_embeddable_memory() RETURNS trigger AS $$
DECLARE
  memory_state TEXT;
BEGIN
  SELECT state INTO memory_state FROM memories WHERE id = NEW.memory_id
   FOR KEY SHARE;
  IF NOT FOUND OR memory_state <> 'live' THEN
    RAISE EXCEPTION 'embedding requires a live memory';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Put the owning schema explicitly before pg_temp for every SECURITY DEFINER
-- function involved in lifecycle capability checks.
DO $migration$
DECLARE schema_name TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_capture_audit_offboarding_scopes() SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_backfill_audit_offboarding_scopes(INTEGER) SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_require_offboarding_completion_capability() SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_guard_principal_reactivation() SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_reactivate_principal(UUID, UUID) SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
END;
$migration$;
