-- Upgrade compatibility for installations that applied the rejected round-seven
-- selector migration before its online backfill protocol was introduced.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS audit_log_offboarding_backfill_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  fence_id BIGINT NOT NULL,
  cursor_id BIGINT NOT NULL DEFAULT 0,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- If 0033 pre-dates this table, its one-transaction copy completed before its
-- ledger entry, and its insert trigger has maintained every later row. That
-- exact legacy state can therefore start at a truthful completed watermark.
INSERT INTO audit_log_offboarding_backfill_state
  (singleton, fence_id, cursor_id, completed)
SELECT TRUE, COALESCE(max(id), 0), COALESCE(max(id), 0), TRUE FROM audit_log
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION continuum_backfill_audit_offboarding_scopes(batch_size INTEGER)
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

ALTER TABLE principal_offboarding_runs DISABLE TRIGGER guard_offboarding_run_progress;
ALTER TABLE principal_offboarding_runs DISABLE TRIGGER guard_offboarding_phase_progress;
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
ALTER TABLE principal_offboarding_runs ENABLE TRIGGER guard_offboarding_phase_progress;

DO $migration$
DECLARE schema_name TEXT := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.continuum_backfill_audit_offboarding_scopes(INTEGER) SET search_path = pg_catalog, %I, pg_temp',
    schema_name, schema_name
  );
END;
$migration$;
