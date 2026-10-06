-- continuum:no-transaction
-- 0013 was published before trusted activity moved out of memory metadata.
-- Keep that migration immutable and retire its obsolete indexes here.
DROP INDEX CONCURRENTLY IF EXISTS memories_standup_actor_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS memories_standup_thread_idx;
DROP INDEX CONCURRENTLY IF EXISTS memories_standup_closures_gin;
DROP INDEX CONCURRENTLY IF EXISTS memories_standup_open_threads_idx;
