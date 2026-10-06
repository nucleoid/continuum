-- Correct review deployments that may already have applied migration 0014.
-- Freshness comes only from durable successful-sync evidence, never deploy time.
UPDATE entra_sync_state
   SET last_success_at = COALESCE(
         (SELECT max(at) FROM audit_log
           WHERE metadata->>'operation' = 'entra_membership_sync'),
         TIMESTAMPTZ '1970-01-01 00:00:00+00'
       ),
       max_staleness = CASE
         WHEN max_staleness = interval '24 hours' THEN interval '48 hours'
         ELSE max_staleness
       END;

ALTER TABLE entra_sync_state
  ALTER COLUMN last_success_at SET DEFAULT TIMESTAMPTZ '1970-01-01 00:00:00+00',
  ALTER COLUMN max_staleness SET DEFAULT interval '48 hours';

-- INSERT ... ON CONFLICT executes BEFORE INSERT triggers before resolving the
-- conflict. Exclude the same immutable binding ID so update and recovery at the
-- 500-binding limit are not mistaken for a new 501st binding.
CREATE OR REPLACE FUNCTION continuum_limit_entra_bindings()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL AND NEW.approval_revoked_at IS NULL
     AND (TG_OP = 'INSERT'
          OR OLD.approved_by IS NULL OR OLD.approval_revoked_at IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(834641726154302119::bigint);
    IF (SELECT count(*) FROM entra_groups
         WHERE approved_by IS NOT NULL AND approval_revoked_at IS NULL
           AND external_id <> NEW.external_id) >= 500 THEN
      RAISE EXCEPTION 'cannot approve more than 500 Entra group bindings';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
