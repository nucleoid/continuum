CREATE TABLE IF NOT EXISTS embedding_backfill_failures (
  memory_id  UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  dim        INT NOT NULL CHECK (dim > 0),
  disposition TEXT NOT NULL DEFAULT 'durable'
    CHECK (disposition IN ('durable', 'suspect')),
  reason      TEXT NOT NULL DEFAULT 'EMBEDDING_ITEM_FAILED',
  failed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, provider, dim)
);
