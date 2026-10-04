\set ON_ERROR_STOP on

\if :{?principal_id}
\else
  \prompt 'Scope operator principal UUID: ' principal_id
\endif

SELECT :'principal_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AS principal_id_valid
\gset
\if :principal_id_valid
\else
  \echo 'principal_id must be a lowercase UUID.'
  SELECT 1 / 0 AS invalid_scope_operator_principal_id;
\endif

WITH matches AS (
  SELECT p.id AS principal_id, p.kind, p.display_name, sm.role
    FROM principals p
    JOIN scope_memberships sm ON sm.principal_id = p.id
    JOIN scopes s ON s.id = sm.scope_id
   WHERE p.kind = 'service'
     AND p.display_name = 'Scope Provisioning Operator'
     AND p.id = :'principal_id'
     AND s.kind = 'org' AND s.name = ''
     AND sm.role = 'admin'
)
SELECT count(*) = 1 AS verify_succeeded FROM matches \gset

\if :verify_succeeded
  SELECT p.id AS principal_id, p.kind, p.display_name, sm.role
    FROM principals p
    JOIN scope_memberships sm ON sm.principal_id = p.id
    JOIN scopes s ON s.id = sm.scope_id
   WHERE p.kind = 'service'
     AND p.display_name = 'Scope Provisioning Operator'
     AND p.id = :'principal_id'
     AND s.kind = 'org' AND s.name = ''
     AND sm.role = 'admin';
\else
  \echo 'The requested dedicated operator is not an active org admin.'
  SELECT 1 / 0 AS scope_operator_verification_failed;
\endif
