-- continuum:no-transaction
-- Forward repair for databases that recorded the original 0010 before this index was added.
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_embeddings_provider_dim_memory_idx
  ON memory_embeddings (provider, dim, memory_id);
