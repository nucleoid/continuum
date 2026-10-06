-- continuum:no-transaction
-- Subject-memory keyset traversal; built online for existing installations.
-- continuum:repair-invalid-index memories_scope_id_cursor_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_scope_id_cursor_idx
  ON memories (scope_id, id);
-- continuum:require-valid-index memories_scope_id_cursor_idx;
-- continuum:no-transaction
-- Subject-memory keyset traversal; built online for existing installations.
-- continuum:repair-invalid-index memories_scope_id_cursor_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_scope_id_cursor_idx
  ON memories (scope_id, id);
-- continuum:require-valid-index memories_scope_id_cursor_idx;
