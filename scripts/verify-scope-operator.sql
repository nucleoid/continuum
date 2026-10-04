\set ON_ERROR_STOP on

WITH matches AS (
  SELECT p.id AS principal_id, p.kind, p.display_name, sm.role
    FROM principals p
    JOIN scope_memberships sm ON sm.principal_id = p.id
    JOIN scopes s ON s.id = sm.scope_id
   WHERE p.kind = 'service'
     AND p.display_name = 'Scope Provisioning Operator'
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
     AND s.kind = 'org' AND s.name = ''
     AND sm.role = 'admin';
\else
  \echo 'Expected exactly one dedicated scope-provisioning org admin.'
  SELECT 1 / 0 AS scope_operator_verification_failed;
\endif
