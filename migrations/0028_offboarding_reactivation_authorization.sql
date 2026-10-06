-- Bind the database reactivation capability to an effective org administrator
-- and append its audit record inside the same guarded transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP FUNCTION continuum_reactivate_principal(UUID);

CREATE FUNCTION continuum_reactivate_principal(
  target_principal_id UUID,
  actor_principal_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  was_offboarded BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM principals actor
      JOIN scope_memberships membership ON membership.principal_id = actor.id
      JOIN scopes scope ON scope.id = membership.scope_id
     WHERE actor.id = actor_principal_id
       AND actor.disabled_at IS NULL
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

  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (
    actor_principal_id,
    'write',
    jsonb_build_object(
      'operation', 'principal_reactivated',
      'principal_id', target_principal_id,
      'previously_offboarded', was_offboarded
    )
  );
  RETURN was_offboarded;
END;
$$;
