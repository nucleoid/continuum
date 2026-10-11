-- continuum:no-transaction
-- Retry-safe online indexes for the issue 7 forward repair.
-- continuum:repair-invalid-index coordination_leases_principal_privacy_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS coordination_leases_principal_privacy_idx
  ON coordination_leases (principal_id, lease_id);
-- continuum:require-valid-index coordination_leases_principal_privacy_idx;

-- continuum:repair-invalid-index coordination_receipts_principal_privacy_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS coordination_receipts_principal_privacy_idx
  ON coordination_operation_receipts
    (principal_id, operation, request_id);
-- continuum:require-valid-index coordination_receipts_principal_privacy_idx;
