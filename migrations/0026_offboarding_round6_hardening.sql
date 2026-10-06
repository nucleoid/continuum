-- Append-only authorization/completion evidence and database reactivation guard.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE principal_offboarding_runs
  ADD COLUMN run_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN approval_evidence_hash TEXT NOT NULL DEFAULT repeat('0', 64)
    CHECK (approval_evidence_hash ~ '^[0-9a-f]{64}$');

UPDATE principal_offboarding_runs run
   SET approval_evidence_hash = approval.acknowledged_evidence_hash
  FROM principal_user_scope_approvals approval
 WHERE approval.id = run.approval_id;

CREATE UNIQUE INDEX principal_offboarding_runs_run_id_idx
  ON principal_offboarding_runs (run_id);

CREATE TABLE principal_offboarding_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL,
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (phase IN ('started', 'completed')),
  initiated_by UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  finalized_by UUID REFERENCES principals(id) ON DELETE RESTRICT,
  approval_id BIGINT NOT NULL REFERENCES principal_user_scope_approvals(id) ON DELETE RESTRICT,
  approval_evidence_hash TEXT NOT NULL CHECK (approval_evidence_hash ~ '^[0-9a-f]{64}$'),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence JSONB NOT NULL,
  UNIQUE (run_id, phase),
  CHECK ((phase = 'started' AND finalized_by IS NULL)
      OR (phase = 'completed' AND finalized_by IS NOT NULL))
);

CREATE INDEX principal_offboarding_run_events_principal_idx
  ON principal_offboarding_run_events (principal_id, id);

CREATE FUNCTION continuum_preserve_offboarding_run_event() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'offboarding run event evidence is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER preserve_offboarding_run_event
BEFORE UPDATE OR DELETE ON principal_offboarding_run_events
FOR EACH ROW EXECUTE FUNCTION continuum_preserve_offboarding_run_event();
-- offboarding run event evidence is immutable at this trigger boundary.

CREATE TRIGGER preserve_offboarding_run_event_truncate
BEFORE TRUNCATE ON principal_offboarding_run_events
FOR EACH STATEMENT EXECUTE FUNCTION continuum_preserve_offboarding_run_event();

-- Reactivation guard: disabled_at cannot be cleared on an offboarded principal
-- except through continuum_reactivate_principal in the same transaction, after
-- that function has locked the row and proved there is no incomplete run.
CREATE FUNCTION continuum_guard_principal_reactivation() RETURNS trigger AS $$
BEGIN
  IF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL AND OLD.offboarded_at IS NOT NULL THEN
    IF current_setting('continuum.reactivation_principal_id', true) IS DISTINCT FROM OLD.id::text
       OR NEW.offboarded_at IS NOT NULL OR NEW.reactivated_at IS NULL THEN
      RAISE EXCEPTION 'offboarded principal reactivation requires the guarded database function';
    END IF;
    IF EXISTS (SELECT 1 FROM principal_offboarding_runs
                WHERE principal_id = OLD.id AND completed_at IS NULL) THEN
      RAISE EXCEPTION 'principal offboarding is incomplete';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER guard_principal_reactivation
BEFORE UPDATE OF disabled_at, offboarded_at, reactivated_at ON principals
FOR EACH ROW EXECUTE FUNCTION continuum_guard_principal_reactivation();

CREATE FUNCTION continuum_reactivate_principal(target_principal_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
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
  IF EXISTS (SELECT 1 FROM principal_offboarding_runs
              WHERE principal_id = target_principal_id AND completed_at IS NULL) THEN
    RAISE EXCEPTION 'principal offboarding is incomplete';
  END IF;
  PERFORM set_config('continuum.reactivation_principal_id', target_principal_id::text, true);
  UPDATE principals
     SET disabled_at = NULL, offboarded_at = NULL, reactivated_at = now()
   WHERE id = target_principal_id;
  RETURN was_offboarded;
END;
$$;
