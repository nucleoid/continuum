\set ON_ERROR_STOP on

\if :{?authority}
\else
  \prompt 'Trusted identity authority: ' authority
\endif
\if :{?external_actor_id}
\else
  \prompt 'Opaque actor ID issued by that authority: ' external_actor_id
\endif
\if :{?admin_principal_id}
\else
  \prompt 'Reviewing org-admin principal UUID: ' admin_principal_id
\endif

BEGIN;

WITH revoked AS (
  UPDATE actor_principal_mappings
     SET revoked_by_principal_id = :'admin_principal_id'::uuid
   WHERE authority = :'authority'
     AND external_actor_id = :'external_actor_id'
     AND revoked_at IS NULL
  RETURNING mapping_id
)
SELECT count(*) = 1 AS mapping_revoked FROM revoked
\gset

\if :mapping_revoked
  COMMIT;
  \echo 'Actor identity mapping revoked and audited; history retained.'
\else
  ROLLBACK;
  \echo 'Mapping was not revoked: verify exact IDs, active state, and org-admin role.'
  SELECT 1 / 0 AS actor_mapping_not_revoked;
\endif
