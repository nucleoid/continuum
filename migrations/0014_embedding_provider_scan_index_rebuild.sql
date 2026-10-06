-- continuum:no-transaction
-- A failed concurrent build can leave a same-named INVALID index. IF NOT EXISTS
-- would skip that index and let the migrator record a false success.
DROP INDEX CONCURRENTLY IF EXISTS memory_embeddings_provider_dim_memory_idx;
CREATE INDEX CONCURRENTLY memory_embeddings_provider_dim_memory_idx
  ON memory_embeddings (provider, dim, memory_id);
