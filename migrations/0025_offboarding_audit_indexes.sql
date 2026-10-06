-- continuum:no-transaction
-- Retry-safe online index construction. The migrator serializes this file and
-- records it only after all statements complete.
-- continuum:repair-invalid-index audit_log_scope_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_scope_idx
  ON audit_log (scope_id) WHERE scope_id IS NOT NULL;
-- continuum:require-valid-index audit_log_scope_idx;
-- continuum:repair-invalid-index audit_log_request_id_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_request_id_idx
  ON audit_log ((metadata->>'request_id')) WHERE metadata ? 'request_id';
-- continuum:require-valid-index audit_log_request_id_idx;
-- continuum:repair-invalid-index audit_log_scope_ids_gin_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_scope_ids_gin_idx
  ON audit_log USING gin ((metadata->'scope_ids')) WHERE metadata ? 'scope_ids';
-- continuum:require-valid-index audit_log_scope_ids_gin_idx;
