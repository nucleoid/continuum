\set ON_ERROR_STOP on

BEGIN;

WITH target AS (
  SELECT p.id AS principal_id, s.id AS scope_id
    FROM principals p
    JOIN scopes s ON s.kind = 'org' AND s.name = ''
   WHERE p.external_id = :'external_id'
), granted AS (
  INSERT INTO scope_memberships (principal_id, scope_id, role)
  SELECT principal_id, scope_id, 'admin'
    FROM target
  ON CONFLICT (principal_id, scope_id)
  DO UPDATE SET role = EXCLUDED.role
  RETURNING principal_id, scope_id
)
SELECT count(*) = 1 AS grant_succeeded FROM granted \gset

\if :grant_succeeded
  COMMIT;
  \echo 'Granted org admin to the requested existing principal.'
\else
  ROLLBACK;
  \echo 'No unique existing principal and singleton org scope were found.'
  SELECT 1 / 0 AS no_unique_principal_or_org_scope;
\endif
