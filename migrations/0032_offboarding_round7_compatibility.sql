-- Keep ordinary account enable/disable workflows compatible while preserving
-- the stronger fence around offboarded principals and incomplete runs.
CREATE OR REPLACE FUNCTION continuum_guard_principal_reactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  has_capability BOOLEAN;
  has_incomplete_run BOOLEAN;
  clears_offboarded BOOLEAN;
  clears_disabled BOOLEAN;
BEGIN
  clears_offboarded := OLD.offboarded_at IS NOT NULL AND NEW.offboarded_at IS NULL;
  clears_disabled := OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL;

  IF clears_offboarded OR clears_disabled THEN
    SELECT EXISTS (
      SELECT 1 FROM principal_offboarding_runs run
       WHERE run.principal_id = OLD.id
         AND NOT EXISTS (
           SELECT 1 FROM principal_offboarding_run_events event
            WHERE event.run_id = run.run_id AND event.phase = 'completed'
         )
    ) INTO has_incomplete_run;

    IF clears_offboarded
       OR (clears_disabled AND (OLD.offboarded_at IS NOT NULL OR has_incomplete_run)) THEN
      SELECT EXISTS (
        SELECT 1 FROM continuum_principal_reactivation_requests request
         WHERE request.principal_id = OLD.id
           AND request.backend_pid = pg_backend_pid()
           AND request.transaction_id = txid_current()
      ) INTO has_capability;

      IF NOT has_capability OR NEW.offboarded_at IS NOT NULL
         OR NEW.disabled_at IS NOT NULL OR NEW.reactivated_at IS NULL THEN
        RAISE EXCEPTION 'offboarded principal reactivation requires the guarded database function';
      END IF;
      IF has_incomplete_run THEN
        RAISE EXCEPTION 'principal offboarding is incomplete';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
