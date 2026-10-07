\set ON_ERROR_STOP on
\if :{?confirm_rebind}
\else
  \echo 'confirm_rebind must be REBIND DATABASE IDENTITIES'
\endif
\if :{?oid_provenance}
\else
  \echo 'oid_provenance must be PRESERVED OID NAMESPACE or FOREIGN OID NAMESPACE'
\endif
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif

-- Run only as the migration owner, with every Continuum process stopped.
-- The operator must explicitly declare whether role OIDs were preserved (for
-- pg_upgrade/provider upgrades) or are foreign (for logical restores/forks).
BEGIN;
SELECT :"continuum_schema".continuum_rebind_database_identity_oids(
  :'confirm_rebind',
  :'oid_provenance'
);
COMMIT;
