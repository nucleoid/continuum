\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on
-- Owner-only, read-only first-disposition preflight. Inputs must be derived
-- independently from preserved client bytes, never copied from this result.
-- Retain stdout/stderr under the existing finite outer owner in new private
-- output files. No connection credentials belong in inputs or output.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
SET LOCAL search_path=pg_catalog;

-- continuum:renewal-quarantine-preflight-query-begin
WITH input AS (
  SELECT :'target_principal_id'::uuid AS principal_id,
    :'target_scope_id'::uuid AS scope_id, :'target_scope_name'::text AS scope_name,
    :'target_resource'::text AS resource, :'target_lease_id'::uuid AS lease_id,
    :'target_run_id'::uuid AS run_id, :'expected_fencing_token'::bigint AS fence,
    :'target_request_id'::uuid AS request_id, :'requested_ttl_seconds'::integer AS ttl,
    :'acknowledged_evidence_hash'::text AS evidence_hash,
    :'previous_expiry'::timestamptz AS previous_expiry,
    :'expected_request_key_hash'::text AS expected_request_key_hash,
    :'expected_lease_hash'::text AS expected_lease_hash,
    :'expected_binding_hash'::text AS expected_binding_hash,
    :'expected_owner'::text AS expected_owner
), derived AS (
  SELECT input.*,
    encode(sha256(convert_to('renew-v1:'||principal_id::text||':'||request_id::text,'UTF8')),'hex') AS request_key_hash,
    encode(sha256(convert_to('lease-v1:'||lease_id::text,'UTF8')),'hex') AS lease_hash,
    encode(sha256(convert_to(jsonb_build_array('renew-quarantine-v1',principal_id::text,
      scope_id::text,resource,lease_id::text,run_id::text,fence::text,request_id::text,
      ttl::text,evidence_hash)::text,'UTF8')),'hex') AS binding_hash,
    sha256(convert_to('5:renew;36:'||lease_id::text||';36:'||run_id::text||';'
      ||length(ttl::text)::text||':'||ttl::text||';','UTF8')) AS operation_hash
  FROM input
), facts AS (
  SELECT derived.*,
    current_user=expected_owner AND
      current_user=pg_get_userbyid((SELECT relowner FROM pg_class
        WHERE oid=to_regclass(format('%I.principals',:'continuum_schema'::text)))) AS owner_matches,
    EXISTS(SELECT 1 FROM :"continuum_schema".principals principal WHERE principal.id=principal_id) AS principal_present,
    EXISTS(SELECT 1 FROM :"continuum_schema".scopes scope
      WHERE scope.id=scope_id AND scope.kind='project' AND scope.name=scope_name) AS scope_matches,
    EXISTS(SELECT 1 FROM :"continuum_schema".coordination_resources resource_state
      WHERE resource_state.scope_id=derived.scope_id AND resource_state.resource=derived.resource
        AND resource_state.fencing_token>=fence) AS resource_matches,
    EXISTS(SELECT 1 FROM :"continuum_schema".coordination_leases lease
      WHERE lease.lease_id=derived.lease_id) AS generation_present,
    EXISTS(SELECT 1 FROM :"continuum_schema".coordination_leases lease
      WHERE lease.lease_id=derived.lease_id AND lease.principal_id=derived.principal_id
        AND lease.scope_id=derived.scope_id AND lease.resource=derived.resource
        AND lease.run_id=derived.run_id AND lease.fencing_token=fence) AS generation_matches,
    EXISTS(SELECT 1 FROM :"continuum_schema".coordination_leases lease
      WHERE lease.lease_id=derived.lease_id AND isfinite(lease.expires_at)
        AND lease.expires_at<=statement_timestamp()) AS generation_expired,
    EXISTS(SELECT 1 FROM :"continuum_schema".coordination_leases lease
      WHERE lease.lease_id=derived.lease_id AND lease.expires_at=previous_expiry) AS previous_expiry_matches,
    (SELECT count(*)::integer FROM :"continuum_schema".coordination_operation_receipts receipt
      WHERE receipt.principal_id=derived.principal_id AND receipt.operation='renew'
        AND receipt.request_id=derived.request_id) AS receipt_count,
    EXISTS(SELECT 1 FROM :"continuum_schema".coordination_operation_receipts receipt
      WHERE receipt.principal_id=derived.principal_id AND receipt.operation='renew'
        AND receipt.request_id=derived.request_id AND receipt.payload_hash=operation_hash
        AND receipt.scope_id=derived.scope_id AND receipt.resource=derived.resource
        AND receipt.lease_id=derived.lease_id AND receipt.run_id=derived.run_id
        AND receipt.fencing_token=fence AND receipt.outcome='renewed') AS receipt_matches,
    (SELECT count(*)::integer FROM :"continuum_schema".coordination_operator_events event
      WHERE event.operation='coordination_renewal_quarantined' AND
        (event.metadata->>'request_key_hash'=derived.request_key_hash
          OR event.metadata->>'lease_hash'=derived.lease_hash)) AS prior_quarantine_count
  FROM derived
), checked AS (
  SELECT facts.*,
    COALESCE(owner_matches AND principal_present AND scope_matches AND resource_matches
      AND generation_present AND generation_matches AND generation_expired
      AND fence>0 AND ttl BETWEEN 30 AND 900 AND octet_length(resource) BETWEEN 1 AND 512
      AND evidence_hash~'^[0-9a-f]{64}$' AND isfinite(previous_expiry)
      AND request_key_hash=expected_request_key_hash AND lease_hash=expected_lease_hash
      AND binding_hash=expected_binding_hash AND prior_quarantine_count=0
      AND ((receipt_count=0 AND previous_expiry_matches) OR (receipt_count=1 AND receipt_matches)),FALSE) AS eligible
  FROM facts
)
SELECT jsonb_build_object('version',1,'kind','renewal-quarantine-owner-preflight',
  'observedAt',statement_timestamp(),'eligible',eligible,'readOnly',current_setting('transaction_read_only'),
  'ownerMatches',owner_matches,'principalPresent',principal_present,'scopeMatches',scope_matches,
  'resourceMatches',resource_matches,'generationPresent',generation_present,
  'generationMatches',generation_matches,'generationExpired',generation_expired,
  'previousExpiryMatches',previous_expiry_matches,'receiptCount',receipt_count,'receiptMatches',receipt_matches,
  'priorQuarantineCount',prior_quarantine_count,
  'independentHashesMatch',request_key_hash=expected_request_key_hash AND lease_hash=expected_lease_hash
    AND binding_hash=expected_binding_hash,
  'requestKeyHash',request_key_hash,'leaseHash',lease_hash,'bindingHash',binding_hash,
  'acknowledgedEvidenceHash',evidence_hash,
  'tuple',jsonb_build_object('principal',principal_id,'scope',scope_id,'scopeName',scope_name,
    'resource',resource,'lease',lease_id,'run',run_id,'fence',fence::text,'request',request_id,
    'ttlSeconds',ttl,'previousExpiry',previous_expiry),
  'physicalQuiescenceProven',FALSE,'operationExecuted',FALSE,'leaseAuthorityGranted',FALSE) AS report,
  eligible
FROM checked
-- continuum:renewal-quarantine-preflight-query-end
\gset renewal_preflight_
\echo :renewal_preflight_report
ROLLBACK;
\if :renewal_preflight_eligible
\else
-- Fixed SQL failure makes psql ON_ERROR_STOP return nonzero after recording
-- the private report. No operator function is called on either branch.
SELECT 1/0 AS renewal_quarantine_preflight_refused;
\endif
