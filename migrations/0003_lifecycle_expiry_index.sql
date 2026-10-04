-- continuum:no-transaction
-- Dropping first lets a retry recover an INVALID index left by a failed build.
DROP INDEX CONCURRENTLY IF EXISTS memories_lifecycle_expiry_idx;
CREATE INDEX CONCURRENTLY memories_lifecycle_expiry_idx
  ON memories (expires_at, id)
  WHERE state = 'live'
    AND type IN ('context', 'fact', 'relationship')
    AND expires_at IS NOT NULL;
