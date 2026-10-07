-- continuum:no-transaction
-- Retry-safe online index construction. The migrator serializes this file and
-- records it only after all statements complete.
-- continuum:repair-invalid-index audit_log_scope_ids_gin_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_scope_ids_gin_idx
  ON audit_log USING gin ((metadata->'scope_ids')) WHERE metadata ? 'scope_ids';
-- continuum:require-valid-index audit_log_scope_ids_gin_idx;
-- Exact keyset cursor shapes used by offboarding. Distinct names make an
-- interrupted upgrade retry-safe even when an older single-column index exists.
-- continuum:repair-invalid-index audit_log_principal_cursor_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_principal_cursor_idx
  ON audit_log (principal_id, id) WHERE principal_id IS NOT NULL;
-- continuum:require-valid-index audit_log_principal_cursor_idx;
-- continuum:repair-invalid-index audit_log_scope_cursor_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_scope_cursor_idx
  ON audit_log (scope_id, id) WHERE scope_id IS NOT NULL;
-- continuum:require-valid-index audit_log_scope_cursor_idx;
-- continuum:repair-invalid-index audit_log_memory_cursor_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_memory_cursor_idx
  ON audit_log (memory_id, id) WHERE memory_id IS NOT NULL;
-- continuum:require-valid-index audit_log_memory_cursor_idx;
-- continuum:repair-invalid-index audit_log_request_cursor_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_request_cursor_idx
  ON audit_log ((metadata->>'request_id'), id) WHERE metadata ? 'request_id';
-- continuum:require-valid-index audit_log_request_cursor_idx;
