\set ON_ERROR_STOP on

\if :{?authority}
\else
  \prompt 'Trusted identity authority: ' authority
\endif
\if :{?external_actor_id}
\else
  \prompt 'Opaque actor ID issued by that authority: ' external_actor_id
\endif
\if :{?principal_id}
\else
  \prompt 'Replacement user principal UUID: ' principal_id
\endif
\if :{?admin_principal_id}
\else
  \prompt 'Reviewing org-admin principal UUID: ' admin_principal_id
\endif

BEGIN;

WITH active_mapping AS MATERIALIZED (
  SELECT mapping_id
    FROM actor_principal_mappings
   WHERE authority = :'authority'
     AND external_actor_id = :'external_actor_id'
     AND revoked_at IS NULL
   FOR UPDATE
), revoked AS (
  UPDATE actor_principal_mappings mapping
     SET revoked_by_principal_id = :'admin_principal_id'::uuid
    FROM active_mapping
   WHERE mapping.mapping_id = active_mapping.mapping_id
  RETURNING mapping.mapping_id
)
SELECT count(*) = 1 AS mapping_revoked FROM revoked
\gset

\if :mapping_revoked
  INSERT INTO actor_principal_mappings
    (authority, external_actor_id, principal_id, mapped_by_principal_id)
  VALUES (
    :'authority', :'external_actor_id', :'principal_id'::uuid,
    :'admin_principal_id'::uuid
  );
  COMMIT;
  \echo 'Actor identity mapping replaced; revocation and replacement were audited.'
\else
  ROLLBACK;
  \echo 'Mapping was not replaced: verify exact IDs, active state, and org-admin role.'
  SELECT 1 / 0 AS actor_mapping_not_replaced;
\endif
