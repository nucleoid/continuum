-- Install a supported maintenance procedure; do not pretend a one-shot schema
-- migration completed an unbounded data cleanup. Operators call this function
-- repeatedly in committed transactions until it returns zero.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION continuum_cleanup_archived_embeddings(batch_size INTEGER DEFAULT 1000)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  removed INTEGER;
BEGIN
  IF batch_size < 1 OR batch_size > 5000 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 5000';
  END IF;
  EXECUTE 'WITH candidates AS MATERIALIZED (
    SELECT e.memory_id
      FROM memory_embeddings e
      JOIN memories m ON m.id = e.memory_id
     WHERE m.state = ''archived''
     ORDER BY e.memory_id
     LIMIT $1
     FOR UPDATE OF e SKIP LOCKED
  ) DELETE FROM memory_embeddings e USING candidates c
     WHERE e.memory_id = c.memory_id' USING batch_size;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

-- One bounded upgrade batch removes common small backlogs. A non-zero result
-- does not claim global completion; operators continue with the function.
SELECT continuum_cleanup_archived_embeddings(1000);
