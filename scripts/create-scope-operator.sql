\set ON_ERROR_STOP on

\if :{?external_id}
\else
  \prompt 'New high-entropy scope operator external_id: ' external_id
\endif

BEGIN;

WITH created AS (
  INSERT INTO principals (id, external_id, kind, display_name)
  VALUES (
    gen_random_uuid(),
    :'external_id',
    'service',
    'Scope Provisioning Operator'
  )
  ON CONFLICT (external_id) DO NOTHING
  RETURNING id
)
SELECT count(*) = 1 AS create_succeeded FROM created \gset

\if :create_succeeded
  COMMIT;
  \echo 'Created the dedicated scope-provisioning operator principal.'
\else
  ROLLBACK;
  \echo 'The requested external_id already exists; no principal was changed.'
  SELECT 1 / 0 AS scope_operator_external_id_already_exists;
\endif
