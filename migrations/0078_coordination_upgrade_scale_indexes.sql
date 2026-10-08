-- continuum:no-transaction
-- A partial-upgrade row can remain incomplete while repair_eligible is NULL
-- or FALSE. Keep that legacy branch bounded without rewriting published
-- migrations 0054-0077.
-- continuum:repair-invalid-index coordination_privacy_repair_legacy_incomplete_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS coordination_privacy_repair_legacy_incomplete_idx
  ON coordination_principal_privacy_progress(principal_id)
  WHERE repair_eligible IS NOT TRUE
    AND (privacy_version < 3 OR completed_at IS NULL);

-- continuum:require-valid-index coordination_privacy_repair_legacy_incomplete_idx;
SELECT 1;
