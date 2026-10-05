\set ON_ERROR_STOP on

\if :{?authority}
\else
  \prompt 'Trusted identity authority (for example github): ' authority
\endif
\if :{?external_actor_id}
\else
  \prompt 'Opaque actor ID issued by that authority: ' external_actor_id
\endif
\if :{?principal_id}
\else
  \prompt 'Target user principal UUID: ' principal_id
\endif
\if :{?admin_principal_id}
\else
  \prompt 'Reviewing org-admin principal UUID: ' admin_principal_id
\endif

BEGIN;

WITH inserted AS (
  INSERT INTO actor_principal_mappings
    (authority, external_actor_id, principal_id, mapped_by_principal_id)
  VALUES (
    :'authority', :'external_actor_id', :'principal_id'::uuid,
    :'admin_principal_id'::uuid
  )
  ON CONFLICT (authority, external_actor_id) WHERE revoked_at IS NULL DO NOTHING
  RETURNING authority, external_actor_id, principal_id
)
SELECT count(*) = 1 AS mapping_set FROM inserted
\gset

\if :mapping_set
  COMMIT;
  \echo 'Actor identity mapped and audited.'
\else
  ROLLBACK;
  \echo 'Mapping was not added: verify exact IDs, user kind, org-admin role, and conflicts.'
  SELECT 1 / 0 AS actor_mapping_not_set;
\endif
