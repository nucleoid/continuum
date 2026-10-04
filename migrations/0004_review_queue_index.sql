-- continuum:no-transaction
-- Dropping first lets a retry recover an INVALID index left by a failed build.
DROP INDEX CONCURRENTLY IF EXISTS memories_review_queue_idx;
CREATE INDEX CONCURRENTLY memories_review_queue_idx
  ON memories (state, type, expires_at, created_at, id)
  WHERE state IN ('live', 'stale');
