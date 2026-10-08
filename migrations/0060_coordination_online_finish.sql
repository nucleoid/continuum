-- continuum:no-transaction
-- Finish the issue 7 repair with restart-safe online work.
-- continuum:repair-invalid-index coordination_leases_cleanup_ready_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS coordination_leases_cleanup_ready_idx
  ON coordination_leases (cleanup_eligible_at, lease_id)
  WHERE cleanup_eligible_at IS NOT NULL;
-- continuum:require-valid-index coordination_leases_cleanup_ready_idx;

-- continuum:repair-invalid-index coordination_leases_principal_cleanup_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS coordination_leases_principal_cleanup_idx
  ON coordination_leases (principal_id, cleanup_eligible_at, lease_id)
  WHERE cleanup_eligible_at IS NOT NULL;
-- continuum:require-valid-index coordination_leases_principal_cleanup_idx;

-- continuum:backfill-coordination-repair;

SET lock_timeout = '1s';
ALTER TABLE coordination_operation_receipts
  VALIDATE CONSTRAINT coordination_contended_receipt_retention;
RESET lock_timeout;
