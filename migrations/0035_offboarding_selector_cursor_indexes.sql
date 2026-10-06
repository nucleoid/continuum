-- continuum:no-transaction
-- Give each bounded offboarding selector its own ordered, selective cursor path.
-- The reverse audit_id index remains necessary for audit-row cascade deletes,
-- but must not become the cheapest-looking path for a scoped cursor walk.
-- continuum:repair-invalid-index audit_log_offboarding_memory_cursor_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_offboarding_memory_cursor_idx
  ON audit_log_offboarding_scopes (scope_id, audit_id)
  WHERE selector_kind = 'memory';
-- continuum:require-valid-index audit_log_offboarding_memory_cursor_idx;

-- continuum:repair-invalid-index audit_log_offboarding_scope_ids_cursor_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_offboarding_scope_ids_cursor_idx
  ON audit_log_offboarding_scopes (scope_id, audit_id)
  WHERE selector_kind = 'scope_ids';
-- continuum:require-valid-index audit_log_offboarding_scope_ids_cursor_idx;
-- continuum:backfill-offboarding-selectors;
