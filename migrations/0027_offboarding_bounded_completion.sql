-- Durable audit fences, exact processed counts, and non-spoofable reactivation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE principal_offboarding_runs
  ADD COLUMN audit_fence_id BIGINT,
  ADD COLUMN initial_count_truncated TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN embeddings_processed INTEGER NOT NULL DEFAULT 0
    CHECK (embeddings_processed >= 0),
  ADD COLUMN memberships_processed INTEGER NOT NULL DEFAULT 0
    CHECK (memberships_processed >= 0),
  ADD COLUMN aliases_processed INTEGER NOT NULL DEFAULT 0
    CHECK (aliases_processed >= 0),
  ADD COLUMN entra_bindings_processed INTEGER NOT NULL DEFAULT 0
    CHECK (entra_bindings_processed >= 0),
  ADD COLUMN audit_queries_processed INTEGER NOT NULL DEFAULT 0
    CHECK (audit_queries_processed >= 0);

-- A request row exists only while the SECURITY DEFINER entry point performs
-- the guarded update. Ordinary UPDATE cannot manufacture this backend-local,
-- transaction-local capability with a custom GUC.
CREATE TABLE continuum_principal_reactivation_requests (
  principal_id UUID PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  backend_pid INTEGER NOT NULL,
  transaction_id BIGINT NOT NULL
);

REVOKE ALL ON TABLE continuum_principal_reactivation_requests FROM PUBLIC;

CREATE OR REPLACE FUNCTION continuum_guard_principal_reactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL AND OLD.offboarded_at IS NOT NULL THEN
    IF NEW.offboarded_at IS NOT NULL OR NEW.reactivated_at IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM continuum_principal_reactivation_requests request
          WHERE request.principal_id = OLD.id
            AND request.backend_pid = pg_backend_pid()
            AND request.transaction_id = txid_current()
       ) THEN
      RAISE EXCEPTION 'offboarded principal reactivation requires the guarded database function';
    END IF;
    IF EXISTS (
      SELECT 1 FROM principal_offboarding_runs
       WHERE principal_id = OLD.id AND completed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'principal offboarding is incomplete';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION continuum_reactivate_principal(target_principal_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  was_offboarded BOOLEAN;
BEGIN
  SELECT offboarded_at IS NOT NULL INTO was_offboarded
    FROM principals
   WHERE id = target_principal_id AND disabled_at IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM principal_offboarding_runs
     WHERE principal_id = target_principal_id AND completed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'principal offboarding is incomplete';
  END IF;

  INSERT INTO continuum_principal_reactivation_requests
    (principal_id, backend_pid, transaction_id)
  VALUES (target_principal_id, pg_backend_pid(), txid_current());
  UPDATE principals
     SET disabled_at = NULL, offboarded_at = NULL, reactivated_at = now()
   WHERE id = target_principal_id;
  DELETE FROM continuum_principal_reactivation_requests
   WHERE principal_id = target_principal_id;
  RETURN was_offboarded;
END;
$$;
