\set ON_ERROR_STOP on

\if :{?principal_id}
\else
  \prompt 'Org-admin principal UUID to demote: ' principal_id
\endif
\if :{?replacement_role}
\else
  \prompt 'Replacement role (reader or writer): ' replacement_role
\endif

SELECT
  :'principal_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AS principal_id_valid,
  :'replacement_role' IN ('reader', 'writer') AS replacement_role_valid
\gset
\if :principal_id_valid
\else
  \echo 'principal_id must be a lowercase UUID.'
  SELECT 1 / 0 AS invalid_principal_id;
\endif
\if :replacement_role_valid
\else
  \echo 'replacement_role must be reader or writer.'
  SELECT 1 / 0 AS invalid_replacement_role;
\endif

BEGIN;

WITH target AS (
  SELECT sm.principal_id, sm.scope_id
    FROM scope_memberships sm
    JOIN scopes s ON s.id = sm.scope_id
   WHERE sm.principal_id = :'principal_id'
     AND s.kind = 'org' AND s.name = ''
     AND sm.role = 'admin'
   FOR UPDATE
), changed AS (
  UPDATE scope_memberships sm
     SET role = :'replacement_role'
    FROM target t
   WHERE sm.principal_id = t.principal_id AND sm.scope_id = t.scope_id
  RETURNING sm.principal_id
)
SELECT count(*) = 1 AS demote_succeeded FROM changed \gset

\if :demote_succeeded
  COMMIT;
  \echo 'Demoted exactly one org-admin membership.'
\else
  ROLLBACK;
  \echo 'Expected exactly one matching org-admin membership; nothing changed.'
  SELECT 1 / 0 AS org_admin_demote_failed;
\endif
