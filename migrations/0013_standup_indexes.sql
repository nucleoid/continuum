-- continuum:no-transaction
-- Remove prerelease metadata indexes. Trusted standup SQL no longer reads
-- caller-controlled memory metadata.
DROP INDEX CONCURRENTLY IF EXISTS memories_standup_actor_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS memories_standup_thread_idx;
DROP INDEX CONCURRENTLY IF EXISTS memories_standup_closures_gin;
DROP INDEX CONCURRENTLY IF EXISTS memories_standup_open_threads_idx;
