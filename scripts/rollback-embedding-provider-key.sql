-- continuum:no-transaction
WITH ranked AS (
  SELECT ctid,
         row_number() OVER (
           PARTITION BY memory_id
           ORDER BY embedded_at DESC, provider, dim
         ) AS position
    FROM memory_embeddings
)
DELETE FROM memory_embeddings e
 USING ranked r
 WHERE e.ctid = r.ctid
   AND r.position > 1;

DROP INDEX CONCURRENTLY IF EXISTS memory_embeddings_memory_id_rollback_idx;
CREATE UNIQUE INDEX CONCURRENTLY memory_embeddings_memory_id_rollback_idx
  ON memory_embeddings (memory_id);
ALTER TABLE memory_embeddings DROP CONSTRAINT IF EXISTS memory_embeddings_pkey;
ALTER TABLE memory_embeddings
  ADD CONSTRAINT memory_embeddings_pkey PRIMARY KEY
  USING INDEX memory_embeddings_memory_id_rollback_idx;
