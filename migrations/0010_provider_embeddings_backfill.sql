-- continuum:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS memory_embeddings_provider_dim_unique_idx;
CREATE UNIQUE INDEX CONCURRENTLY memory_embeddings_provider_dim_unique_idx
  ON memory_embeddings (memory_id, provider, dim);
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE memory_embeddings DROP CONSTRAINT IF EXISTS memory_embeddings_pkey;
ALTER TABLE memory_embeddings
  ADD CONSTRAINT memory_embeddings_pkey PRIMARY KEY
  USING INDEX memory_embeddings_provider_dim_unique_idx;
COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_embeddings_provider_dim_memory_idx
  ON memory_embeddings (provider, dim, memory_id);

CREATE TABLE IF NOT EXISTS embedding_backfill_checkpoints (
  provider      TEXT NOT NULL,
  dim           INT NOT NULL,
  scope_filter  TEXT NOT NULL DEFAULT '',
  cursor        UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, dim, scope_filter)
);
