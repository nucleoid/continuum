-- Separate database capability evidence from authenticated application actor
-- attribution. The shared database role cannot identify an HTTP or CLI caller.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP FUNCTION continuum_reactivate_principal(UUID, UUID);

CREATE FUNCTION continuum_reactivate_principal(
  target_principal_id UUID,
  authorization_principal_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  was_offboarded BOOLEAN;
BEGIN
  -- This proves only that the UUID presented to the capability is currently an
  -- effective administrator. The shared database role does not authenticate
  -- that UUID as the caller. Authenticated actor attribution remains in the
  -- application service transaction.
  IF NOT EXISTS (
    SELECT 1
      FROM principals authorization_principal
      JOIN scope_memberships membership
        ON membership.principal_id = authorization_principal.id
      JOIN scopes scope ON scope.id = membership.scope_id
     WHERE authorization_principal.id = authorization_principal_id
       AND authorization_principal.disabled_at IS NULL
       AND scope.kind = 'org' AND scope.name = ''
       AND membership.active AND membership.role = 'admin'
       AND continuum_membership_is_effective(
         membership.active, membership.source_kind
       )
  ) THEN
    RAISE EXCEPTION 'principal reactivation requires an effective org administrator';
  END IF;

  SELECT offboarded_at IS NOT NULL INTO was_offboarded
    FROM principals
   WHERE id = target_principal_id AND disabled_at IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM principal_offboarding_runs
     WHERE principal_id = target_principal_id AND completed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'principal offboarding is incomplete';
  END IF;

  INSERT INTO continuum_principal_reactivation_requests
    (principal_id, backend_pid, transaction_id)
  VALUES (target_principal_id, pg_backend_pid(), txid_current());
  UPDATE principals
     SET disabled_at = NULL, offboarded_at = NULL, reactivated_at = now()
   WHERE id = target_principal_id;
  DELETE FROM continuum_principal_reactivation_requests
   WHERE principal_id = target_principal_id;

  -- This row is mandatory capability evidence, not an authenticated-caller
  -- claim. A failure rolls back the lifecycle update in the same statement.
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (
    '00000000-0000-4000-8000-000000000011',
    'write',
    jsonb_build_object(
      'operation', 'principal_reactivation_guarded',
      'principal_id', target_principal_id,
      'authorization_principal_id', authorization_principal_id,
      'previously_offboarded', was_offboarded
    )
  );
  RETURN was_offboarded;
END;
$$;

-- PostgreSQL grants function execution to PUBLIC by default. The deployment's
-- shared migration/application role still owns this function and is therefore
-- inside the trusted database-administration boundary.
REVOKE ALL ON FUNCTION continuum_reactivate_principal(UUID, UUID) FROM PUBLIC;
