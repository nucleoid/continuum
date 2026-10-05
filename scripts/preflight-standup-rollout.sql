\set ON_ERROR_STOP on

-- Read-only rollout inventory. Review every nonzero count before enabling
-- strict standup readers or running the maintenance cleanup.
SELECT count(*) AS unowned_user_scopes
  FROM scopes
 WHERE kind = 'user' AND owner_principal_id IS NULL;

SELECT count(*) AS legacy_github_login_aliases
  FROM principal_aliases
 WHERE provider = 'github' AND external_actor !~ '^[1-9][0-9]*$';

SELECT count(*) AS stable_github_numeric_aliases
  FROM principal_aliases
 WHERE provider = 'github' AND external_actor ~ '^[1-9][0-9]*$';

SELECT count(*) AS legacy_principal_scoped_github_mappings
  FROM actor_principal_mappings
 WHERE revoked_at IS NULL
   AND authority ~ '^github\.[0-9a-fA-F-]{36}$';

SELECT count(*) AS stable_github_mappings
  FROM actor_principal_mappings
 WHERE revoked_at IS NULL AND authority = 'github';

SELECT count(*) AS cleanup_candidates
  FROM memories memory
 WHERE memory.metadata ?| ARRAY[
         'actor_principal_id', 'thread_owner_principal_id', 'thread_key',
         'closes_thread_keys', '_continuum_activity_provenance',
         '_continuum_activity_epoch_ms', '_continuum_actor_mapping_id',
         '_continuum_actor_mapping_authority'
       ];

SELECT count(*) AS trusted_attributions FROM memory_activity_attributions;
SELECT count(*) AS closure_tombstones FROM standup_thread_closures;
