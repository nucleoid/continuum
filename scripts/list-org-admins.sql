\set ON_ERROR_STOP on

SELECT p.id AS principal_id, p.kind, p.display_name, sm.role
  FROM scope_memberships sm
  JOIN principals p ON p.id = sm.principal_id
  JOIN scopes s ON s.id = sm.scope_id
 WHERE s.kind = 'org' AND s.name = '' AND sm.role = 'admin' AND sm.active
 GROUP BY p.id, p.kind, p.display_name, sm.role
 ORDER BY p.kind, p.display_name, p.id;
