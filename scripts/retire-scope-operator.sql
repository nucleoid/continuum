\set ON_ERROR_STOP on

\if :{?external_id}
\else
  \prompt 'Scope operator external_id to retire: ' external_id
\endif

SELECT length(:'external_id') > 0 AS external_id_valid \gset
\if :external_id_valid
\else
  \echo 'external_id must not be empty.'
  SELECT 1 / 0 AS invalid_scope_operator_external_id;
\endif

BEGIN;

WITH target AS (
  SELECT id
    FROM principals
   WHERE external_id = :'external_id'
     AND kind = 'service'
     AND display_name = 'Scope Provisioning Operator'
   FOR UPDATE
), removed AS (
  DELETE FROM scope_memberships sm
  USING target t, scopes s
   WHERE sm.principal_id = t.id
     AND sm.scope_id = s.id
     AND s.kind = 'org' AND s.name = ''
     AND sm.source_kind = 'manual' AND sm.source_id = 'manual'
), rotated AS (
  UPDATE principals p
     SET external_id = gen_random_uuid()::text || gen_random_uuid()::text
    FROM target t
   WHERE p.id = t.id
  RETURNING p.id
)
SELECT count(*) = 1 AS retire_succeeded FROM rotated \gset

\if :retire_succeeded
  COMMIT;
  \echo 'Removed org membership and rotated the retired v0 bearer identity.'
\else
  ROLLBACK;
  \echo 'No dedicated scope-provisioning operator matched; nothing was changed.'
  SELECT 1 / 0 AS scope_operator_not_found;
\endif
