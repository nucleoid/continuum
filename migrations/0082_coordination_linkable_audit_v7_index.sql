-- continuum:no-transaction
-- Match the seven-field privacy predicate installed by 0081. The published
-- 0070 index remains intact for its original five-field query contract.
-- continuum:repair-invalid-index audit_log_coordination_privacy_linkable_v7_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_coordination_privacy_linkable_v7_idx
  ON audit_log (principal_id, id)
  WHERE metadata->>'operation' IN (
    'lock_acquire', 'lock_renew', 'lock_release', 'lock_inspect'
  ) AND metadata ?| ARRAY[
    'request_id','run_id','lease_id','resource','resource_sha256','fencing_token','resource_bytes'
  ];
-- continuum:require-valid-index audit_log_coordination_privacy_linkable_v7_idx;
