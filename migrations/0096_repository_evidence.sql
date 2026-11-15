-- Optional empty repository-evidence boundary. No credentials, remote calls or backfill.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE continuum_connector_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $$ DECLARE candidate RECORD; BEGIN
  FOR candidate IN SELECT p.*,r.rolname FROM continuum_pgvector_role_profiles p JOIN pg_roles r ON r.oid=p.database_role_oid
    WHERE profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_connector_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Continuum skipped connector grants for role OID % (SQLSTATE %); explicit regrant required',candidate.database_role_oid,SQLSTATE;
    END;
  END LOOP;
END $$;

CREATE TABLE connector_repository_mappings(
  id UUID PRIMARY KEY,scope_id UUID NOT NULL REFERENCES scopes(id),
  connector_id TEXT NOT NULL CHECK(connector_id~'^[a-z][a-z0-9.-]{0,63}$'),
  connector_version TEXT NOT NULL CHECK(connector_version~'^[a-zA-Z0-9_.:/-]{1,128}$'),
  repository TEXT CHECK(repository IS NULL OR repository~'^[a-zA-Z0-9_.:/-]{1,128}$'),
  generation BIGINT NOT NULL CHECK(generation>0),enabled BOOLEAN NOT NULL,
  residency TEXT NOT NULL CHECK(residency IN ('any','local-only')),
  CHECK(NOT enabled OR repository IS NOT NULL)
);
CREATE TABLE connector_query_runs(
  id UUID PRIMARY KEY,scope_id UUID NOT NULL REFERENCES scopes(id),actor UUID REFERENCES principals(id),
  mapping_id UUID REFERENCES connector_repository_mappings(id),mapping_generation BIGINT NOT NULL,
  workflow_id UUID NOT NULL REFERENCES pipeline_budget_workflows(id),
  worker_id UUID NOT NULL,workflow_generation BIGINT NOT NULL CHECK(workflow_generation>0),
  permission_attempt UUID UNIQUE NOT NULL,query_attempt UUID UNIQUE NOT NULL,delivery_attempt UUID UNIQUE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL CHECK(isfinite(expires_at)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','cancelled')),
  outcome TEXT CHECK(outcome IN ('complete','denied','unavailable','stale','budget','timeout')),
  receipt_version UUID REFERENCES evidence_versions(id),evidence_version UUID REFERENCES evidence_versions(id),
  permit_xid BIGINT,permit_until TIMESTAMPTZ,
  CHECK(permission_attempt<>query_attempt AND permission_attempt<>delivery_attempt AND query_attempt<>delivery_attempt)
);
CREATE INDEX connector_mappings_scope_idx ON connector_repository_mappings(scope_id,id);
CREATE INDEX connector_runs_scope_idx ON connector_query_runs(scope_id,id);
CREATE INDEX connector_runs_mapping_idx ON connector_query_runs(mapping_id,id);
REVOKE ALL ON connector_repository_mappings,connector_query_runs FROM PUBLIC;
ALTER TABLE evidence_versions DROP CONSTRAINT evidence_versions_kind_check;
ALTER TABLE evidence_versions ADD CONSTRAINT evidence_versions_kind_check CHECK(kind IN
  ('source-document-version','extracted-assertion','derived-observation','brief-section-version','history','cache','trace','managed-export','queued-payload','connector-evidence','connector-receipt'));

CREATE FUNCTION continuum_operator_connector_mapping(actor UUID,mapping UUID,target_scope UUID,connector TEXT,version TEXT,repository TEXT,residency TEXT,enabled BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF mapping IS NULL OR enabled IS NULL OR NOT continuum_evidence_can_access(actor,target_scope,TRUE) THEN
    RAISE insufficient_privilege USING MESSAGE='Repository mapping unavailable'; END IF;
  INSERT INTO connector_repository_mappings VALUES(mapping,target_scope,connector,version,repository,1,enabled,residency)
    ON CONFLICT(id) DO UPDATE SET connector_id=EXCLUDED.connector_id,connector_version=EXCLUDED.connector_version,
      repository=EXCLUDED.repository,residency=EXCLUDED.residency,enabled=EXCLUDED.enabled,generation=connector_repository_mappings.generation+1
      WHERE connector_repository_mappings.scope_id=target_scope;
  IF NOT FOUND THEN RAISE check_violation USING MESSAGE='Repository mapping unavailable'; END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',target_scope,jsonb_build_object('operation','connector_mapping_fenced'));
END $$;
CREATE FUNCTION continuum_connector_mapping(actor UUID,mapping UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m connector_repository_mappings%ROWTYPE;
BEGIN
  SELECT * INTO m FROM connector_repository_mappings WHERE id=mapping FOR SHARE;
  IF NOT FOUND OR NOT m.enabled OR NOT continuum_evidence_can_access(actor,m.scope_id,FALSE) THEN RETURN NULL; END IF;
  PERFORM id FROM principals WHERE id=actor FOR SHARE;
  PERFORM principal_id FROM scope_memberships WHERE principal_id=actor AND scope_id=m.scope_id FOR SHARE;
  PERFORM singleton FROM entra_sync_state WHERE singleton FOR SHARE;
  IF NOT continuum_evidence_can_access(actor,m.scope_id,FALSE) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id',m.id,'scopeId',m.scope_id,'connectorId',m.connector_id,'connectorVersion',m.connector_version,
    'repository',m.repository,'generation',m.generation,'residency',m.residency,'now',extract(epoch FROM clock_timestamp())*1000);
END $$;
CREATE FUNCTION continuum_connector_admission(actor UUID,mapping UUID,epoch BIGINT,stage TEXT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m JSONB;
BEGIN
  IF stage IS NULL OR stage NOT IN ('permission','content') THEN RETURN FALSE; END IF;
  m:=continuum_connector_mapping(actor,mapping);
  IF m IS NULL OR (m->>'generation')::bigint<>epoch THEN RETURN FALSE; END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'read',(m->>'scopeId')::uuid,
    jsonb_build_object('operation','connector_'||stage||'_admitted'));
  RETURN TRUE;
END $$;
CREATE FUNCTION continuum_connector_start(actor UUID,run_id UUID,mapping UUID,epoch BIGINT,workflow UUID,worker UUID,workflow_epoch BIGINT,permission UUID,query UUID,delivery UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m JSONB; w pipeline_budget_workflows%ROWTYPE;
BEGIN
  m:=continuum_connector_mapping(actor,mapping);
  IF m IS NULL OR (m->>'generation')::bigint<>epoch OR run_id IS NULL
    OR EXISTS(SELECT 1 FROM memories WHERE id=run_id)
    OR EXISTS(SELECT 1 FROM evidence_roots WHERE id=run_id) THEN RETURN FALSE; END IF;
  SELECT * INTO w FROM pipeline_budget_workflows WHERE id=workflow FOR SHARE;
  IF NOT FOUND OR w.owner<>worker OR w.generation<>workflow_epoch OR w.cancelled OR w.deadline_at<=clock_timestamp()
    OR (w.profile->'limits'->>'spendMicros')::bigint<>0 THEN RETURN FALSE; END IF;
  INSERT INTO connector_query_runs(id,scope_id,actor,mapping_id,mapping_generation,workflow_id,worker_id,workflow_generation,
    permission_attempt,query_attempt,delivery_attempt,expires_at)
    VALUES(run_id,(m->>'scopeId')::uuid,actor,mapping,epoch,workflow,worker,workflow_epoch,permission,query,delivery,w.deadline_at)
    ON CONFLICT(id) DO NOTHING;
  RETURN FOUND;
END $$;

-- Per-operation upstream authority is deliberately transaction-bound. A saved
-- allow, another principal, or a new transaction cannot serve any descendant.
ALTER FUNCTION continuum_evidence_eligible(UUID,UUID,TEXT) RENAME TO continuum_evidence_eligible_pre_connector;
CREATE FUNCTION continuum_evidence_eligible(actor UUID,version UUID,locality TEXT) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
BEGIN
  IF NOT continuum_evidence_eligible_pre_connector(actor,version,locality) THEN RETURN FALSE; END IF;
  IF EXISTS(SELECT 1 FROM evidence_closure c JOIN connector_query_runs q ON q.id=c.root_id
    LEFT JOIN connector_repository_mappings m ON m.id=q.mapping_id
    WHERE c.version_id=version AND (q.actor IS DISTINCT FROM $1 OR q.state<>'complete'
      OR q.permit_xid IS DISTINCT FROM txid_current() OR q.permit_until IS NULL OR q.permit_until<=clock_timestamp()
      OR q.expires_at<=clock_timestamp() OR m.id IS NULL OR NOT m.enabled OR m.generation<>q.mapping_generation
      OR (locality='hosted' AND m.residency='local-only'))) THEN RETURN FALSE; END IF;
  RETURN TRUE;
END $$;

CREATE FUNCTION continuum_connector_permit(actor UUID,run_id UUID,epoch BIGINT,checked_at TIMESTAMPTZ,valid_until TIMESTAMPTZ,code_commit TEXT,index_watermark TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE q connector_query_runs%ROWTYPE; m JSONB; receipt JSONB; at TIMESTAMPTZ;
BEGIN
  SELECT * INTO q FROM connector_query_runs WHERE id=run_id AND connector_query_runs.actor=$1 FOR UPDATE;
  IF NOT FOUND OR q.state='cancelled' THEN RETURN FALSE; END IF;
  m:=continuum_connector_mapping(actor,q.mapping_id); at:=clock_timestamp();
  IF m IS NULL OR q.mapping_generation<>epoch OR (m->>'generation')::bigint<>epoch
    OR checked_at IS NULL OR valid_until IS NULL OR NOT isfinite(checked_at) OR NOT isfinite(valid_until)
    OR checked_at>at OR valid_until<=at OR valid_until>checked_at+interval '5 seconds' OR q.expires_at<=at THEN RETURN FALSE; END IF;
  IF q.receipt_version IS NOT NULL THEN
    SELECT payload::jsonb INTO receipt FROM evidence_payloads WHERE version_id=q.receipt_version;
    IF receipt IS NULL OR receipt->>'commit' IS DISTINCT FROM code_commit OR receipt->>'indexWatermark' IS DISTINCT FROM index_watermark THEN RETURN FALSE; END IF;
  END IF;
  UPDATE connector_query_runs SET permit_xid=txid_current(),permit_until=valid_until WHERE id=run_id;
  UPDATE evidence_roots SET external_state='allow',checked_at=$4,valid_until=$5 WHERE id=run_id;
  RETURN TRUE;
END $$;

CREATE FUNCTION continuum_connector_finish(actor UUID,run_id UUID,receipt JSONB,content TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE q connector_query_runs%ROWTYPE; r UUID:=gen_random_uuid(); e UUID; node UUID; m connector_repository_mappings%ROWTYPE;
BEGIN
  SELECT * INTO q FROM connector_query_runs WHERE id=run_id AND connector_query_runs.actor=$1 FOR UPDATE;
  IF NOT FOUND OR q.state<>'pending' OR q.permit_xid IS DISTINCT FROM txid_current() OR q.permit_until<=clock_timestamp()
    OR q.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM memories WHERE id=run_id)
    THEN RAISE check_violation USING MESSAGE='Repository evidence unavailable'; END IF;
  SELECT * INTO STRICT m FROM connector_repository_mappings WHERE id=q.mapping_id FOR SHARE;
  IF NOT m.enabled OR m.generation<>q.mapping_generation OR NOT continuum_evidence_can_access(actor,q.scope_id,FALSE)
    OR NOT EXISTS(SELECT 1 FROM pipeline_budget_workflows w WHERE w.id=q.workflow_id AND w.owner=q.worker_id
      AND w.generation=q.workflow_generation AND NOT w.cancelled AND w.deadline_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM pipeline_budget_attempts a WHERE a.workflow_id=q.workflow_id AND a.attempt_id=q.query_attempt AND a.state='settled')
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR octet_length(receipt::text)>8192
    OR receipt->>'schema' IS DISTINCT FROM 'repository-evidence-v1' OR receipt->>'outcome' IS DISTINCT FROM 'complete'
    OR receipt->>'freshness' IS NULL OR receipt->>'freshness' NOT IN ('exact','unknown')
    OR receipt->>'evidenceClass' IS NULL OR receipt->>'evidenceClass' NOT IN ('repository-brief','indexed-symbol','source-code','file-context','flow','contract-impact')
    OR jsonb_typeof(receipt->'truncated') IS DISTINCT FROM 'boolean' OR NOT(receipt ?& ARRAY['commit','indexWatermark'])
    OR (receipt->'commit'<>'null'::jsonb AND (jsonb_typeof(receipt->'commit')<>'string' OR receipt->>'commit'!~'^[0-9a-f]{40}([0-9a-f]{24})?$'))
    OR (receipt->'indexWatermark'<>'null'::jsonb AND (jsonb_typeof(receipt->'indexWatermark')<>'string' OR receipt->>'indexWatermark'!~'^[a-zA-Z0-9_.:/-]{1,128}$'))
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(receipt) k WHERE k NOT IN ('schema','outcome','evidenceClass','freshness','commit','indexWatermark','truncated'))
    OR content IS NULL OR octet_length(content)>65536 THEN RAISE check_violation USING MESSAGE='Repository evidence unavailable'; END IF;
  INSERT INTO evidence_roots(id,scope_id,expiry_ceiling,residency,external_state,checked_at,valid_until)
    VALUES(run_id,q.scope_id,q.expires_at,m.residency,'allow',clock_timestamp(),q.permit_until);
  INSERT INTO evidence_versions(id,root_id,scope_id,kind,provenance,expires_at,depth,root_count,parent_count)
    VALUES(r,run_id,q.scope_id,'connector-receipt','{"schema":"repository-evidence-v1"}',q.expires_at,0,1,0);
  INSERT INTO evidence_closure VALUES(r,run_id,1);
  INSERT INTO evidence_state(version_id) VALUES(r);
  INSERT INTO evidence_payloads VALUES(r,receipt::text,encode(sha256(convert_to(receipt::text,'UTF8')),'hex'));
  UPDATE evidence_roots SET current_version=r WHERE id=run_id;
  node:=gen_random_uuid(); e:=gen_random_uuid();
  INSERT INTO evidence_roots(id,scope_id,expiry_ceiling) VALUES(node,q.scope_id,q.expires_at);
  INSERT INTO evidence_versions(id,root_id,scope_id,kind,provenance,expires_at,depth,root_count,parent_count)
    VALUES(e,node,q.scope_id,'connector-evidence','{"schema":"repository-evidence-v1"}',q.expires_at,1,2,1);
  INSERT INTO evidence_edges VALUES(e,r,'derivation');
  INSERT INTO evidence_closure VALUES(e,run_id,1),(e,node,1);
  INSERT INTO evidence_state(version_id) VALUES(e);
  INSERT INTO evidence_payloads VALUES(e,content,encode(sha256(convert_to(content,'UTF8')),'hex'));
  UPDATE evidence_roots SET current_version=e WHERE id=node;
  UPDATE connector_query_runs SET state='complete',outcome='complete',receipt_version=r,evidence_version=e WHERE id=run_id;
  IF NOT continuum_evidence_eligible(actor,e,NULL) THEN RAISE check_violation USING MESSAGE='Repository evidence unavailable'; END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',q.scope_id,jsonb_build_object('operation','connector_evidence_registered'));
  RETURN jsonb_build_object('receiptVersion',r,'evidenceVersion',e);
END $$;

CREATE FUNCTION continuum_connector_fail(actor UUID,run_id UUID,result TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target_scope UUID;
BEGIN
  IF result IS NULL OR result NOT IN ('denied','unavailable','stale','budget','timeout') THEN RAISE check_violation USING MESSAGE='Invalid connector outcome'; END IF;
  UPDATE connector_query_runs SET state='complete',outcome=result WHERE id=run_id AND connector_query_runs.actor=$1 AND state='pending'
    RETURNING scope_id INTO target_scope;
  IF FOUND THEN INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',target_scope,
    jsonb_build_object('operation','connector_query_outcome','outcome',result)); END IF;
END $$;

CREATE FUNCTION continuum_connector_dependencies(actor UUID,version UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSONB;
BEGIN
  PERFORM continuum_evidence_lock(actor,ARRAY[version]);
  IF NOT EXISTS(SELECT 1 FROM evidence_versions v WHERE id=version AND continuum_evidence_can_access(actor,v.scope_id,FALSE))
    OR EXISTS(SELECT 1 FROM evidence_closure c JOIN evidence_roots r ON r.id=c.root_id WHERE c.version_id=version
      AND (r.revoked OR r.generation<>c.generation OR NOT continuum_evidence_can_access(actor,r.scope_id,FALSE))) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM evidence_closure c JOIN connector_query_runs q ON q.id=c.root_id WHERE c.version_id=version
    AND (q.actor IS DISTINCT FROM $1 OR q.state<>'complete' OR q.expires_at<=clock_timestamp())) THEN RETURN NULL; END IF;
  SELECT jsonb_agg(jsonb_build_object('runId',q.id,'mapping',continuum_connector_mapping($1,q.mapping_id),
    'bytes',(SELECT octet_length(payload) FROM evidence_payloads WHERE version_id=$2)) ORDER BY q.id)
    INTO result FROM evidence_closure c JOIN connector_query_runs q ON q.id=c.root_id WHERE c.version_id=version;
  RETURN result;
END $$;

CREATE FUNCTION continuum_connector_scope_is_erased(target_scope UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NOT EXISTS(SELECT 1 FROM connector_repository_mappings WHERE scope_id=target_scope AND (repository IS NOT NULL OR enabled))
    AND NOT EXISTS(SELECT 1 FROM connector_query_runs WHERE scope_id=target_scope AND (actor IS NOT NULL OR mapping_id IS NOT NULL OR state<>'cancelled'));
$$;
CREATE FUNCTION continuum_operator_scrub_connector_scope(actor UUID,subject UUID,target_scope UUID,page_limit INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE item RECORD; processed INTEGER:=0; clean BOOLEAN;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  PERFORM * FROM continuum_operator_coordination_scope_privacy_state(actor,target_scope);
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 1000 OR NOT EXISTS(SELECT 1 FROM principal_user_scopes
    WHERE principal_id=subject AND scope_id=target_scope) OR NOT EXISTS(SELECT 1 FROM principal_offboarding_runs
    WHERE principal_id=subject AND scope_id=target_scope) THEN RAISE insufficient_privilege USING MESSAGE='Connector erasure requires approved lifecycle'; END IF;
  FOR item IN SELECT id FROM connector_repository_mappings WHERE scope_id=target_scope AND (repository IS NOT NULL OR enabled)
    ORDER BY id LIMIT page_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE connector_repository_mappings SET repository=NULL,enabled=FALSE,generation=generation+1 WHERE id=item.id; processed:=processed+1;
  END LOOP;
  FOR item IN SELECT q.id,q.workflow_id FROM connector_query_runs q WHERE q.scope_id=target_scope
    AND (q.actor IS NOT NULL OR q.mapping_id IS NOT NULL OR q.state<>'cancelled') ORDER BY q.id LIMIT page_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE pipeline_budget_workflows SET cancelled=TRUE,generation=generation+1 WHERE id=item.workflow_id AND NOT cancelled;
    UPDATE connector_query_runs SET actor=NULL,mapping_id=NULL,state='cancelled',permit_xid=NULL,permit_until=NULL WHERE id=item.id; processed:=processed+1;
  END LOOP;
  clean:=continuum_connector_scope_is_erased(target_scope);
  -- Existing protected canonical evidence erasure supplies the immutable privacy
  -- receipt. This companion audit contains no subject or repository identifiers.
  IF processed>0 THEN INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'archive',target_scope,
    jsonb_build_object('operation','connector_privacy_scrub','processed',processed)); END IF;
  RETURN jsonb_build_object('complete',clean,'processed',processed,'batch_full',NOT clean AND processed>=page_limit);
END $$;
ALTER FUNCTION continuum_offboarding_lifecycle_state_is_erased(UUID) RENAME TO continuum_offboarding_lifecycle_state_is_erased_pre_connector;
CREATE FUNCTION continuum_offboarding_lifecycle_state_is_erased(target_run UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_offboarding_lifecycle_state_is_erased_pre_connector(target_run) AND EXISTS(SELECT 1 FROM principal_offboarding_runs
    WHERE run_id=target_run AND continuum_connector_scope_is_erased(scope_id));
$$;

CREATE TABLE connector_contract_functions(signature TEXT PRIMARY KEY,body_hash TEXT NOT NULL,definer BOOLEAN NOT NULL,volatility "char" NOT NULL);
REVOKE ALL ON connector_contract_functions FROM PUBLIC;
CREATE FUNCTION continuum_connector_is_ready() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_event_is_ready() AND EXISTS(SELECT 1 FROM connector_contract_functions)
    AND NOT EXISTS(SELECT 1 FROM connector_contract_functions c LEFT JOIN pg_proc f ON f.oid=to_regprocedure(c.signature)
      WHERE f.oid IS NULL OR encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>c.body_hash OR f.prosecdef<>c.definer OR f.provolatile<>c.volatility
      OR f.proowner<>(SELECT relowner FROM pg_class WHERE oid='memories'::regclass)
      OR NOT(f.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',(SELECT n.nspname FROM pg_namespace n JOIN pg_class m ON m.relnamespace=n.oid WHERE m.oid='memories'::regclass))])
      OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'));
$$;
DO $$
DECLARE schema_name TEXT:=current_schema(); f RECORD; signature TEXT; definition TEXT; revised TEXT; candidate RECORD;
  app_signatures TEXT[]:=ARRAY['continuum_connector_mapping(uuid,uuid)','continuum_connector_admission(uuid,uuid,bigint,text)',
    'continuum_connector_start(uuid,uuid,uuid,bigint,uuid,uuid,bigint,uuid,uuid,uuid)',
    'continuum_connector_permit(uuid,uuid,bigint,timestamp with time zone,timestamp with time zone,text,text)',
    'continuum_connector_finish(uuid,uuid,jsonb,text)','continuum_connector_fail(uuid,uuid,text)','continuum_connector_dependencies(uuid,uuid)','continuum_connector_is_ready()'];
  op_signatures TEXT[]:=ARRAY['continuum_operator_connector_mapping(uuid,uuid,uuid,text,text,text,text,boolean)',
    'continuum_operator_scrub_connector_scope(uuid,uuid,uuid,integer)'];
BEGIN
  FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=quote_ident(schema_name)::regnamespace
    AND (proname LIKE 'continuum_connector_%' OR proname LIKE 'continuum_operator_connector_%'
      OR proname IN ('continuum_operator_scrub_connector_scope','continuum_evidence_eligible','continuum_evidence_eligible_pre_connector',
        'continuum_offboarding_lifecycle_state_is_erased','continuum_offboarding_lifecycle_state_is_erased_pre_connector')) LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',f.signature,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
  -- Renaming preserves explicit ACLs. The old gate must never remain an APP
  -- bypass; only the new wrapper is public to valid upgraded profiles.
  FOR f IN SELECT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
    JOIN pg_roles r ON r.oid=acl.grantee WHERE p.oid='continuum_evidence_eligible_pre_connector(uuid,uuid,text)'::regprocedure
      AND acl.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION continuum_evidence_eligible_pre_connector(uuid,uuid,text) FROM %I',f.rolname);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['continuum_assert_application_role_allowlist(name,boolean)','continuum_assert_standup_application_role_allowlist(name,boolean)'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'(''continuum_standup_is_ready()'')','(''continuum_standup_is_ready()''),('''||replace(array_to_string(app_signatures,'''),('''),' ','')||''')');
    revised:=replace(revised,'(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'')',
      '(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)''),('''||replace(array_to_string(op_signatures,'''),('''),' ','')||''')');
    IF revised=definition THEN RAISE EXCEPTION 'unable to extend connector allowlist'; END IF;
    EXECUTE revised;
  END LOOP;
  FOR candidate IN SELECT * FROM continuum_connector_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    FOREACH signature IN ARRAY app_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name); END LOOP;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_evidence_eligible(uuid,uuid,text) TO %I',schema_name,candidate.role_name);
    IF candidate.operator THEN FOREACH signature IN ARRAY op_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name); END LOOP; END IF;
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END $$;
-- Existing readiness ledgers must follow the reviewed forward wrappers.
UPDATE evidence_contract_functions c SET body_hash=encode(sha256(convert_to(f.prosrc,'UTF8')),'hex'),definer=f.prosecdef,volatility=f.provolatile
  FROM pg_proc f WHERE f.oid=to_regprocedure(c.signature);
UPDATE extraction_contract_functions c SET body_hash=encode(sha256(convert_to(f.prosrc,'UTF8')),'hex'),definer=f.prosecdef,volatility=f.provolatile
  FROM pg_proc f WHERE f.oid=to_regprocedure(c.signature);
INSERT INTO connector_contract_functions SELECT oid::regprocedure::text,encode(sha256(convert_to(prosrc,'UTF8')),'hex'),prosecdef,provolatile
  FROM pg_proc WHERE pronamespace=quote_ident(current_schema())::regnamespace
    AND (proname LIKE 'continuum_connector_%' OR proname LIKE 'continuum_operator_connector_%'
      OR proname IN ('continuum_operator_scrub_connector_scope','continuum_evidence_eligible','continuum_evidence_eligible_pre_connector',
        'continuum_offboarding_lifecycle_state_is_erased','continuum_offboarding_lifecycle_state_is_erased_pre_connector'));
