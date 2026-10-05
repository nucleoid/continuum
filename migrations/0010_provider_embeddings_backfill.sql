ALTER TABLE memory_embeddings DROP CONSTRAINT memory_embeddings_pkey;
ALTER TABLE memory_embeddings
  ADD PRIMARY KEY (memory_id, provider, dim);

CREATE TABLE embedding_backfill_checkpoints (
  provider      TEXT NOT NULL,
  dim           INT NOT NULL,
  scope_filter  TEXT NOT NULL DEFAULT '',
  cursor        UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, dim, scope_filter)
);
