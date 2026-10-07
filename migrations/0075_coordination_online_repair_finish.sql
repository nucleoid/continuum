-- continuum:no-transaction
-- continuum:repair-invalid-index coordination_privacy_repair_eligible_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS coordination_privacy_repair_eligible_idx
  ON coordination_principal_privacy_progress(principal_id)
  WHERE repair_eligible IS TRUE
    AND (privacy_version < 3 OR completed_at IS NULL);
-- continuum:require-valid-index coordination_privacy_repair_eligible_idx;
SELECT 1;
-- continuum:backfill-coordination-v4;
SELECT 1;
