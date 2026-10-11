-- continuum:no-transaction
-- Forward repair of INVALID scan artifacts; preserve a valid matching index.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
DO $shape$
DECLARE expected SMALLINT[]; candidate RECORD;
BEGIN
  SELECT ARRAY(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid='memory_embeddings'::regclass
    AND attname=ANY(ARRAY['provider','dim','memory_id']) ORDER BY array_position(ARRAY['provider','dim','memory_id'],attname::text)) INTO expected;
  SELECT index.*,access.amname INTO candidate FROM pg_catalog.pg_index index
    JOIN pg_catalog.pg_class relation ON relation.oid=index.indexrelid
    JOIN pg_catalog.pg_am access ON access.oid=relation.relam
    WHERE index.indexrelid=to_regclass('memory_embeddings_provider_dim_memory_idx');
  IF FOUND AND (candidate.indrelid<>'memory_embeddings'::regclass OR candidate.indisunique
      OR candidate.amname<>'btree' OR candidate.indnatts<>3 OR candidate.indnkeyatts<>3
      OR candidate.indpred IS NOT NULL OR candidate.indexprs IS NOT NULL
      OR ARRAY(SELECT pg_catalog.pg_get_indexdef(candidate.indexrelid,n,TRUE) FROM pg_catalog.generate_series(1,3) n) IS DISTINCT FROM ARRAY['provider','dim','memory_id']
      OR ARRAY(SELECT value FROM unnest(candidate.indkey::smallint[]) attribute(value)) IS DISTINCT FROM expected) THEN
    RAISE EXCEPTION 'existing provider scan index has an unexpected definition';
  END IF;
END;
$shape$;
-- continuum:repair-invalid-index memory_embeddings_provider_dim_memory_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_embeddings_provider_dim_memory_idx ON memory_embeddings(provider,dim,memory_id);
-- continuum:require-valid-index memory_embeddings_provider_dim_memory_idx;
RESET lock_timeout;
RESET statement_timeout;
