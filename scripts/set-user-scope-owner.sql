\set ON_ERROR_STOP on

\if :{?scope_id}
\else
  \prompt 'Existing user scope UUID: ' scope_id
\endif
\if :{?owner_principal_id}
\else
  \prompt 'Owner user principal UUID: ' owner_principal_id
\endif
\if :{?admin_principal_id}
\else
  \prompt 'Reviewing org-admin principal UUID: ' admin_principal_id
\endif

BEGIN;

WITH authorized AS (
  SELECT 1
    FROM scope_memberships sm
    JOIN scopes org ON org.id = sm.scope_id
   WHERE sm.principal_id = :'admin_principal_id'::uuid
     AND org.kind = 'org' AND org.name = '' AND sm.role = 'admin'
), target AS (
  SELECT s.id, s.owner_principal_id
    FROM scopes s
   WHERE s.id = :'scope_id'::uuid AND s.kind = 'user'
   FOR UPDATE
), owner AS (
  SELECT id FROM principals
   WHERE id = :'owner_principal_id'::uuid AND kind = 'user'
), changed AS (
  UPDATE scopes s
     SET owner_principal_id = o.id
    FROM target t, owner o, authorized a
   WHERE s.id = t.id
     AND (t.owner_principal_id IS NULL OR t.owner_principal_id = o.id)
  RETURNING s.id, s.owner_principal_id
), audited AS (
  INSERT INTO audit_log (principal_id, action, scope_id, metadata)
  SELECT :'admin_principal_id'::uuid, 'write', id,
         jsonb_build_object(
           'operation', 'set_user_scope_owner',
           'owner_principal_id', owner_principal_id
         )
    FROM changed
  RETURNING 1
)
SELECT count(*) = 1 AS ownership_set FROM audited
\gset

\if :ownership_set
  COMMIT;
  \echo 'User-scope owner set and audited.'
\else
  ROLLBACK;
  \echo 'Ownership was not changed: verify explicit UUIDs, user kind, org-admin role, and existing ownership.'
  SELECT 1 / 0 AS ownership_not_set;
\endif
