-- continuum:no-transaction
-- continuum:repair-invalid-index coordination_leases_cleanup_pending_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS coordination_leases_cleanup_pending_idx
  ON coordination_leases (lease_id)
  WHERE cleanup_eligible_at IS NULL;
-- continuum:require-valid-index coordination_leases_cleanup_pending_idx;

-- continuum:backfill-coordination-repair;
