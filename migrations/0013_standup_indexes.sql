-- continuum:no-transaction
-- Build potentially large memory indexes online. Every statement is retry-safe
-- because no-transaction migrations can be interrupted before ledger insertion.
CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_standup_actor_created_idx
  ON memories ((metadata->>'actor_principal_id'), created_at DESC, id)
  WHERE metadata->>'_continuum_activity_provenance' = 'capture-v1'
    AND metadata ? 'actor_principal_id';
CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_standup_thread_idx
  ON memories ((metadata->>'thread_key'), created_at DESC, id)
  WHERE metadata->>'_continuum_activity_provenance' = 'capture-v1'
    AND metadata ? 'thread_key';
CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_standup_closures_gin
  ON memories USING gin ((metadata->'closes_thread_keys') jsonb_path_ops)
  WHERE metadata->>'_continuum_activity_provenance' = 'capture-v1'
    AND metadata ? 'closes_thread_keys';
CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_standup_open_threads_idx
  ON memories ((metadata->>'thread_owner_principal_id'), created_at, id)
  WHERE state = 'live' AND type = 'context'
    AND metadata->>'_continuum_activity_provenance' = 'capture-v1'
    AND metadata ? 'thread_key';
