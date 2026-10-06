-- Cleanup is intentionally separate from 0022. In particular, it never runs
-- while that migration holds ACCESS EXCLUSIVE on principals.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DELETE FROM memory_embeddings e USING memories m
 WHERE e.memory_id = m.id AND m.state = 'archived';
