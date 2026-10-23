SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- An operator disposition is not a reconstructed response to an old request.
-- Reuse immutable operator events, including their existing privacy/retention
-- boundary. High-entropy identity hashes avoid retaining plaintext client IDs.
CREATE UNIQUE INDEX coordination_renewal_quarantine_request_idx
  ON coordination_operator_events ((metadata->>'request_key_hash'))
  WHERE operation = 'coordination_renewal_quarantined';
CREATE INDEX coordination_renewal_quarantine_lease_idx
  ON coordination_operator_events ((metadata->>'lease_hash'))
  WHERE operation = 'coordination_renewal_quarantined';

CREATE FUNCTION continuum_guard_quarantined_renewal_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.operation = 'renew' AND EXISTS (
    SELECT 1 FROM coordination_operator_events event
     WHERE event.operation = 'coordination_renewal_quarantined'
       AND event.metadata->>'request_key_hash' = encode(pg_catalog.sha256(
         pg_catalog.convert_to('renew-v1:' || NEW.principal_id::text || ':' || NEW.request_id::text, 'UTF8')), 'hex')
  ) THEN
    RAISE check_violation USING CONSTRAINT = 'coordination_renewal_quarantined',
      MESSAGE = 'coordination renewal is permanently quarantined';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION continuum_guard_quarantined_lease_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Authorized privacy can shorten timestamps. It cannot revive this identity.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.expires_at <= OLD.expires_at
       AND NOT (OLD.released_at IS NOT NULL AND NEW.released_at IS NULL) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM coordination_operator_events event
     WHERE event.operation = 'coordination_renewal_quarantined'
       AND event.metadata->>'lease_hash' = encode(pg_catalog.sha256(
         pg_catalog.convert_to('lease-v1:' || NEW.lease_id::text, 'UTF8')), 'hex')
  ) THEN
    RAISE check_violation USING CONSTRAINT = 'coordination_renewal_quarantined',
      MESSAGE = 'coordination lease generation is permanently quarantined';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quarantine_renewal_receipt
BEFORE INSERT ON coordination_operation_receipts
FOR EACH ROW EXECUTE FUNCTION continuum_guard_quarantined_renewal_receipt();
CREATE TRIGGER quarantine_lease_generation
BEFORE INSERT OR UPDATE OF expires_at, released_at ON coordination_leases
FOR EACH ROW EXECUTE FUNCTION continuum_guard_quarantined_lease_generation();

CREATE FUNCTION continuum_operator_quarantine_expired_renewal(
  actor_id UUID, target_principal_id UUID, target_scope_id UUID,
  target_resource TEXT, target_lease_id UUID, target_run_id UUID,
  expected_fencing_token BIGINT, target_request_id UUID, requested_ttl_seconds INTEGER,
  acknowledged_evidence_hash TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET lock_timeout = '1s' SET statement_timeout = '5s' AS $$
DECLARE
  request_key_hash TEXT;
  lease_hash TEXT;
  binding_hash TEXT;
  operation_hash BYTEA;
  lease_state RECORD;
  resource_state RECORD;
  receipt_state RECORD;
  prior_event RECORD;
  event_id BIGINT;
  observed_at TIMESTAMPTZ;
  receipt_present BOOLEAN;
BEGIN
  PERFORM continuum_require_trusted_database_identity(actor_id, 'approve');
  PERFORM continuum_coordination_require_contract_ready();
  IF actor_id IS NULL OR target_principal_id IS NULL OR target_scope_id IS NULL
     OR target_lease_id IS NULL OR target_run_id IS NULL OR target_request_id IS NULL
     OR target_resource IS NULL OR octet_length(target_resource) NOT BETWEEN 1 AND 512
     OR expected_fencing_token IS NULL OR expected_fencing_token <= 0
     OR requested_ttl_seconds IS NULL OR requested_ttl_seconds NOT BETWEEN 30 AND 900
     OR acknowledged_evidence_hash IS NULL OR acknowledged_evidence_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE invalid_parameter_value USING MESSAGE = 'invalid expired renewal disposition';
  END IF;

  -- Principal and authorization rows precede request, usage, resource and lease.
  PERFORM 1 FROM principals
   WHERE id IN (actor_id, target_principal_id) ORDER BY id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM principals WHERE id = target_principal_id) THEN
    RAISE check_violation USING MESSAGE = 'renewal target identity is unavailable';
  END IF;
  PERFORM 1 FROM principals actor
   JOIN scope_memberships membership ON membership.principal_id = actor.id
   WHERE actor.id = actor_id AND actor.kind = 'user' AND actor.disabled_at IS NULL
     AND membership.scope_id = continuum_org_scope_id()
     AND membership.active AND membership.role = 'admin'
     AND membership.source_kind = 'manual' AND membership.source_id = 'manual'
   FOR SHARE OF actor, membership;
  IF NOT FOUND THEN
    RAISE insufficient_privilege USING MESSAGE = 'renewal disposition requires a current manual organization administrator';
  END IF;
  PERFORM continuum_require_trusted_database_identity(actor_id, 'approve');
  PERFORM 1 FROM scopes WHERE id = target_scope_id AND kind = 'project' FOR SHARE;
  IF NOT FOUND THEN
    RAISE check_violation USING MESSAGE = 'renewal quarantine supports existing project scopes only';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    target_principal_id::text || ':renew:' || target_request_id::text, 604692071::bigint));

  request_key_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(
    'renew-v1:' || target_principal_id::text || ':' || target_request_id::text, 'UTF8')), 'hex');
  lease_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(
    'lease-v1:' || target_lease_id::text, 'UTF8')), 'hex');
  binding_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_array(
    'renew-quarantine-v1', target_principal_id::text, target_scope_id::text, target_resource,
    target_lease_id::text, target_run_id::text, expected_fencing_token::text,
    target_request_id::text, requested_ttl_seconds::text, acknowledged_evidence_hash)::text, 'UTF8')), 'hex');
  -- Same canonical length-prefixed semantic tuple as canonicalOperationHash.
  operation_hash := pg_catalog.sha256(pg_catalog.convert_to(
    '5:renew;36:' || target_lease_id::text || ';36:' || target_run_id::text || ';'
    || length(requested_ttl_seconds::text)::text || ':' || requested_ttl_seconds::text || ';', 'UTF8'));

  SELECT * INTO prior_event FROM coordination_operator_events event
   WHERE event.operation = 'coordination_renewal_quarantined'
     AND event.metadata->>'request_key_hash' = request_key_hash;
  IF FOUND THEN
    IF prior_event.scope_id <> target_scope_id
       OR prior_event.metadata->>'binding_hash' IS DISTINCT FROM binding_hash THEN
      RAISE check_violation USING MESSAGE = 'renewal disposition conflicts with retained evidence';
    END IF;
    RETURN jsonb_build_object('operatorEventId', prior_event.id::text,
      'observedAt', prior_event.at, 'historicalOutcome', 'UNKNOWN',
      'disposition', 'QUARANTINED_NO_REPLAY', 'oldGenerationAuthority', FALSE,
      'replayPermitted', FALSE,
      'receiptRetainedAtDisposition', (prior_event.metadata->>'receipt_present')::boolean);
  END IF;

  -- Do not call receipt cleanup or turn absence into a negative response.
  SELECT * INTO receipt_state FROM coordination_operation_receipts
   WHERE principal_id = target_principal_id AND operation = 'renew'
     AND request_id = target_request_id FOR UPDATE;
  receipt_present := FOUND;
  PERFORM continuum_coordination_lock_principal_usage(target_principal_id);
  SELECT * INTO resource_state FROM coordination_resources
   WHERE scope_id = target_scope_id AND resource = target_resource FOR UPDATE;
  IF NOT FOUND THEN RAISE check_violation USING MESSAGE = 'renewal resource is unavailable'; END IF;
  SELECT * INTO lease_state FROM coordination_leases WHERE lease_id = target_lease_id FOR UPDATE;
  IF NOT FOUND OR lease_state.principal_id <> target_principal_id
     OR lease_state.scope_id <> target_scope_id OR lease_state.resource <> target_resource
     OR lease_state.run_id <> target_run_id OR lease_state.fencing_token <> expected_fencing_token
     OR resource_state.fencing_token < expected_fencing_token THEN
    RAISE check_violation USING MESSAGE = 'renewal generation does not match reviewed identity';
  END IF;
  observed_at := pg_catalog.clock_timestamp();
  IF NOT isfinite(lease_state.expires_at) OR lease_state.expires_at > observed_at THEN
    RAISE check_violation USING MESSAGE = 'live or indeterminate lease cannot be quarantined';
  END IF;
  IF receipt_present AND (receipt_state.payload_hash <> operation_hash
     OR receipt_state.scope_id <> target_scope_id OR receipt_state.resource <> target_resource
     OR receipt_state.lease_id IS DISTINCT FROM target_lease_id
     OR receipt_state.run_id IS DISTINCT FROM target_run_id
     OR receipt_state.fencing_token IS DISTINCT FROM expected_fencing_token
     OR receipt_state.outcome <> 'renewed') THEN
    RAISE check_violation USING MESSAGE = 'retained renewal receipt does not match reviewed identity';
  END IF;

  INSERT INTO coordination_operator_events(at, principal_id, scope_id, operation, metadata)
  VALUES (observed_at, actor_id, target_scope_id, 'coordination_renewal_quarantined', jsonb_build_object(
    'version', 1, 'request_key_hash', request_key_hash, 'lease_hash', lease_hash,
    'binding_hash', binding_hash, 'acknowledged_evidence_hash', acknowledged_evidence_hash,
    'receipt_present', receipt_present, 'historical_outcome', 'UNKNOWN',
    'disposition', 'QUARANTINED_NO_REPLAY', 'replay_permitted', FALSE)) RETURNING id INTO event_id;
  -- This is a new operator retirement, never a fabricated lock_release receipt.
  UPDATE coordination_leases SET released_at = COALESCE(released_at, observed_at)
   WHERE lease_id = target_lease_id;
  UPDATE coordination_resources SET current_lease_id = NULL, updated_at = observed_at
   WHERE scope_id = target_scope_id AND resource = target_resource
     AND current_lease_id = target_lease_id;
  INSERT INTO audit_log(principal_id, action, scope_id, metadata)
  VALUES (actor_id, 'write', target_scope_id, jsonb_build_object(
    'operation', 'coordination_renewal_quarantined', 'operator_event_id', event_id::text,
    'historical_outcome', 'UNKNOWN', 'replay_permitted', FALSE));
  RETURN jsonb_build_object('operatorEventId', event_id::text, 'observedAt', observed_at,
    'historicalOutcome', 'UNKNOWN', 'disposition', 'QUARANTINED_NO_REPLAY',
    'oldGenerationAuthority', FALSE, 'replayPermitted', FALSE,
    'receiptRetainedAtDisposition', receipt_present);
END;
$$;

DO $harden$
DECLARE schema_name TEXT := current_schema(); function_record RECORD; definition TEXT; revised TEXT; signature TEXT;
BEGIN
  FOR function_record IN SELECT function.proname,
      pg_catalog.pg_get_function_identity_arguments(function.oid) AS arguments
    FROM pg_catalog.pg_proc function
    WHERE function.pronamespace = quote_ident(schema_name)::regnamespace
      AND function.proname = ANY(ARRAY['continuum_guard_quarantined_renewal_receipt',
        'continuum_guard_quarantined_lease_generation', 'continuum_operator_quarantine_expired_renewal']) LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path=pg_catalog,%I,pg_temp',
      schema_name, function_record.proname, function_record.arguments, schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',
      schema_name, function_record.proname, function_record.arguments);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['continuum_assert_application_role_allowlist(name,boolean)',
      'continuum_assert_standup_application_role_allowlist(name,boolean)'] LOOP
    definition := pg_catalog.pg_get_functiondef(signature::regprocedure);
    revised := replace(definition, '(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'')',
      '(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)''),'
      || '(''continuum_operator_quarantine_expired_renewal(uuid,uuid,uuid,text,uuid,uuid,bigint,uuid,integer,text)'')');
    IF revised = definition THEN RAISE EXCEPTION 'unable to extend renewal disposition operator allowlist'; END IF;
    EXECUTE revised;
  END LOOP;
END;
$harden$;
