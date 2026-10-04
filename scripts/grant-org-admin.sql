\set ON_ERROR_STOP on

\if :{?external_id}
\else
  \prompt 'Scope operator external_id: ' external_id
\endif

SELECT :'external_id' ~ '^[0-9a-f]{64}$' AS external_id_valid \gset
\if :external_id_valid
\else
  \echo 'external_id must be exactly 64 lowercase hexadecimal characters.'
  SELECT 1 / 0 AS invalid_scope_operator_external_id;
\endif

BEGIN;

WITH target AS (
  SELECT p.id AS principal_id, s.id AS scope_id
    FROM principals p
    JOIN scopes s ON s.kind = 'org' AND s.name = ''
   WHERE p.external_id = :'external_id'
     AND p.kind = 'service'
     AND p.display_name = 'Scope Provisioning Operator'
), granted AS (
  INSERT INTO scope_memberships (principal_id, scope_id, role)
  SELECT principal_id, scope_id, 'admin'
    FROM target
  ON CONFLICT (principal_id, scope_id)
  DO NOTHING
  RETURNING principal_id, scope_id
)
SELECT (
  (SELECT count(*) FROM granted) = 1
  OR EXISTS (
    SELECT 1
      FROM scope_memberships sm
      JOIN target t
        ON t.principal_id = sm.principal_id AND t.scope_id = sm.scope_id
     WHERE sm.role = 'admin'
  )
) AS grant_succeeded
\gset

\if :grant_succeeded
  COMMIT;
  \echo 'Granted org admin to the requested existing principal.'
\else
  ROLLBACK;
  \echo 'No unique operator/org pair was found, or an existing non-admin membership was left unchanged.'
  SELECT 1 / 0 AS no_unique_principal_or_org_scope;
\endif
