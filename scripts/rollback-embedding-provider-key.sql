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

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE memory_embeddings DROP CONSTRAINT IF EXISTS memory_embeddings_pkey;
ALTER TABLE memory_embeddings
  ADD CONSTRAINT memory_embeddings_pkey PRIMARY KEY
  USING INDEX memory_embeddings_memory_id_rollback_idx;
DELETE FROM _continuum_migrations
 WHERE name IN (
   '0010_provider_embeddings_backfill.sql',
   '0013_embedding_provider_scan_index.sql',
   '0014_embedding_provider_scan_index_rebuild.sql'
 );
COMMIT;
