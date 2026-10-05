-- continuum:no-transaction
-- A failed concurrent build can leave an invalid index. Drop that retry
-- artifact before rebuilding; the migrator serializes this file globally.
DROP INDEX CONCURRENTLY IF EXISTS memories_supersedes_unique_idx;
CREATE UNIQUE INDEX CONCURRENTLY memories_supersedes_unique_idx
  ON memories (supersedes_id) WHERE supersedes_id IS NOT NULL;
