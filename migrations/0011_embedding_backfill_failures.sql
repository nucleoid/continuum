-- continuum:no-transaction
CREATE TABLE IF NOT EXISTS embedding_backfill_failures (
  memory_id  UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  dim        INT NOT NULL CHECK (dim > 0),
  failed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, provider, dim)
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_embedding_backfill_failed_seed_idx
  ON audit_log (memory_id, at)
  WHERE action = 'write'
    AND metadata->>'operation' = 'embedding_backfill'
    AND metadata->>'embedded' = 'false'
    AND metadata->>'embedding_error_code' = 'EMBEDDING_FAILED';

INSERT INTO embedding_backfill_failures (memory_id, provider, dim, failed_at)
SELECT a.memory_id,
       a.metadata->>'provider',
       (a.metadata->>'dim')::INT,
       min(a.at)
  FROM audit_log a
  JOIN memories m ON m.id = a.memory_id
 WHERE a.action = 'write'
   AND a.metadata->>'operation' = 'embedding_backfill'
   AND a.metadata->>'embedded' = 'false'
   AND a.metadata->>'embedding_error_code' = 'EMBEDDING_FAILED'
   AND coalesce(a.metadata->>'provider', '') <> ''
   AND a.metadata->>'dim' ~ '^[1-9][0-9]{0,8}$'
   AND (a.metadata->>'dim')::BIGINT <= 2147483647
 GROUP BY a.memory_id, a.metadata->>'provider', (a.metadata->>'dim')::INT
ON CONFLICT DO NOTHING;

DROP INDEX CONCURRENTLY IF EXISTS audit_log_embedding_backfill_failed_seed_idx;
