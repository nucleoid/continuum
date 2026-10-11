-- continuum:no-transaction
SET lock_timeout = '5s';
SET statement_timeout = '60s';
DO $shape$ DECLARE expected SMALLINT[]; candidate RECORD; BEGIN   SELECT ARRAY(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid='memory_embeddings'::regclass     AND attname=ANY(ARRAY['memory_id','provider','dim']) ORDER BY array_position(ARRAY['memory_id','provider','dim'],attname::text)) INTO expected;   SELECT index.*,access.amname INTO candidate FROM pg_catalog.pg_index index     JOIN pg_catalog.pg_class relation ON relation.oid=index.indexrelid     JOIN pg_catalog.pg_am access ON access.oid=relation.relam     WHERE index.indexrelid=to_regclass('memory_embeddings_provider_dim_unique_idx');   IF FOUND AND (candidate.indrelid<>'memory_embeddings'::regclass OR NOT candidate.indisunique       OR candidate.amname<>'btree' OR candidate.indnatts<>3 OR candidate.indnkeyatts<>3       OR candidate.indpred IS NOT NULL OR candidate.indexprs IS NOT NULL       OR ARRAY(SELECT pg_catalog.pg_get_indexdef(candidate.indexrelid,n,TRUE) FROM pg_catalog.generate_series(1,3) n) IS DISTINCT FROM ARRAY['memory_id','provider','dim']       OR ARRAY(SELECT value FROM unnest(candidate.indkey::smallint[]) attribute(value)) IS DISTINCT FROM expected) THEN     RAISE EXCEPTION 'existing provider key index has an unexpected definition';   END IF; END; $shape$;
-- continuum:repair-invalid-index memory_embeddings_provider_dim_unique_idx;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS memory_embeddings_provider_dim_unique_idx
  ON memory_embeddings (memory_id, provider, dim);
-- continuum:require-valid-index memory_embeddings_provider_dim_unique_idx;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $attach$ DECLARE expected SMALLINT[]; old_key SMALLINT[]; key_index OID; key_name NAME; valid BOOLEAN; BEGIN   SELECT ARRAY(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid='memory_embeddings'::regclass     AND attname=ANY(ARRAY['memory_id','provider','dim']) ORDER BY array_position(ARRAY['memory_id','provider','dim'],attname::text)) INTO expected;   SELECT conkey,conindid,conname INTO old_key,key_index,key_name FROM pg_catalog.pg_constraint     WHERE conrelid='memory_embeddings'::regclass AND contype='p';   IF old_key IS NOT NULL AND key_name<>'memory_embeddings_pkey' THEN     RAISE EXCEPTION 'existing embedding primary key has an unexpected name';   END IF;   IF old_key=expected THEN     SELECT indisvalid INTO valid FROM pg_catalog.pg_index WHERE indexrelid=key_index;     IF valid IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'existing provider-qualified primary key is invalid'; END IF;     RETURN;   END IF;   IF old_key IS NOT NULL AND old_key<>expected[1:1] THEN     RAISE EXCEPTION 'existing embedding primary key has an unexpected definition';   END IF;   ALTER TABLE memory_embeddings DROP CONSTRAINT IF EXISTS memory_embeddings_pkey;   ALTER TABLE memory_embeddings ADD CONSTRAINT memory_embeddings_pkey PRIMARY KEY     USING INDEX memory_embeddings_provider_dim_unique_idx; END; $attach$;
COMMIT;
-- continuum:require-valid-index memory_embeddings_pkey;
CREATE TABLE IF NOT EXISTS embedding_backfill_checkpoints (
  provider TEXT NOT NULL, dim INT NOT NULL, scope_filter TEXT NOT NULL DEFAULT '',
  cursor UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(provider,dim,scope_filter)
);
REVOKE ALL ON embedding_backfill_checkpoints FROM PUBLIC;
RESET lock_timeout;
RESET statement_timeout;
