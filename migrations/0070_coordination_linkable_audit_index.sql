-- continuum:no-transaction
-- A scrubbed lock row does not remain in this index. Privacy verification is
-- therefore one index probe instead of a heap visit for every retained lock.
-- continuum:repair-invalid-index audit_log_coordination_privacy_linkable_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_coordination_privacy_linkable_idx
  ON audit_log (principal_id, id)
  WHERE metadata->>'operation' IN (
    'lock_acquire', 'lock_renew', 'lock_release', 'lock_inspect'
  ) AND metadata ?| ARRAY[
    'request_id','run_id','lease_id','resource','resource_sha256'
  ];
-- continuum:require-valid-index audit_log_coordination_privacy_linkable_idx;
