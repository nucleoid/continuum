-- continuum:no-transaction
-- Retry-safe online indexes for final coordination privacy and cleanup.
-- continuum:repair-invalid-index audit_log_coordination_privacy_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_coordination_privacy_idx
  ON audit_log (principal_id, id)
  WHERE metadata ?| ARRAY[
    'lease_id', 'request_id', 'run_id', 'resource', 'resource_sha256'
  ];
-- continuum:require-valid-index audit_log_coordination_privacy_idx;

-- continuum:repair-invalid-index coordination_receipts_acquire_expiry_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS coordination_receipts_acquire_expiry_idx
  ON coordination_operation_receipts
    (principal_id, retain_until, request_id)
  WHERE operation = 'acquire';
-- continuum:require-valid-index coordination_receipts_acquire_expiry_idx;
