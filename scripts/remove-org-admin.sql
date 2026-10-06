\set ON_ERROR_STOP on

\if :{?principal_id}
\else
  \prompt 'Org-admin principal UUID to remove: ' principal_id
\endif

SELECT :'principal_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AS principal_id_valid
\gset
\if :principal_id_valid
\else
  \echo 'principal_id must be a lowercase UUID.'
  SELECT 1 / 0 AS invalid_principal_id;
\endif

BEGIN;

WITH admins AS MATERIALIZED (
  SELECT sm.principal_id, sm.scope_id
    FROM scope_memberships sm
    JOIN scopes s ON s.id = sm.scope_id
   WHERE s.kind = 'org' AND s.name = ''
     AND sm.role = 'admin' AND sm.active
     AND sm.source_kind = 'manual' AND sm.source_id = 'manual'
   FOR UPDATE OF sm
), removed AS (
  DELETE FROM scope_memberships sm
  USING admins a
   WHERE sm.principal_id = :'principal_id'
     AND sm.principal_id = a.principal_id
     AND sm.scope_id = a.scope_id
     AND (SELECT count(DISTINCT principal_id) FROM admins) > 1
  RETURNING sm.principal_id
)
SELECT count(*) = 1 AS remove_succeeded FROM removed \gset

\if :remove_succeeded
  COMMIT;
  \echo 'Removed admin membership for principal' :principal_id
\else
  ROLLBACK;
  \echo 'Expected one matching manual org admin and at least one other active manual org admin; nothing changed.'
  SELECT 1 / 0 AS org_admin_remove_failed;
\endif
