\set ON_ERROR_STOP on

\if :{?principal_id}
\else
  \prompt 'Principal UUID to restore as org admin: ' principal_id
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

WITH target AS (
  SELECT p.id AS principal_id, s.id AS scope_id
    FROM principals p
    JOIN scopes s ON s.kind = 'org' AND s.name = ''
   WHERE p.id = :'principal_id'
), restored AS (
  INSERT INTO scope_memberships
    (principal_id, scope_id, role, source_kind, source_id, active, deactivated_at)
  SELECT principal_id, scope_id, 'admin', 'manual', 'manual', TRUE, NULL FROM target
  ON CONFLICT (principal_id, scope_id, source_kind, source_id)
  DO UPDATE SET role = 'admin', active = TRUE, deactivated_at = NULL
    WHERE scope_memberships.role IN ('reader', 'writer') OR NOT scope_memberships.active
  RETURNING principal_id
)
SELECT (
  (SELECT count(*) FROM restored) = 1
  OR EXISTS (
    SELECT 1
      FROM scope_memberships sm
      JOIN target t
        ON t.principal_id = sm.principal_id AND t.scope_id = sm.scope_id
     WHERE sm.role = 'admin' AND sm.active
  )
) AS restore_succeeded
\gset

\if :restore_succeeded
  COMMIT;
  \echo 'Restored org admin for principal' :principal_id
\else
  ROLLBACK;
  \echo 'Expected exactly one existing principal and singleton org scope; nothing changed.'
  SELECT 1 / 0 AS org_admin_restore_failed;
\endif
