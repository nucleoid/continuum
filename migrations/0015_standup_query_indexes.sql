-- continuum:no-transaction
-- Concurrent builds can leave invalid same-named indexes after interruption.
-- Drop before create on every attempt, then fail before ledger insertion unless
-- PostgreSQL reports all shipped-query indexes valid.
DROP INDEX CONCURRENTLY IF EXISTS memory_activity_actor_time_idx;
CREATE INDEX CONCURRENTLY memory_activity_actor_time_idx
  ON memory_activity_attributions (actor_principal_id, activity_at, memory_id);
DROP INDEX CONCURRENTLY IF EXISTS memory_activity_open_thread_idx;
CREATE INDEX CONCURRENTLY memory_activity_open_thread_idx
  ON memory_activity_attributions
    (thread_owner_principal_id, activity_at, memory_id, thread_key);
DROP INDEX CONCURRENTLY IF EXISTS standup_thread_closures_lookup_idx;
CREATE INDEX CONCURRENTLY standup_thread_closures_lookup_idx
  ON standup_thread_closures (actor_principal_id, thread_key, closed_at);
SELECT 1 / CASE WHEN count(*) = 3 AND bool_and(index_state.indisvalid) THEN 1 ELSE 0 END
  FROM pg_index index_state
  JOIN pg_class index_name ON index_name.oid = index_state.indexrelid
 WHERE index_name.relname IN (
   'memory_activity_actor_time_idx',
   'memory_activity_open_thread_idx',
   'standup_thread_closures_lookup_idx'
 );
