-- Optional maintained briefs. Empty registry, no provider or scheduler enabled.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
  IF continuum_connector_is_ready() IS NOT TRUE OR EXISTS(
    SELECT 1 FROM (SELECT * FROM evidence_contract_functions UNION ALL SELECT * FROM extraction_contract_functions
      UNION ALL SELECT * FROM memory_event_contract_functions UNION ALL SELECT * FROM connector_contract_functions) c
    LEFT JOIN pg_proc f ON f.oid=to_regprocedure(c.signature)
    WHERE f.oid IS NULL OR encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>c.body_hash
      OR f.prosecdef<>c.definer OR f.provolatile<>c.volatility
      OR f.proowner<>(SELECT relowner FROM pg_class WHERE oid='memories'::regclass)
      OR NOT COALESCE(f.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',current_schema())],FALSE)
      OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))
  THEN RAISE EXCEPTION 'brief predecessor integrity unavailable'; END IF;
END $$;
CREATE TEMP TABLE continuum_brief_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT p.*,s.rolname FROM continuum_pgvector_role_profiles p JOIN pg_roles s ON s.oid=p.database_role_oid
    WHERE profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(r.rolname,r.profile_kind='operator');
      INSERT INTO continuum_brief_upgrade_roles VALUES(r.database_role_oid,r.rolname,r.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Continuum skipped brief grants for role OID % (SQLSTATE %); explicit regrant required',r.database_role_oid,SQLSTATE; END;
  END LOOP;
END $$;

CREATE TABLE brief_profiles(id TEXT PRIMARY KEY,descriptor JSONB NOT NULL,enabled BOOLEAN NOT NULL,generation BIGINT NOT NULL CHECK(generation>0));
CREATE TABLE brief_scope_epochs(scope_id UUID PRIMARY KEY REFERENCES scopes(id),generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0));
CREATE TABLE brief_definitions(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),scope_id UUID UNIQUE NOT NULL REFERENCES scopes(id),
  profile TEXT NOT NULL REFERENCES brief_profiles(id),enabled BOOLEAN NOT NULL,generation BIGINT NOT NULL DEFAULT 1,
  head UUID,anchor_version UUID NOT NULL REFERENCES evidence_versions(id));
CREATE TABLE brief_worker_bindings(
  role_oid OID NOT NULL,role_name NAME NOT NULL,principal_id UUID NOT NULL REFERENCES principals(id),scope_id UUID NOT NULL REFERENCES scopes(id),
  profile TEXT NOT NULL REFERENCES brief_profiles(id),generation UUID NOT NULL,enabled BOOLEAN NOT NULL,
  PRIMARY KEY(role_oid,scope_id,profile),UNIQUE(role_name,scope_id,profile));
CREATE TABLE brief_runs(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),definition_id UUID NOT NULL REFERENCES brief_definitions(id),
  request_key TEXT NOT NULL CHECK(length(request_key)<=128),mode TEXT NOT NULL CHECK(mode IN ('full','delta')),dry_run BOOLEAN NOT NULL,
  config_generation BIGINT NOT NULL,profile_generation BIGINT NOT NULL,descriptor JSONB NOT NULL,expected_head UUID,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','complete','unavailable','cancelled')),
  reason TEXT CHECK(reason IN ('policy','budget','invalid-output','ambiguous','cancelled','deadline','stale','provider')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),cutoff TIMESTAMPTZ,observed JSONB,watermark JSONB,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,sections TEXT[] NOT NULL DEFAULT ARRAY['purpose','decisions','implementation','unknowns','coverage'],
  workflow_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),budget_owner UUID NOT NULL DEFAULT gen_random_uuid(),budget_generation BIGINT NOT NULL DEFAULT 1,
  attempt_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),login_oid OID,binding_generation UUID,owner UUID,generation BIGINT NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,deadline_at TIMESTAMPTZ,result_version UUID,
  UNIQUE(definition_id,request_key));
CREATE INDEX brief_runs_pending_idx ON brief_runs(definition_id,created_at,id) WHERE state IN ('queued','running');
CREATE TABLE brief_run_inputs(run_id UUID NOT NULL REFERENCES brief_runs(id),version_id UUID NOT NULL REFERENCES evidence_versions(id),
  root_id UUID NOT NULL REFERENCES evidence_roots(id),bytes INTEGER NOT NULL CHECK(bytes>=0),PRIMARY KEY(run_id,version_id));
CREATE INDEX brief_inputs_version_idx ON brief_run_inputs(version_id,run_id);
CREATE TABLE brief_versions(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),definition_id UUID NOT NULL REFERENCES brief_definitions(id),run_id UUID UNIQUE NOT NULL REFERENCES brief_runs(id),
  previous_version UUID REFERENCES brief_versions(id),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),cutoff TIMESTAMPTZ NOT NULL,
  observed JSONB NOT NULL,watermark JSONB,truncated BOOLEAN NOT NULL,config_generation BIGINT NOT NULL,profile_generation BIGINT NOT NULL,
  anchor_version UUID NOT NULL REFERENCES evidence_versions(id));
ALTER TABLE brief_definitions ADD CONSTRAINT brief_head_fk FOREIGN KEY(head) REFERENCES brief_versions(id);
ALTER TABLE brief_runs ADD CONSTRAINT brief_result_fk FOREIGN KEY(result_version) REFERENCES brief_versions(id);
CREATE INDEX brief_versions_history_idx ON brief_versions(definition_id,created_at DESC,id DESC);
CREATE TABLE brief_blocks(version_id UUID NOT NULL REFERENCES brief_versions(id),block_id TEXT NOT NULL CHECK(block_id~'^[0-9a-f]{64}$'),
  section TEXT NOT NULL CHECK(section IN ('purpose','decisions','implementation','unknowns','coverage')),
  evidence_version UUID NOT NULL REFERENCES evidence_versions(id),PRIMARY KEY(version_id,block_id));
CREATE INDEX brief_blocks_evidence_idx ON brief_blocks(evidence_version,version_id);
CREATE TABLE brief_dispatch_receipts(attempt_id UUID PRIMARY KEY REFERENCES brief_runs(attempt_id));
CREATE TRIGGER brief_version_immutable BEFORE UPDATE OR DELETE ON brief_versions FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE TRIGGER brief_dispatch_immutable BEFORE UPDATE OR DELETE ON brief_dispatch_receipts FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE FUNCTION continuum_brief_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.id,NEW.definition_id,NEW.request_key,NEW.mode,NEW.dry_run,NEW.config_generation,NEW.profile_generation,NEW.descriptor,
    NEW.expected_head,NEW.workflow_id,NEW.budget_owner,NEW.budget_generation,NEW.attempt_id,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.definition_id,OLD.request_key,OLD.mode,OLD.dry_run,OLD.config_generation,OLD.profile_generation,OLD.descriptor,
    OLD.expected_head,OLD.workflow_id,OLD.budget_owner,OLD.budget_generation,OLD.attempt_id,OLD.created_at)
    OR (OLD.deadline_at IS NOT NULL AND NEW.deadline_at IS DISTINCT FROM OLD.deadline_at)
    OR (OLD.login_oid IS NOT NULL AND (NEW.login_oid,NEW.binding_generation) IS DISTINCT FROM (OLD.login_oid,OLD.binding_generation))
  THEN RAISE check_violation USING MESSAGE='brief original identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER brief_run_identity BEFORE UPDATE ON brief_runs FOR EACH ROW EXECUTE FUNCTION continuum_brief_identity();
REVOKE ALL ON brief_profiles,brief_scope_epochs,brief_definitions,brief_worker_bindings,brief_runs,brief_run_inputs,brief_versions,brief_blocks,brief_dispatch_receipts FROM PUBLIC;

CREATE FUNCTION continuum_brief_valid_descriptor(d JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE probe JSONB;
BEGIN
  IF d->>'schema' IS DISTINCT FROM 'project-brief-v1' OR d->>'prompt' IS DISTINCT FROM 'brief-reference-v1'
    OR NOT(d ? 'qualification') OR d->'qualification'->>'kind' IS NULL
    OR d->'qualification'->>'kind' NOT IN ('synthetic-only','operator-qualified')
    OR (d->'qualification'->>'kind'='synthetic-only' AND d->>'locality' IS DISTINCT FROM 'local')
    OR (d->'qualification'->>'kind'='operator-qualified' AND COALESCE(d->'qualification'->>'reportSha256','')!~'^[0-9a-f]{64}$')
    OR (d->'budget'->'limits'->>'spendMicros')::numeric IS DISTINCT FROM 0::numeric
    OR d->'price'->>'id' IS DISTINCT FROM 'local-zero-v1' OR d->'budget'->>'rateSchedule' IS DISTINCT FROM 'local-zero-v1'
    OR (d->'price'->>'inputMicros')::numeric IS DISTINCT FROM 0::numeric
    OR (d->'price'->>'outputMicros')::numeric IS DISTINCT FROM 0::numeric
    OR (d->'price'->>'reasoningMicros')::numeric IS DISTINCT FROM 0::numeric THEN RETURN FALSE; END IF;
  -- Reuse the reviewed complete accounting descriptor validator, with only its
  -- extraction-specific schema/chunk fields substituted. No extraction queue dependency.
  probe:=(d-'qualification')||jsonb_build_object('schema','extraction-v1','prompt','source-reference-v1','chunkBytes',65536,'maxChunks',1);
  RETURN continuum_extraction_valid_descriptor(probe) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;
CREATE FUNCTION continuum_operator_install_brief_profile(actor UUID,descriptor JSONB,enable BOOLEAN) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF enable IS NULL OR continuum_brief_valid_descriptor(descriptor) IS NOT TRUE THEN RAISE check_violation USING MESSAGE='brief profile unavailable'; END IF;
  INSERT INTO brief_profiles VALUES(descriptor->>'id',descriptor,enable,1) ON CONFLICT(id) DO UPDATE SET
    descriptor=EXCLUDED.descriptor,enabled=EXCLUDED.enabled,generation=CASE WHEN (brief_profiles.descriptor,brief_profiles.enabled)
      IS NOT DISTINCT FROM (EXCLUDED.descriptor,EXCLUDED.enabled) THEN brief_profiles.generation ELSE brief_profiles.generation+1 END;
  INSERT INTO audit_log(principal_id,action,metadata) VALUES(actor,'write','{"operation":"brief_profile_installed"}');
END $$;
CREATE FUNCTION continuum_brief_authorize(actor UUID,target_scope UUID,writing BOOLEAN) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
BEGIN
  PERFORM id FROM principals WHERE id=actor FOR SHARE;
  PERFORM principal_id FROM scope_memberships WHERE principal_id=actor AND scope_id=target_scope FOR SHARE;
  PERFORM singleton FROM entra_sync_state WHERE singleton FOR SHARE;
  IF writing IS NULL OR NOT EXISTS(SELECT 1 FROM scopes WHERE id=target_scope AND kind='project')
    OR NOT continuum_evidence_can_access(actor,target_scope,writing) THEN RAISE insufficient_privilege USING MESSAGE='Brief unavailable'; END IF;
END $$;
CREATE FUNCTION continuum_brief_configure(actor UUID,target_scope UUID,profile_id TEXT,enable BOOLEAN) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE d brief_definitions%ROWTYPE; node UUID; version UUID;
BEGIN
  PERFORM continuum_brief_authorize(actor,target_scope,TRUE);
  IF NOT continuum_extraction_scope_admin(actor,target_scope) THEN RAISE insufficient_privilege USING MESSAGE='Brief administration unavailable'; END IF;
  IF enable IS NULL OR NOT EXISTS(SELECT 1 FROM brief_profiles WHERE id=profile_id AND (enabled OR NOT enable)) THEN RAISE check_violation USING MESSAGE='Brief profile unavailable'; END IF;
  SELECT * INTO d FROM brief_definitions WHERE scope_id=target_scope FOR UPDATE;
  IF d.id IS NULL THEN
    node:=gen_random_uuid(); version:=gen_random_uuid();
    INSERT INTO evidence_roots(id,scope_id) VALUES(node,target_scope);
    INSERT INTO evidence_versions(id,root_id,scope_id,kind,provenance,depth,root_count,parent_count)
      VALUES(version,node,target_scope,'brief-section-version','{"schema":"brief-policy-anchor-v1"}',0,1,0);
    INSERT INTO evidence_closure VALUES(version,node,1); INSERT INTO evidence_state(version_id) VALUES(version);
    INSERT INTO evidence_payloads VALUES(version,'{}',encode(sha256(convert_to('{}','UTF8')),'hex'));
    UPDATE evidence_roots SET current_version=version WHERE id=node;
    INSERT INTO brief_definitions(scope_id,profile,enabled,anchor_version) VALUES(target_scope,profile_id,enable,version) RETURNING * INTO d;
  ELSE
    UPDATE brief_definitions SET profile=profile_id,enabled=enable,generation=generation+CASE WHEN (profile,enabled) IS DISTINCT FROM (profile_id,enable) THEN 1 ELSE 0 END
      WHERE id=d.id RETURNING * INTO d;
  END IF;
  INSERT INTO brief_scope_epochs(scope_id) VALUES(target_scope),(continuum_org_scope_id()) ON CONFLICT DO NOTHING;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',target_scope,jsonb_build_object('operation','brief_configured','enabled',enable));
  RETURN jsonb_build_object('id',d.id,'enabled',d.enabled,'profile',d.profile,'generation',d.generation);
END $$;

-- Transactional row generations, never allocation-order MAX or timestamp cursors.
-- Only enrolled project/org scopes incur this work. An epoch lock serializes
-- commits, so a delayed lower-sequence writer cannot disappear behind a frontier.
CREATE FUNCTION continuum_brief_touch(target_scope UUID) RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE brief_scope_epochs SET generation=generation+1 WHERE scope_id=target_scope;
$$;
CREATE FUNCTION continuum_brief_source_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
BEGIN
  IF TG_TABLE_NAME='memories' THEN
    IF TG_OP<>'INSERT' THEN PERFORM continuum_brief_touch(OLD.scope_id); END IF;
    IF TG_OP<>'DELETE' AND (TG_OP='INSERT' OR NEW.scope_id IS DISTINCT FROM OLD.scope_id) THEN PERFORM continuum_brief_touch(NEW.scope_id); END IF;
  ELSE
    IF NEW.source_memory_id IS NOT NULL OR EXISTS(SELECT 1 FROM evidence_versions WHERE id=NEW.current_version AND kind='extracted-assertion') THEN
      PERFORM continuum_brief_touch(NEW.scope_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER brief_memory_changed AFTER INSERT OR UPDATE OR DELETE ON memories FOR EACH ROW EXECUTE FUNCTION continuum_brief_source_changed();
CREATE TRIGGER brief_root_changed AFTER INSERT OR UPDATE ON evidence_roots FOR EACH ROW EXECUTE FUNCTION continuum_brief_source_changed();
CREATE FUNCTION continuum_brief_event_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
BEGIN
  PERFORM continuum_brief_touch(scope_id) FROM memories WHERE id=NEW.memory_id;
  RETURN NULL;
END $$;
CREATE TRIGGER brief_event_changed AFTER INSERT OR UPDATE ON memory_event_current FOR EACH ROW EXECUTE FUNCTION continuum_brief_event_changed();
CREATE FUNCTION continuum_brief_frontier(target_scope UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE result JSONB;
BEGIN
  PERFORM scope_id FROM brief_scope_epochs WHERE scope_id IN (target_scope,continuum_org_scope_id()) ORDER BY scope_id FOR SHARE;
  SELECT jsonb_object_agg(scope_id::text,generation) INTO result FROM brief_scope_epochs WHERE scope_id IN (target_scope,continuum_org_scope_id());
  RETURN result;
END $$;
CREATE FUNCTION continuum_brief_audience(actor UUID,version UUID,target_scope UUID,locality TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT continuum_evidence_eligible(actor,version,locality) AND NOT EXISTS(
    SELECT 1 FROM evidence_closure c JOIN evidence_roots r ON r.id=c.root_id
    WHERE c.version_id=version AND (r.scope_id NOT IN (target_scope,continuum_org_scope_id())
      OR EXISTS(SELECT 1 FROM memory_activity_attributions a WHERE a.memory_id=r.source_memory_id)
      OR EXISTS(SELECT 1 FROM connector_query_runs q WHERE q.id=r.id)));
$$;
CREATE FUNCTION continuum_brief_enqueue(definition UUID,key TEXT,refresh_mode TEXT,dry BOOLEAN) RETURNS brief_runs LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE d brief_definitions%ROWTYPE; p brief_profiles%ROWTYPE; r brief_runs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT d FROM brief_definitions WHERE id=definition FOR UPDATE;
  SELECT * INTO STRICT p FROM brief_profiles WHERE id=d.profile FOR SHARE;
  IF NOT d.enabled OR NOT p.enabled OR key IS NULL OR length(key)>128 OR refresh_mode IS NULL OR refresh_mode NOT IN ('full','delta') OR dry IS NULL THEN
    RAISE check_violation USING MESSAGE='Brief refresh unavailable'; END IF;
  INSERT INTO brief_runs(definition_id,request_key,mode,dry_run,config_generation,profile_generation,descriptor,expected_head)
    VALUES(d.id,key,refresh_mode,dry,d.generation,p.generation,p.descriptor,d.head) ON CONFLICT(definition_id,request_key) DO NOTHING;
  SELECT * INTO STRICT r FROM brief_runs WHERE definition_id=d.id AND request_key=key;
  IF (r.mode,r.dry_run) IS DISTINCT FROM (refresh_mode,dry) THEN RAISE check_violation USING MESSAGE='Brief idempotency conflict'; END IF;
  RETURN r;
END $$;
CREATE FUNCTION continuum_brief_refresh(actor UUID,project_name TEXT,refresh_mode TEXT,dry BOOLEAN,key TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE d brief_definitions%ROWTYPE; r brief_runs%ROWTYPE; target_scope UUID;
BEGIN
  SELECT id INTO target_scope FROM scopes WHERE kind='project' AND name=project_name;
  PERFORM continuum_brief_authorize(actor,target_scope,TRUE);
  SELECT * INTO STRICT d FROM brief_definitions WHERE scope_id=target_scope;
  r:=continuum_brief_enqueue(d.id,encode(sha256(convert_to(key,'UTF8')),'hex'),refresh_mode,dry);
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',target_scope,'{"operation":"brief_refresh_requested"}');
  RETURN jsonb_build_object('runId',r.id,'status',r.state,'dryRun',r.dry_run,'version',r.result_version);
END $$;

CREATE FUNCTION continuum_brief_worker_signatures() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
  'continuum_brief_claim(text,uuid,jsonb)','continuum_brief_hydrate(uuid,uuid,bigint)',
  'continuum_brief_budget(uuid,uuid,bigint,text,jsonb,bigint)','continuum_brief_apply(uuid,uuid,bigint,jsonb)',
  'continuum_brief_stop(uuid,uuid,bigint,text)','continuum_brief_is_ready()']::text[] $$;
CREATE FUNCTION continuum_brief_assert_worker(database_role NAME) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE role_id OID; owner_id OID:=(SELECT relowner FROM pg_class WHERE oid='memories'::regclass); schema_id OID:=(SELECT relnamespace FROM pg_class WHERE oid='memories'::regclass);
BEGIN
  SELECT oid INTO role_id FROM pg_roles WHERE rolname=database_role AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
    AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls;
  IF role_id IS NULL OR role_id=owner_id OR EXISTS(SELECT 1 FROM pg_auth_members edge WHERE (edge.member=role_id OR edge.roleid=role_id)
    AND NOT(edge.roleid=role_id AND edge.member=owner_id AND edge.admin_option AND NOT edge.set_option AND NOT edge.inherit_option))
    OR EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=role_id)
    OR EXISTS(SELECT 1 FROM pg_parameter_acl p,aclexplode(p.paracl) a WHERE a.grantee=role_id)
    OR NOT has_schema_privilege(role_id,schema_id,'USAGE') OR has_schema_privilege(role_id,schema_id,'CREATE')
    OR EXISTS(SELECT 1 FROM unnest(continuum_brief_worker_signatures()) signature WHERE NOT has_function_privilege(role_id,to_regprocedure(signature),'EXECUTE'))
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=schema_id AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(role_id,c.oid,'USAGE,SELECT,UPDATE')
      WHEN c.relkind IN ('r','v','m','p','f') THEN has_table_privilege(role_id,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE FALSE END)
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=schema_id AND (c.relowner=role_id OR EXISTS(
      SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a WHERE a.grantee=role_id)))
    OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace=schema_id AND a.attacl IS NOT NULL
      AND EXISTS(SELECT 1 FROM aclexplode(a.attacl) grant_entry WHERE grant_entry.grantee=role_id))
    OR EXISTS(SELECT 1 FROM pg_proc f WHERE f.pronamespace=schema_id AND (f.proowner=role_id OR (has_function_privilege(role_id,f.oid,'EXECUTE')
      AND NOT f.oid=ANY(SELECT to_regprocedure(signature) FROM unnest(continuum_brief_worker_signatures()) signature)
      AND NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.objid=f.oid AND d.deptype='e' AND e.extname='vector')))) THEN
    RAISE insufficient_privilege USING MESSAGE='brief worker requires an isolated exact LOGIN profile';
  END IF;
END $$;
CREATE FUNCTION continuum_operator_bind_brief_worker(actor UUID,database_role NAME,worker_principal UUID,target_scope UUID,profile_id TEXT,enable BOOLEAN) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE role_id OID;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF enable IS NULL THEN RAISE check_violation USING MESSAGE='invalid brief binding'; END IF;
  IF enable THEN
    PERFORM continuum_brief_assert_worker(database_role);
    SELECT oid INTO STRICT role_id FROM pg_roles WHERE rolname=database_role;
    PERFORM id FROM principals WHERE id=worker_principal AND kind='service' AND disabled_at IS NULL FOR SHARE;
    IF NOT FOUND OR NOT continuum_evidence_can_access(worker_principal,target_scope,TRUE)
      OR NOT EXISTS(SELECT 1 FROM brief_profiles WHERE id=profile_id AND enabled) THEN RAISE insufficient_privilege USING MESSAGE='brief binding unavailable'; END IF;
    INSERT INTO brief_worker_bindings VALUES(role_id,database_role,worker_principal,target_scope,profile_id,gen_random_uuid(),TRUE)
      ON CONFLICT(role_oid,scope_id,profile) DO UPDATE SET role_name=EXCLUDED.role_name,principal_id=EXCLUDED.principal_id,generation=EXCLUDED.generation,enabled=TRUE;
  ELSE
    UPDATE brief_worker_bindings SET enabled=FALSE,generation=gen_random_uuid() WHERE role_name=database_role AND scope_id=target_scope AND profile=profile_id;
    IF NOT FOUND THEN RAISE check_violation USING MESSAGE='brief binding unavailable'; END IF;
  END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',target_scope,jsonb_build_object('operation','brief_worker_bound','enabled',enable));
END $$;

CREATE FUNCTION continuum_brief_binding(target_scope UUID,profile_id TEXT) RETURNS brief_worker_bindings LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE binding brief_worker_bindings%ROWTYPE;
BEGIN
  PERFORM continuum_brief_assert_worker(session_user);
  SELECT b.* INTO binding FROM brief_worker_bindings b JOIN pg_roles role ON role.oid=b.role_oid AND role.rolname=b.role_name
    WHERE role.rolname=session_user AND b.scope_id=target_scope AND b.profile=profile_id AND b.enabled FOR SHARE OF b;
  IF binding.role_oid IS NULL OR NOT continuum_evidence_can_access(binding.principal_id,target_scope,TRUE) THEN
    RAISE insufficient_privilege USING MESSAGE='brief worker unavailable'; END IF;
  RETURN binding;
END $$;

CREATE FUNCTION continuum_brief_charge(workflow UUID,delta JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE w pipeline_budget_workflows%ROWTYPE; k TEXT;
BEGIN
  SELECT * INTO STRICT w FROM pipeline_budget_workflows WHERE id=workflow FOR UPDATE;
  IF w.cancelled OR w.deadline_at<=clock_timestamp() THEN RAISE check_violation USING MESSAGE='Brief allowance unavailable'; END IF;
  FOR k IN SELECT jsonb_object_keys(delta) LOOP
    IF NOT(w.used ? k) OR (delta->>k)::numeric<0 OR (delta->>k)::numeric+(w.used->>k)::numeric>(w.profile->'limits'->>k)::numeric THEN
      RAISE program_limit_exceeded USING MESSAGE='Brief allowance unavailable'; END IF;
    w.used:=jsonb_set(w.used,ARRAY[k],to_jsonb((w.used->>k)::bigint+(delta->>k)::bigint));
  END LOOP;
  UPDATE pipeline_budget_workflows SET used=w.used WHERE id=workflow;
END $$;
CREATE FUNCTION continuum_brief_gate(run_id UUID,worker UUID,epoch BIGINT,disclosure BOOLEAN) RETURNS brief_runs LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE j brief_runs%ROWTYPE; d brief_definitions%ROWTYPE; b brief_worker_bindings%ROWTYPE; ids UUID[];
BEGIN
  SELECT * INTO STRICT j FROM brief_runs WHERE id=run_id FOR UPDATE;
  SELECT * INTO STRICT d FROM brief_definitions WHERE id=j.definition_id FOR UPDATE;
  b:=continuum_brief_binding(d.scope_id,d.profile);
  SELECT array_append(COALESCE(array_agg(version_id ORDER BY version_id),'{}'),d.anchor_version) INTO ids FROM brief_run_inputs WHERE brief_run_inputs.run_id=j.id;
  PERFORM continuum_evidence_lock(b.principal_id,ids,d.scope_id);
  PERFORM id FROM brief_profiles WHERE id=d.profile FOR SHARE;
  IF j.state<>'running' OR j.owner IS DISTINCT FROM worker OR j.generation IS DISTINCT FROM epoch
    OR j.login_oid IS DISTINCT FROM b.role_oid OR j.binding_generation IS DISTINCT FROM b.generation
    OR j.lease_until<=clock_timestamp() OR NOT d.enabled OR d.generation<>j.config_generation
    OR d.head IS DISTINCT FROM j.expected_head OR NOT EXISTS(SELECT 1 FROM brief_profiles WHERE id=d.profile AND enabled
      AND generation=j.profile_generation AND descriptor=j.descriptor)
    OR EXISTS(SELECT 1 FROM unnest(ids) v WHERE NOT continuum_brief_audience(b.principal_id,v,d.scope_id,CASE WHEN disclosure THEN j.descriptor->>'locality' END))
    OR (j.observed IS NOT NULL AND j.observed IS DISTINCT FROM continuum_brief_frontier(d.scope_id))
    OR NOT EXISTS(SELECT 1 FROM pipeline_budget_workflows WHERE id=j.workflow_id AND owner=j.budget_owner AND generation=j.budget_generation
      AND NOT cancelled AND deadline_at=j.deadline_at AND deadline_at>clock_timestamp()) THEN RAISE check_violation USING MESSAGE='Brief work unavailable'; END IF;
  RETURN j;
END $$;

CREATE FUNCTION continuum_brief_claim(profile_id TEXT,worker UUID,descriptor JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE j brief_runs%ROWTYPE; d brief_definitions%ROWTYPE; b brief_worker_bindings%ROWTYPE; item RECORD; v UUID; n INTEGER:=0;
  bytes BIGINT:=0; frontier_value JSONB; prior JSONB; dirty TEXT[]; all_sections TEXT[]:=ARRAY['purpose','decisions','implementation','unknowns','coverage'];
BEGIN
  PERFORM continuum_brief_assert_worker(session_user);
  IF worker IS NULL THEN RAISE check_violation USING MESSAGE='Brief worker unavailable'; END IF;
  -- One bounded typed repair enqueue. No timer, arbitrary executor or per-source
  -- fanout in the writer. Unfinished scope generations remain discoverable.
  SELECT def.* INTO d FROM brief_definitions def JOIN brief_worker_bindings binding ON binding.scope_id=def.scope_id AND binding.profile=def.profile
    JOIN pg_roles role ON role.oid=binding.role_oid AND role.rolname=binding.role_name JOIN brief_versions h ON h.id=def.head
    WHERE role.rolname=session_user AND binding.enabled AND def.enabled AND def.profile=profile_id
      AND continuum_evidence_can_access(binding.principal_id,def.scope_id,TRUE)
      AND (h.truncated OR h.observed IS DISTINCT FROM (SELECT jsonb_object_agg(scope_id::text,generation) FROM brief_scope_epochs WHERE scope_id IN(def.scope_id,continuum_org_scope_id()))
        OR EXISTS(SELECT 1 FROM brief_run_inputs i WHERE i.run_id=h.run_id AND NOT continuum_brief_audience(binding.principal_id,i.version_id,def.scope_id,NULL)))
      AND NOT EXISTS(SELECT 1 FROM brief_runs r WHERE r.definition_id=def.id AND r.state IN ('queued','running'))
    ORDER BY def.id LIMIT 1 FOR UPDATE OF def SKIP LOCKED;
  IF d.id IS NOT NULL THEN
    frontier_value:=continuum_brief_frontier(d.scope_id);
    PERFORM continuum_brief_enqueue(d.id,'repair:'||encode(sha256(convert_to(frontier_value::text,'UTF8')),'hex'),'delta',FALSE);
  END IF;
  SELECT r.* INTO j FROM brief_runs r JOIN brief_definitions def ON def.id=r.definition_id JOIN brief_worker_bindings binding ON binding.scope_id=def.scope_id AND binding.profile=def.profile
    JOIN pg_roles role ON role.oid=binding.role_oid AND role.rolname=binding.role_name
    WHERE role.rolname=session_user AND binding.enabled AND continuum_evidence_can_access(binding.principal_id,def.scope_id,TRUE)
      AND def.profile=profile_id AND r.descriptor=continuum_brief_claim.descriptor
      AND (r.state='queued' OR (r.state='running' AND r.lease_until<=clock_timestamp()))
    ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED;
  IF j.id IS NULL THEN RETURN NULL; END IF;
  IF j.state='running' THEN
    UPDATE brief_runs SET state='unavailable',reason='ambiguous',owner=NULL,lease_until=NULL,generation=generation+1 WHERE id=j.id;
    RETURN jsonb_build_object('outcome','unavailable');
  END IF;
  SELECT * INTO STRICT d FROM brief_definitions WHERE id=j.definition_id FOR UPDATE;
  b:=continuum_brief_binding(d.scope_id,d.profile);
  PERFORM continuum_pipeline_create(j.workflow_id,j.budget_owner,j.descriptor->'budget');
  UPDATE brief_runs SET state='running',login_oid=b.role_oid,binding_generation=b.generation,owner=worker,generation=generation+1,
    lease_until=clock_timestamp()+interval '30 seconds',deadline_at=(SELECT deadline_at FROM pipeline_budget_workflows WHERE id=j.workflow_id)
    WHERE id=j.id RETURNING * INTO j;
  -- Attach all original identities before enrollment or payload hydration.
  BEGIN
    PERFORM continuum_brief_gate(j.id,worker,j.generation,TRUE);
    PERFORM continuum_brief_charge(j.workflow_id,jsonb_build_object('storageBytes',32768+2*octet_length(j.descriptor::text),'outputBytes',262144));
    FOR item IN SELECT m.id FROM memories m LEFT JOIN evidence_roots r ON r.source_memory_id=m.id
      WHERE m.scope_id IN(d.scope_id,continuum_org_scope_id()) AND m.state='live' AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM memory_activity_attributions a WHERE a.memory_id=m.id)
        AND (r.id IS NULL OR continuum_brief_audience(b.principal_id,r.current_version,d.scope_id,j.descriptor->>'locality'))
      ORDER BY m.id LIMIT 33 LOOP
      v:=continuum_evidence_source(b.principal_id,item.id);
      IF v IS NULL OR NOT continuum_brief_audience(b.principal_id,v,d.scope_id,j.descriptor->>'locality') THEN CONTINUE; END IF;
      n:=n+1; IF n>32 THEN EXIT; END IF;
      INSERT INTO brief_run_inputs SELECT j.id,e.id,e.root_id,octet_length(p.payload) FROM evidence_versions e JOIN evidence_payloads p ON p.version_id=e.id WHERE e.id=v;
    END LOOP;
    IF n<=32 THEN
      -- Explicit event metadata is separate exact evidence, never inferred from
      -- receipt time or old annotation prose. Its own version is a dependency.
      FOR item IN SELECT e.id,e.root_id,octet_length(p.payload) bytes FROM brief_run_inputs source
        JOIN memory_event_annotations a ON a.source_version=source.version_id JOIN memory_event_current current ON current.version_id=a.version_id
        JOIN evidence_versions e ON e.id=a.version_id JOIN evidence_payloads p ON p.version_id=e.id
        WHERE source.run_id=j.id AND continuum_brief_audience(b.principal_id,e.id,d.scope_id,j.descriptor->>'locality') ORDER BY e.id LIMIT 33 LOOP
        n:=n+1; IF n>32 THEN EXIT; END IF;
        INSERT INTO brief_run_inputs VALUES(j.id,item.id,item.root_id,item.bytes);
      END LOOP;
    END IF;
    IF n<=32 THEN
      FOR item IN SELECT e.id,e.root_id,octet_length(p.payload) bytes FROM evidence_versions e JOIN evidence_roots r ON r.current_version=e.id
        JOIN evidence_payloads p ON p.version_id=e.id WHERE e.kind='extracted-assertion' AND e.scope_id IN(d.scope_id,continuum_org_scope_id())
          AND continuum_brief_audience(b.principal_id,e.id,d.scope_id,j.descriptor->>'locality')
          AND NOT EXISTS(SELECT 1 FROM evidence_closure c JOIN brief_run_inputs i ON i.root_id=c.root_id AND i.run_id=j.id
            JOIN evidence_versions source ON source.id=i.version_id AND source.kind='source-document-version' WHERE c.version_id=e.id)
        ORDER BY e.id LIMIT 33 LOOP
        n:=n+1; IF n>32 THEN EXIT; END IF;
        INSERT INTO brief_run_inputs VALUES(j.id,item.id,item.root_id,item.bytes);
      END LOOP;
    END IF;
    frontier_value:=continuum_brief_frontier(d.scope_id);
    -- New un-enrolled committed sources or a bounded cut leave the processed
    -- frontier incomplete. The observed frontier is never advertised as drained.
    IF EXISTS(SELECT 1 FROM memories m WHERE m.scope_id IN(d.scope_id,continuum_org_scope_id()) AND m.state='live'
      AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM memory_activity_attributions a WHERE a.memory_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM evidence_roots r WHERE r.source_memory_id=m.id)) THEN n:=33; END IF;
    IF EXISTS(SELECT 1 FROM memory_event_current current JOIN memory_event_annotations a ON a.version_id=current.version_id
      JOIN brief_run_inputs source ON source.version_id=a.source_version AND source.run_id=j.id
      WHERE continuum_brief_audience(b.principal_id,a.version_id,d.scope_id,j.descriptor->>'locality')
        AND NOT EXISTS(SELECT 1 FROM brief_run_inputs i WHERE i.run_id=j.id AND i.version_id=a.version_id)) THEN n:=33; END IF;
    SELECT watermark INTO prior FROM brief_versions WHERE id=d.head;
    dirty:=all_sections;
    IF j.mode='delta' AND d.head IS NOT NULL AND EXISTS(SELECT 1 FROM brief_versions h WHERE h.id=d.head
      AND h.config_generation=j.config_generation AND h.profile_generation=j.profile_generation) AND NOT EXISTS(
      (SELECT root_id FROM brief_run_inputs WHERE run_id=j.id EXCEPT SELECT root_id FROM brief_run_inputs WHERE run_id=(SELECT run_id FROM brief_versions WHERE id=d.head))
      UNION ALL (SELECT root_id FROM brief_run_inputs WHERE run_id=(SELECT run_id FROM brief_versions WHERE id=d.head) EXCEPT SELECT root_id FROM brief_run_inputs WHERE run_id=j.id)) THEN
      SELECT COALESCE(array_agg(DISTINCT section),'{}') INTO dirty FROM brief_blocks bb WHERE bb.version_id=d.head AND EXISTS(
        SELECT 1 FROM evidence_closure c JOIN brief_run_inputs old ON old.root_id=c.root_id AND old.run_id=(SELECT run_id FROM brief_versions WHERE id=d.head)
          JOIN brief_run_inputs fresh ON fresh.root_id=old.root_id AND fresh.run_id=j.id WHERE c.version_id=bb.evidence_version AND fresh.version_id<>old.version_id);
      IF EXISTS((SELECT version_id FROM brief_run_inputs WHERE run_id=j.id EXCEPT SELECT version_id FROM brief_run_inputs WHERE run_id=(SELECT run_id FROM brief_versions WHERE id=d.head)))
        OR frontier_value IS DISTINCT FROM (SELECT observed FROM brief_versions WHERE id=d.head) THEN dirty:=array_cat(dirty,ARRAY['unknowns','coverage']); END IF;
      -- Any currently invalid section is recomputed, never copied with stripped citations.
      SELECT ARRAY(SELECT DISTINCT unnest(dirty||COALESCE(array_agg(section) FILTER(WHERE NOT continuum_brief_audience(b.principal_id,evidence_version,d.scope_id,NULL)),'{}')))
        INTO dirty FROM brief_blocks WHERE version_id=d.head;
    END IF;
    SELECT COALESCE(sum(i.bytes),0) INTO bytes FROM brief_run_inputs i WHERE i.run_id=j.id;
    IF EXISTS(SELECT 1 FROM brief_run_inputs i WHERE i.run_id=j.id AND i.bytes>(j.descriptor->'budget'->>'maxItemHydratedBytes')::bigint) THEN
      RAISE program_limit_exceeded USING MESSAGE='Brief input unavailable'; END IF;
    PERFORM continuum_brief_charge(j.workflow_id,jsonb_build_object('candidates',least(n,32),'hydratedBytes',bytes,'storageBytes',bytes));
    UPDATE brief_runs SET cutoff=clock_timestamp(),observed=frontier_value,watermark=CASE WHEN n>32 THEN prior ELSE frontier_value END,
      truncated=n>32,sections=dirty WHERE id=j.id RETURNING * INTO j;
    PERFORM continuum_brief_gate(j.id,worker,j.generation,TRUE);
  EXCEPTION WHEN check_violation OR insufficient_privilege OR program_limit_exceeded THEN
    UPDATE brief_runs SET state='unavailable',reason=CASE WHEN SQLSTATE='54000' THEN 'budget' ELSE 'policy' END,owner=NULL,lease_until=NULL WHERE id=j.id;
    RETURN jsonb_build_object('outcome','unavailable');
  END;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(b.principal_id,'write',d.scope_id,'{"operation":"brief_claimed"}');
  RETURN jsonb_build_object('outcome','claimed','id',j.id,'generation',j.generation,'attemptId',j.attempt_id,'sections',j.sections,
    'remainingMs',greatest(0,floor(extract(epoch FROM(j.deadline_at-clock_timestamp()))*1000)),
    'candidates',least(n,32),'hydratedBytes',bytes,'storageBytes',bytes+32768+2*octet_length(j.descriptor::text));
END $$;

CREATE FUNCTION continuum_brief_hydrate(run_id UUID,worker UUID,epoch BIGINT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE j brief_runs%ROWTYPE; d brief_definitions%ROWTYPE; b brief_worker_bindings%ROWTYPE; result JSONB;
BEGIN
  j:=continuum_brief_gate(run_id,worker,epoch,TRUE);
  SELECT * INTO STRICT d FROM brief_definitions WHERE id=j.definition_id; b:=continuum_brief_binding(d.scope_id,d.profile);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',i.root_id,'version',i.version_id,'family',COALESCE(
    (SELECT min(root_id::text) FROM evidence_closure c JOIN evidence_roots r ON r.id=c.root_id WHERE c.version_id=i.version_id AND r.source_memory_id IS NOT NULL),i.root_id::text),
    'kind',e.kind,'text',p.payload) ORDER BY i.version_id),'[]') INTO result
    FROM brief_run_inputs i JOIN evidence_versions e ON e.id=i.version_id JOIN evidence_payloads p ON p.version_id=i.version_id WHERE i.run_id=j.id;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(b.principal_id,'read',d.scope_id,'{"operation":"brief_inputs_dispatched"}');
  PERFORM continuum_brief_gate(run_id,worker,epoch,TRUE);
  RETURN result;
END $$;
CREATE FUNCTION continuum_brief_budget(run_id UUID,worker UUID,epoch BIGINT,phase TEXT,value JSONB,retained BIGINT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE j brief_runs%ROWTYPE; result BOOLEAN;
BEGIN
  SELECT * INTO STRICT j FROM brief_runs WHERE id=run_id FOR UPDATE;
  IF phase='settle' THEN
    IF j.login_oid IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=session_user) THEN RAISE insufficient_privilege USING MESSAGE='Brief settlement unavailable'; END IF;
    RETURN continuum_pipeline_settle(j.workflow_id,j.attempt_id,j.budget_owner,j.budget_generation,value);
  END IF;
  j:=continuum_brief_gate(run_id,worker,epoch,TRUE);
  IF phase='reserve' THEN RETURN continuum_pipeline_reserve(j.workflow_id,j.attempt_id,j.budget_owner,j.budget_generation,value,retained);
  ELSIF phase='dispatch' THEN
    result:=continuum_pipeline_dispatch(j.workflow_id,j.attempt_id,j.budget_owner,j.budget_generation);
    IF result THEN INSERT INTO brief_dispatch_receipts VALUES(j.attempt_id); END IF; RETURN result;
  ELSIF phase='authorize' THEN RETURN TRUE;
  ELSE RAISE check_violation USING MESSAGE='Brief accounting phase unavailable'; END IF;
END $$;

CREATE FUNCTION continuum_brief_apply(run_id UUID,worker UUID,epoch BIGINT,output JSONB) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE j brief_runs%ROWTYPE; d brief_definitions%ROWTYPE; b brief_worker_bindings%ROWTYPE; claim JSONB; citation JSONB;
  version UUID:=gen_random_uuid(); ev UUID; parent_ids UUID[]; parents JSONB; claim_key TEXT; bytes BIGINT:=0;
BEGIN
  SELECT * INTO STRICT j FROM brief_runs WHERE id=run_id FOR UPDATE;
  -- Ambiguous commit replay returns the same logical result, never reapplies.
  IF j.state='complete' AND j.owner=worker AND j.generation=epoch AND j.login_oid=(SELECT oid FROM pg_roles WHERE rolname=session_user) THEN RETURN j.result_version; END IF;
  j:=continuum_brief_gate(run_id,worker,epoch,FALSE);
  SELECT * INTO STRICT d FROM brief_definitions WHERE id=j.definition_id; b:=continuum_brief_binding(d.scope_id,d.profile);
  IF cardinality(j.sections)>0 AND (NOT EXISTS(SELECT 1 FROM pipeline_budget_attempts WHERE workflow_id=j.workflow_id AND attempt_id=j.attempt_id AND state='settled')
    OR NOT EXISTS(SELECT 1 FROM brief_dispatch_receipts WHERE attempt_id=j.attempt_id)) THEN RAISE check_violation USING MESSAGE='Brief result unsettled'; END IF;
  IF jsonb_typeof(output) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(output))<>1
    OR jsonb_typeof(output->'claims') IS DISTINCT FROM 'array' OR jsonb_array_length(output->'claims')>32 OR octet_length(output::text)>65536
    OR (SELECT count(DISTINCT c) FROM jsonb_array_elements(output->'claims') c)<>jsonb_array_length(output->'claims') THEN
    RAISE check_violation USING MESSAGE='Brief output unavailable'; END IF;
  INSERT INTO brief_versions(id,definition_id,run_id,previous_version,cutoff,observed,watermark,truncated,config_generation,profile_generation,anchor_version)
    VALUES(version,d.id,j.id,d.head,j.cutoff,j.observed,j.watermark,j.truncated,j.config_generation,j.profile_generation,d.anchor_version);
  INSERT INTO brief_blocks SELECT version,bb.block_id,bb.section,bb.evidence_version FROM brief_blocks bb WHERE bb.version_id=d.head AND NOT bb.section=ANY(j.sections);
  FOR claim IN SELECT value FROM jsonb_array_elements(output->'claims') LOOP
    IF jsonb_typeof(claim) IS DISTINCT FROM 'object' OR NOT(claim ?& ARRAY['section','label','text','unknown','contradiction','citations'])
      OR (SELECT count(*) FROM jsonb_object_keys(claim))<>6 OR claim->>'section' IS NULL OR NOT(claim->>'section'=ANY(j.sections))
      OR claim->>'label' IS NULL OR claim->>'label' NOT IN ('recorded_intent','inference')
      OR jsonb_typeof(claim->'text') IS DISTINCT FROM 'string' OR length(claim->>'text') NOT BETWEEN 1 AND 2000
      OR jsonb_typeof(claim->'unknown') IS DISTINCT FROM 'boolean' OR jsonb_typeof(claim->'contradiction') IS DISTINCT FROM 'boolean'
      OR (claim->>'section'='implementation' AND (claim->>'label'<>'inference' OR claim->>'unknown'<>'true'))
      OR jsonb_typeof(claim->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(claim->'citations') NOT BETWEEN 1 AND 8 THEN
      RAISE check_violation USING MESSAGE='Brief claim unavailable'; END IF;
    parent_ids:=ARRAY[d.anchor_version];
    FOR citation IN SELECT value FROM jsonb_array_elements(claim->'citations') LOOP
      IF jsonb_typeof(citation) IS DISTINCT FROM 'object' OR NOT(citation ?& ARRAY['version','quote']) OR (SELECT count(*) FROM jsonb_object_keys(citation))<>2
        OR jsonb_typeof(citation->'quote') IS DISTINCT FROM 'string' OR length(citation->>'quote') NOT BETWEEN 1 AND 1000
        OR NOT EXISTS(SELECT 1 FROM brief_run_inputs i JOIN evidence_payloads p ON p.version_id=i.version_id WHERE i.run_id=j.id
          AND i.version_id=(citation->>'version')::uuid AND strpos(p.payload,citation->>'quote')>0)
        OR (citation->>'version')::uuid=ANY(parent_ids) THEN RAISE check_violation USING MESSAGE='Brief citation unavailable'; END IF;
      parent_ids:=array_append(parent_ids,(citation->>'version')::uuid);
    END LOOP;
    IF claim->>'contradiction'='true' AND cardinality(parent_ids)<3 THEN RAISE check_violation USING MESSAGE='Brief contradiction unavailable'; END IF;
    claim_key:=encode(sha256(convert_to(claim::text,'UTF8')),'hex');
    SELECT bb.evidence_version INTO ev FROM brief_blocks bb JOIN evidence_payloads p ON p.version_id=bb.evidence_version
      WHERE bb.version_id=d.head AND bb.block_id=claim_key AND p.payload=claim::text
        AND continuum_brief_audience(b.principal_id,bb.evidence_version,d.scope_id,NULL);
    IF ev IS NULL THEN
      SELECT jsonb_agg(jsonb_build_object('versionId',id,'kind','derivation') ORDER BY id) INTO parents FROM unnest(parent_ids) id;
      ev:=continuum_evidence_register(b.principal_id,gen_random_uuid(),NULL,d.scope_id,'brief-section-version',parents,
        jsonb_build_object('transform',j.descriptor->>'version','model',j.descriptor->>'model','prompt','brief-reference-v1','schema','project-brief-v1'),claim::text);
      bytes:=bytes+octet_length(claim::text)+4096;
    END IF;
    INSERT INTO brief_blocks VALUES(version,claim_key,claim->>'section',ev);
  END LOOP;
  IF (SELECT count(*) FROM brief_blocks WHERE version_id=version)>32 OR j.cutoff<(SELECT cutoff FROM brief_versions WHERE id=d.head) THEN
    RAISE check_violation USING MESSAGE='Brief version bounds unavailable'; END IF;
  PERFORM continuum_brief_charge(j.workflow_id,jsonb_build_object('artifactBytes',bytes,'storageBytes',bytes+32768));
  PERFORM continuum_brief_gate(run_id,worker,epoch,FALSE);
  IF NOT j.dry_run THEN UPDATE brief_definitions SET head=version WHERE id=d.id AND head IS NOT DISTINCT FROM j.expected_head; END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(b.principal_id,'write',d.scope_id,
    jsonb_build_object('operation','brief_version_applied','dry_run',j.dry_run));
  UPDATE brief_runs SET result_version=version,state='complete',lease_until=NULL WHERE id=j.id;
  RETURN version;
END $$;
CREATE FUNCTION continuum_brief_stop(run_id UUID,worker UUID,epoch BIGINT,failure TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE j brief_runs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT j FROM brief_runs WHERE id=run_id FOR UPDATE;
  IF j.login_oid IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=session_user) OR j.owner IS DISTINCT FROM worker OR j.generation IS DISTINCT FROM epoch THEN
    RAISE insufficient_privilege USING MESSAGE='Brief cancellation unavailable'; END IF;
  IF failure IS NULL OR failure NOT IN ('policy','budget','invalid-output','ambiguous','cancelled','deadline','stale','provider') THEN RAISE check_violation USING MESSAGE='Brief outcome unavailable'; END IF;
  IF j.state='running' THEN
    UPDATE brief_runs SET state=CASE WHEN failure='cancelled' THEN 'cancelled' ELSE 'unavailable' END,reason=failure,owner=NULL,lease_until=NULL,generation=generation+1 WHERE id=j.id;
    UPDATE pipeline_budget_workflows SET cancelled=TRUE,generation=generation+1 WHERE id=j.workflow_id AND NOT cancelled;
  END IF;
END $$;

CREATE FUNCTION continuum_brief_view(actor UUID,version UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE v brief_versions%ROWTYPE; d brief_definitions%ROWTYPE; bb RECORD; blocks JSONB:='[]'; body JSONB; denied BOOLEAN:=FALSE; bytes BIGINT:=0;
BEGIN
  SELECT * INTO STRICT v FROM brief_versions WHERE id=version;
  SELECT * INTO STRICT d FROM brief_definitions WHERE id=v.definition_id FOR SHARE;
  PERFORM continuum_brief_authorize(actor,d.scope_id,FALSE);
  PERFORM continuum_evidence_lock(actor,ARRAY[v.anchor_version],d.scope_id);
  IF NOT continuum_brief_audience(actor,v.anchor_version,d.scope_id,NULL) THEN RETURN jsonb_build_object('status','unavailable','blocks','[]'::jsonb); END IF;
  denied:=EXISTS(SELECT 1 FROM brief_run_inputs i WHERE i.run_id=v.run_id AND NOT continuum_brief_audience(actor,i.version_id,d.scope_id,NULL));
  -- Each block is gated before its prose, citation identities or hash are read.
  FOR bb IN SELECT evidence_version FROM brief_blocks WHERE version_id=v.id ORDER BY evidence_version LOOP
    PERFORM continuum_evidence_lock(actor,ARRAY[bb.evidence_version],d.scope_id);
    IF continuum_brief_audience(actor,bb.evidence_version,d.scope_id,NULL) THEN
      SELECT octet_length(payload) INTO bytes FROM evidence_payloads WHERE version_id=bb.evidence_version;
      IF octet_length(blocks::text)+6*COALESCE(bytes,0)>131072 THEN RAISE program_limit_exceeded USING MESSAGE='Brief output unavailable'; END IF;
      SELECT payload::jsonb INTO body FROM evidence_payloads WHERE version_id=bb.evidence_version;
      blocks:=blocks||jsonb_build_array(body||jsonb_build_object('id',(SELECT block_id FROM brief_blocks WHERE version_id=v.id AND evidence_version=bb.evidence_version)));
    ELSE denied:=TRUE; END IF;
  END LOOP;
  RETURN jsonb_build_object('scopeId',d.scope_id,'definitionId',d.id,'version',v.id,'previousVersion',v.previous_version,'blocks',blocks,
    'implementation','unknown','status',CASE WHEN denied THEN 'partial' WHEN jsonb_array_length(blocks)=0 THEN 'unknown' ELSE 'available' END,
    'fresh',NOT denied AND v.observed=continuum_brief_frontier(d.scope_id),'cutoff',CASE WHEN NOT denied THEN v.cutoff END,
    'coverage',CASE WHEN denied THEN 'unknown' WHEN v.truncated THEN 'partial' ELSE 'complete' END,
    'watermark',CASE WHEN NOT denied AND NOT v.truncated THEN v.watermark END);
END $$;
CREATE FUNCTION continuum_brief_read(actor UUID,project_name TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE target_scope UUID; d brief_definitions%ROWTYPE;
BEGIN
  SELECT id INTO target_scope FROM scopes WHERE kind='project' AND name=project_name;
  PERFORM continuum_brief_authorize(actor,target_scope,FALSE);
  SELECT * INTO d FROM brief_definitions WHERE scope_id=target_scope FOR SHARE;
  IF d.id IS NULL OR d.head IS NULL THEN RETURN jsonb_build_object('scopeId',target_scope,'status','unknown','enabled',COALESCE(d.enabled,FALSE),'blocks','[]'::jsonb,'implementation','unknown'); END IF;
  RETURN continuum_brief_view(actor,d.head)||jsonb_build_object('enabled',d.enabled);
END $$;
CREATE FUNCTION continuum_brief_history(actor UUID,definition UUID,after_version UUID,page_limit INTEGER) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE d brief_definitions%ROWTYPE; item RECORD; items JSONB:='[]'; n INTEGER:=0; cursor UUID; result JSONB;
BEGIN
  SELECT * INTO STRICT d FROM brief_definitions WHERE id=definition FOR SHARE;
  PERFORM continuum_brief_authorize(actor,d.scope_id,FALSE);
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 10 OR (after_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM brief_versions WHERE id=after_version AND definition_id=d.id)) THEN
    RAISE check_violation USING MESSAGE='Brief history cursor unavailable'; END IF;
  FOR item IN SELECT v.id FROM brief_versions v JOIN brief_runs r ON r.id=v.run_id WHERE v.definition_id=d.id AND NOT r.dry_run
    AND (after_version IS NULL OR (v.created_at,v.id)<(SELECT created_at,id FROM brief_versions WHERE id=after_version))
    ORDER BY v.created_at DESC,v.id DESC LIMIT page_limit+1 LOOP
    n:=n+1; IF n>page_limit THEN EXIT; END IF;
    result:=continuum_brief_view(actor,item.id);
    IF octet_length(items::text)+octet_length(result::text)>131072 THEN RAISE program_limit_exceeded USING MESSAGE='Brief history unavailable'; END IF;
    items:=items||jsonb_build_array(result); cursor:=item.id;
  END LOOP;
  RETURN jsonb_build_object('scopeId',d.scope_id,'items',items,'nextCursor',CASE WHEN n>page_limit THEN cursor END);
END $$;
CREATE FUNCTION continuum_brief_result(actor UUID,run_id UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE j brief_runs%ROWTYPE; d brief_definitions%ROWTYPE; result JSONB; proposed JSONB; previous JSONB;
BEGIN
  SELECT * INTO STRICT j FROM brief_runs WHERE id=run_id;
  SELECT * INTO STRICT d FROM brief_definitions WHERE id=j.definition_id;
  PERFORM continuum_brief_authorize(actor,d.scope_id,TRUE);
  result:=jsonb_build_object('scopeId',d.scope_id,'runId',j.id,'status',j.state,'dryRun',j.dry_run);
  IF j.state='complete' AND j.result_version IS NOT NULL THEN
    proposed:=continuum_brief_view(actor,j.result_version);
    result:=result||jsonb_build_object('result',proposed);
    IF j.dry_run THEN
      previous:=CASE WHEN j.expected_head IS NULL THEN '{"status":"unknown","blocks":[]}'::jsonb ELSE continuum_brief_view(actor,j.expected_head) END;
      IF proposed->>'status' IN ('partial','unavailable') OR previous->>'status' IN ('partial','unavailable') THEN
        result:=result||jsonb_build_object('diff',jsonb_build_object('status','withheld'));
      ELSE
        result:=result||jsonb_build_object('diff',jsonb_build_object('status','available',
          'added',COALESCE((SELECT jsonb_agg(b->>'id' ORDER BY b->>'id') FROM jsonb_array_elements(proposed->'blocks') b
            WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(previous->'blocks') old WHERE old->>'id'=b->>'id')),'[]'),
          'removed',COALESCE((SELECT jsonb_agg(b->>'id' ORDER BY b->>'id') FROM jsonb_array_elements(previous->'blocks') b
            WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proposed->'blocks') fresh WHERE fresh->>'id'=b->>'id')),'[]')));
      END IF;
    END IF;
  END IF;
  RETURN result;
END $$;

CREATE FUNCTION continuum_brief_payload_erased() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
  -- Indexed, no per-row wrapper or unbounded fanout over the run inventory.
  DELETE FROM brief_blocks WHERE evidence_version=OLD.version_id;
  RETURN OLD;
END $$;
CREATE TRIGGER brief_payload_erased AFTER DELETE ON evidence_payloads FOR EACH ROW EXECUTE FUNCTION continuum_brief_payload_erased();
CREATE FUNCTION continuum_brief_scope_is_erased(target_scope UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NOT EXISTS(SELECT 1 FROM brief_blocks WHERE evidence_version IN(SELECT continuum_evidence_scope_versions(target_scope)))
    AND NOT EXISTS(SELECT 1 FROM brief_runs j WHERE EXISTS(SELECT 1 FROM brief_run_inputs i WHERE i.run_id=j.id
      AND i.version_id IN(SELECT continuum_evidence_scope_versions(target_scope))) AND (j.state<>'cancelled' OR j.owner IS NOT NULL OR j.lease_until IS NOT NULL
      OR EXISTS(SELECT 1 FROM pipeline_budget_workflows w WHERE w.id=j.workflow_id AND NOT w.cancelled)));
$$;
CREATE FUNCTION continuum_operator_scrub_brief_scope(actor UUID,subject UUID,target_scope UUID,page_limit INTEGER) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE item RECORD; processed INTEGER:=0; clean BOOLEAN;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  PERFORM * FROM continuum_operator_coordination_scope_privacy_state(actor,target_scope);
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 1000 OR NOT EXISTS(SELECT 1 FROM principal_user_scopes WHERE principal_id=subject AND scope_id=target_scope)
    OR NOT EXISTS(SELECT 1 FROM principal_offboarding_runs WHERE principal_id=subject AND scope_id=target_scope) THEN RAISE insufficient_privilege USING MESSAGE='Brief erasure requires approved lifecycle'; END IF;
  FOR item IN SELECT j.id,j.workflow_id FROM brief_runs j WHERE EXISTS(SELECT 1 FROM brief_run_inputs i WHERE i.run_id=j.id
    AND i.version_id IN(SELECT continuum_evidence_scope_versions(target_scope))) AND (j.state<>'cancelled' OR j.owner IS NOT NULL OR j.lease_until IS NOT NULL
      OR EXISTS(SELECT 1 FROM pipeline_budget_workflows w WHERE w.id=j.workflow_id AND NOT w.cancelled))
    ORDER BY j.id LIMIT page_limit FOR UPDATE OF j SKIP LOCKED LOOP
    UPDATE pipeline_budget_workflows SET cancelled=TRUE,generation=generation+1 WHERE id=item.workflow_id AND NOT cancelled;
    UPDATE brief_runs SET state='cancelled',reason='cancelled',owner=NULL,lease_until=NULL,generation=generation+1 WHERE id=item.id;
    processed:=processed+1;
  END LOOP;
  clean:=continuum_brief_scope_is_erased(target_scope);
  IF processed>0 THEN INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'archive',target_scope,
    jsonb_build_object('operation','brief_privacy_scrub','processed',processed)); END IF;
  RETURN jsonb_build_object('complete',clean,'processed',processed,'batch_full',NOT clean AND processed>=page_limit);
END $$;
ALTER FUNCTION continuum_offboarding_lifecycle_state_is_erased(UUID) RENAME TO continuum_offboarding_lifecycle_state_is_erased_pre_brief;
CREATE FUNCTION continuum_offboarding_lifecycle_state_is_erased(target_run UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_offboarding_lifecycle_state_is_erased_pre_brief(target_run) AND EXISTS(SELECT 1 FROM principal_offboarding_runs
    WHERE run_id=target_run AND continuum_brief_scope_is_erased(scope_id));
$$;
CREATE TABLE brief_contract_functions(signature TEXT PRIMARY KEY,body_hash TEXT NOT NULL,definer BOOLEAN NOT NULL,volatility "char" NOT NULL);
REVOKE ALL ON brief_contract_functions FROM PUBLIC;
CREATE FUNCTION continuum_brief_is_ready() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_connector_is_ready() AND EXISTS(SELECT 1 FROM brief_contract_functions)
    AND NOT EXISTS(SELECT 1 FROM brief_contract_functions c LEFT JOIN pg_proc f ON f.oid=to_regprocedure(c.signature)
      WHERE f.oid IS NULL OR encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>c.body_hash OR f.prosecdef<>c.definer OR f.provolatile<>c.volatility
        OR f.proowner<>(SELECT relowner FROM pg_class WHERE oid='memories'::regclass)
        OR NOT COALESCE(f.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',(SELECT n.nspname FROM pg_namespace n JOIN pg_class m ON m.relnamespace=n.oid WHERE m.oid='memories'::regclass))],FALSE)
        OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))
    AND (SELECT count(*) FROM pg_trigger WHERE (tgrelid,tgname) IN (('memories'::regclass,'brief_memory_changed'),('evidence_roots'::regclass,'brief_root_changed'),
      ('evidence_payloads'::regclass,'brief_payload_erased'),('brief_runs'::regclass,'brief_run_identity'),('brief_versions'::regclass,'brief_version_immutable'),
      ('brief_dispatch_receipts'::regclass,'brief_dispatch_immutable'),('memory_event_current'::regclass,'brief_event_changed')) AND tgenabled='O' AND NOT tgisinternal)=7;
$$;
DO $$
DECLARE schema_name TEXT:=current_schema(); f RECORD; signature TEXT; definition TEXT; revised TEXT; r RECORD;
  app_signatures TEXT[]:=ARRAY['continuum_brief_configure(uuid,uuid,text,boolean)','continuum_brief_refresh(uuid,text,text,boolean,text)',
    'continuum_brief_read(uuid,text)','continuum_brief_history(uuid,uuid,uuid,integer)','continuum_brief_result(uuid,uuid)','continuum_brief_is_ready()'];
  op_signatures TEXT[]:=ARRAY['continuum_operator_install_brief_profile(uuid,jsonb,boolean)',
    'continuum_operator_bind_brief_worker(uuid,name,uuid,uuid,text,boolean)','continuum_operator_scrub_brief_scope(uuid,uuid,uuid,integer)'];
BEGIN
  FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=quote_ident(schema_name)::regnamespace
    AND (proname LIKE 'continuum_brief_%' OR proname LIKE 'continuum_operator_%brief%' OR proname IN
      ('continuum_offboarding_lifecycle_state_is_erased','continuum_offboarding_lifecycle_state_is_erased_pre_brief')) LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',f.signature,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['continuum_assert_application_role_allowlist(name,boolean)','continuum_assert_standup_application_role_allowlist(name,boolean)'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'(''continuum_standup_is_ready()'')','(''continuum_standup_is_ready()''),('''||replace(array_to_string(app_signatures,'''),('''),' ','')||''')');
    revised:=replace(revised,'(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'')',
      '(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)''),('''||replace(array_to_string(op_signatures,'''),('''),' ','')||''')');
    IF revised=definition THEN RAISE EXCEPTION 'unable to extend brief allowlist'; END IF;
    EXECUTE revised;
  END LOOP;
  FOR r IN SELECT * FROM continuum_brief_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=r.role_oid AND rolname=r.role_name) THEN CONTINUE; END IF;
    FOREACH signature IN ARRAY app_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,r.role_name); END LOOP;
    IF r.operator THEN FOREACH signature IN ARRAY op_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,r.role_name); END LOOP; END IF;
    PERFORM continuum_assert_application_role_allowlist(r.role_name,r.operator);
  END LOOP;
END $$;
-- Only the verified current lifecycle wrapper changed. Preserve all other pins.
UPDATE evidence_contract_functions c SET body_hash=encode(sha256(convert_to(f.prosrc,'UTF8')),'hex'),definer=f.prosecdef,volatility=f.provolatile
  FROM pg_proc f WHERE f.oid=to_regprocedure(c.signature) AND f.oid='continuum_offboarding_lifecycle_state_is_erased(uuid)'::regprocedure;
UPDATE extraction_contract_functions c SET body_hash=encode(sha256(convert_to(f.prosrc,'UTF8')),'hex'),definer=f.prosecdef,volatility=f.provolatile
  FROM pg_proc f WHERE f.oid=to_regprocedure(c.signature) AND f.oid='continuum_offboarding_lifecycle_state_is_erased(uuid)'::regprocedure;
UPDATE connector_contract_functions c SET body_hash=encode(sha256(convert_to(f.prosrc,'UTF8')),'hex'),definer=f.prosecdef,volatility=f.provolatile
  FROM pg_proc f WHERE f.oid=to_regprocedure(c.signature) AND f.oid='continuum_offboarding_lifecycle_state_is_erased(uuid)'::regprocedure;
INSERT INTO brief_contract_functions SELECT oid::regprocedure::text,encode(sha256(convert_to(prosrc,'UTF8')),'hex'),prosecdef,provolatile FROM pg_proc
  WHERE pronamespace=quote_ident(current_schema())::regnamespace AND (proname LIKE 'continuum_brief_%' OR proname LIKE 'continuum_operator_%brief%'
    OR proname IN('continuum_offboarding_lifecycle_state_is_erased','continuum_offboarding_lifecycle_state_is_erased_pre_brief'));

