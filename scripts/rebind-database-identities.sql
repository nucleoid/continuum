\set ON_ERROR_STOP on
\if :{?confirm_rebind}
\else
  \echo 'confirm_rebind must be REBIND AFTER LOGICAL RESTORE'
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- Run only as the migration owner, with every Continuum process stopped,
-- after a logical restore has recreated PostgreSQL roles under new OIDs.
BEGIN;
SELECT :"continuum_schema".continuum_rebind_database_identity_oids(
  :'confirm_rebind'
);
COMMIT;
