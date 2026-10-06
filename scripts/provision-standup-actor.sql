\set ON_ERROR_STOP on

\if :{?provider}
\else
  \prompt 'Alias provider (github or terminal): ' provider
\endif
\if :{?external_actor_id}
\else
  \prompt 'Existing exact numeric ID or terminal subject: ' external_actor_id
\endif
\if :{?authority}
\else
  \prompt 'Standup activity namespace: ' authority
\endif
\if :{?admin_principal_id}
\else
  \prompt 'Reviewing org-admin principal UUID: ' admin_principal_id
\endif

BEGIN;

SELECT CASE
  WHEN :'provider' = 'github' AND :'external_actor_id' ~ '^[1-9][0-9]*$' THEN 'id'
  WHEN :'provider' = 'terminal' AND length(:'external_actor_id') BETWEEN 1 AND 500
    THEN 'subject'
  ELSE ''
END AS alias_kind
\gset

WITH reviewed AS MATERIALIZED (
  SELECT alias.principal_id
    FROM principal_aliases alias
   WHERE alias.provider = :'provider'
     AND alias.alias_kind = 'legacy'
     AND alias.external_actor = :'external_actor_id'
   FOR SHARE
), authorized AS MATERIALIZED (
  SELECT reviewed.principal_id
    FROM reviewed
    JOIN principals principal
      ON principal.id = reviewed.principal_id AND principal.kind = 'user'
   WHERE :'alias_kind' IN ('id', 'subject')
     AND EXISTS (
       SELECT 1
         FROM scope_memberships membership
         JOIN scopes scope ON scope.id = membership.scope_id
        WHERE membership.principal_id = :'admin_principal_id'::uuid
          AND membership.role = 'admin'
          AND scope.kind = 'org'
     )
), inserted_alias AS (
  INSERT INTO principal_aliases
    (provider, alias_kind, external_actor, principal_id)
  SELECT :'provider', :'alias_kind', :'external_actor_id', principal_id
    FROM authorized
  ON CONFLICT DO NOTHING
  RETURNING principal_id
), alias_audit AS (
  INSERT INTO audit_log (principal_id, action, metadata)
  SELECT :'admin_principal_id'::uuid, 'write',
         jsonb_build_object(
           'operation', 'provision_standup_principal_alias',
           'provider', :'provider',
           'alias_kind', :'alias_kind',
           'principal_id', principal_id
         )
    FROM inserted_alias
), inserted_mapping AS (
  INSERT INTO actor_principal_mappings
    (authority, external_actor_id, principal_id, mapped_by_principal_id)
  SELECT :'authority', :'external_actor_id', principal_id,
         :'admin_principal_id'::uuid
    FROM authorized
  ON CONFLICT (authority, external_actor_id) WHERE revoked_at IS NULL DO NOTHING
  RETURNING principal_id
)
SELECT count(*) = 1 AS reviewed
  FROM authorized
 WHERE (
   EXISTS (
     SELECT 1 FROM inserted_alias
      WHERE inserted_alias.principal_id = authorized.principal_id
   )
   OR EXISTS (
     SELECT 1 FROM principal_aliases alias
      WHERE alias.provider = :'provider'
        AND alias.alias_kind = :'alias_kind'
        AND alias.external_actor = :'external_actor_id'
        AND alias.principal_id = authorized.principal_id
   )
 )
   AND (
   EXISTS (
     SELECT 1 FROM inserted_mapping
      WHERE inserted_mapping.principal_id = authorized.principal_id
   )
   OR EXISTS (
     SELECT 1 FROM actor_principal_mappings mapping
      WHERE mapping.authority = :'authority'
        AND mapping.external_actor_id = :'external_actor_id'
        AND mapping.principal_id = authorized.principal_id
        AND mapping.revoked_at IS NULL
   )
 )
\gset

\if :reviewed
  COMMIT;
  \echo 'Typed alias and standup actor mapping provisioned and audited.'
\else
  ROLLBACK;
  \echo 'Provisioning failed: review the legacy alias, immutable ID, namespace, and org admin.'
  SELECT 1 / 0 AS standup_actor_not_provisioned;
\endif
