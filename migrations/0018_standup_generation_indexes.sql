-- continuum:no-transaction
-- Match the production standup predicates, including mapping generation.
DROP INDEX CONCURRENTLY IF EXISTS standup_thread_closures_lookup_idx;
CREATE INDEX CONCURRENTLY standup_thread_closures_lookup_idx
  ON standup_thread_closures
    (actor_principal_id, mapping_id, thread_key, closed_at);
SELECT 1 / CASE WHEN index_state.indisvalid THEN 1 ELSE 0 END
  FROM pg_index index_state
  JOIN pg_class index_name ON index_name.oid = index_state.indexrelid
 WHERE index_name.relname = 'standup_thread_closures_lookup_idx';
