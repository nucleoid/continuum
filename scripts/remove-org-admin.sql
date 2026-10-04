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

WITH removed AS (
  DELETE FROM scope_memberships sm
  USING scopes s
   WHERE sm.principal_id = :'principal_id'
     AND sm.scope_id = s.id
     AND s.kind = 'org' AND s.name = ''
     AND sm.role = 'admin'
  RETURNING sm.principal_id
)
SELECT count(*) = 1 AS remove_succeeded FROM removed \gset

\if :remove_succeeded
  COMMIT;
  \echo 'Removed exactly one org-admin membership.'
\else
  ROLLBACK;
  \echo 'Expected exactly one matching org-admin membership; nothing changed.'
  SELECT 1 / 0 AS org_admin_remove_failed;
\endif
