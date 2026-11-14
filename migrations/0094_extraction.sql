-- Optional typed extraction pilot. Empty registries admit no work.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE continuum_extraction_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $$ DECLARE candidate RECORD; BEGIN
  FOR candidate IN SELECT profile.*,role.rolname FROM continuum_pgvector_role_profiles profile
    JOIN pg_roles role ON role.oid=profile.database_role_oid WHERE profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_extraction_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Continuum skipped extraction grants for role OID % (SQLSTATE %); explicit regrant required',candidate.database_role_oid,SQLSTATE;
    END;
  END LOOP;
END $$;

CREATE TABLE extraction_profiles(
  id TEXT PRIMARY KEY CHECK(id~'^[a-z][a-z0-9.-]{0,63}$'),
  descriptor JSONB NOT NULL, enabled BOOLEAN NOT NULL, generation BIGINT NOT NULL CHECK(generation>0)
);
CREATE TABLE extraction_scope_config(
  scope_id UUID PRIMARY KEY REFERENCES scopes(id), profile TEXT NOT NULL REFERENCES extraction_profiles(id),
  sources TEXT[] NOT NULL, enabled BOOLEAN NOT NULL, generation BIGINT NOT NULL CHECK(generation>0)
);
CREATE TABLE extraction_worker_bindings(
  role_oid OID NOT NULL, role_name NAME NOT NULL, principal_id UUID NOT NULL REFERENCES principals(id),
  scope_id UUID NOT NULL REFERENCES scopes(id), profile TEXT NOT NULL REFERENCES extraction_profiles(id),
  generation UUID NOT NULL DEFAULT gen_random_uuid(), enabled BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY(role_oid,scope_id,profile), UNIQUE(role_name,scope_id,profile)
);
CREATE TABLE extraction_runs(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), memory_id UUID NOT NULL, scope_id UUID NOT NULL REFERENCES scopes(id),
  source_version UUID REFERENCES evidence_versions(id), profile TEXT NOT NULL, descriptor JSONB NOT NULL,
  config_generation BIGINT NOT NULL, profile_generation BIGINT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','complete','partial','skipped','unavailable','cancelled')),
  reason TEXT CHECK(reason IN ('budget','policy','invalid-output','transient','permanent','ambiguous','deadline','cancelled')),
  generation BIGINT NOT NULL DEFAULT 0, owner UUID, login_oid OID, binding_generation UUID,
  lease_until TIMESTAMPTZ, retry_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  workflow_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  budget_owner UUID NOT NULL DEFAULT gen_random_uuid(), budget_generation BIGINT NOT NULL DEFAULT 1,
  source_bytes INTEGER NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count BETWEEN 0 AND 64),
  completed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, assertion_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  UNIQUE NULLS NOT DISTINCT(memory_id,source_version,config_generation,profile_generation)
);
CREATE INDEX extraction_pending_idx ON extraction_runs(profile,retry_at,id) WHERE state IN ('queued','running');
CREATE INDEX extraction_memory_idx ON extraction_runs(memory_id,created_at DESC,id DESC);
CREATE INDEX extraction_scope_idx ON extraction_runs(scope_id,id);
-- No duplicate source bodies or raw model/error text. Content-bearing hashes
-- and span descriptors are physically removed by canonical erasure.
CREATE TABLE extraction_chunks(
  run_id UUID NOT NULL REFERENCES extraction_runs(id), chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 63),
  chunk_id TEXT NOT NULL CHECK(chunk_id~'^[0-9a-f]{64}$'), content_hash TEXT NOT NULL CHECK(content_hash~'^[0-9a-f]{64}$'),
  start_byte INTEGER NOT NULL CHECK(start_byte>=0), end_byte INTEGER NOT NULL CHECK(end_byte>start_byte),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','skipped')),
  assertions UUID[] NOT NULL DEFAULT '{}', reason TEXT CHECK(reason IN ('budget','policy','invalid-output','transient','permanent','ambiguous','deadline','cancelled')),
  PRIMARY KEY(run_id,chunk_index), UNIQUE(run_id,chunk_id)
);
CREATE TABLE extraction_attempts(
  run_id UUID NOT NULL REFERENCES extraction_runs(id), attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_index INTEGER NOT NULL, attempt_owner UUID NOT NULL, attempt_generation BIGINT NOT NULL,
  login_oid OID NOT NULL, claim_generation BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX extraction_attempt_run_idx ON extraction_attempts(run_id,chunk_index,created_at);
CREATE TABLE extraction_dispatch_receipts(attempt_id UUID PRIMARY KEY REFERENCES extraction_attempts(attempt_id));
CREATE TABLE extraction_abandoned_attempts(attempt_id UUID PRIMARY KEY REFERENCES extraction_attempts(attempt_id));
CREATE TABLE extraction_recoveries(attempt_id UUID PRIMARY KEY REFERENCES extraction_attempts(attempt_id), accounting TEXT NOT NULL CHECK(accounting IN ('settled','no-reservation')));
CREATE TRIGGER extraction_recovery_immutable BEFORE UPDATE OR DELETE ON extraction_recoveries FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE TRIGGER extraction_abandoned_immutable BEFORE UPDATE OR DELETE ON extraction_abandoned_attempts FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE TRIGGER extraction_dispatch_immutable BEFORE UPDATE OR DELETE ON extraction_dispatch_receipts FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE TABLE extraction_receipts(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id UUID NOT NULL REFERENCES extraction_runs(id),
  generation BIGINT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('queued','claimed','complete','partial','skipped','unavailable','cancelled','retry')),
  reason TEXT CHECK(reason IN ('budget','policy','invalid-output','transient','permanent','ambiguous','deadline','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER extraction_attempt_immutable BEFORE UPDATE OR DELETE ON extraction_attempts FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE TRIGGER extraction_receipt_immutable BEFORE UPDATE OR DELETE ON extraction_receipts FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE FUNCTION continuum_extraction_run_identity() RETURNS trigger LANGUAGE plpgsql AS $$
#variable_conflict use_column
BEGIN
  IF (OLD.id,OLD.memory_id,OLD.scope_id,OLD.source_version,OLD.profile,OLD.descriptor,OLD.config_generation,OLD.profile_generation,
    OLD.workflow_id,OLD.budget_owner,OLD.budget_generation,OLD.source_bytes,OLD.created_at) IS DISTINCT FROM
    (NEW.id,NEW.memory_id,NEW.scope_id,NEW.source_version,NEW.profile,NEW.descriptor,NEW.config_generation,NEW.profile_generation,
    NEW.workflow_id,NEW.budget_owner,NEW.budget_generation,NEW.source_bytes,NEW.created_at) THEN
    RAISE check_violation USING MESSAGE='extraction run identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER extraction_run_identity BEFORE UPDATE ON extraction_runs FOR EACH ROW EXECUTE FUNCTION continuum_extraction_run_identity();
REVOKE ALL ON extraction_profiles,extraction_scope_config,extraction_worker_bindings,extraction_runs,extraction_chunks,extraction_attempts,extraction_receipts,extraction_dispatch_receipts,extraction_abandoned_attempts,extraction_recoveries FROM PUBLIC;
REVOKE ALL ON SEQUENCE extraction_receipts_id_seq FROM PUBLIC;

CREATE FUNCTION continuum_extraction_valid_descriptor(d JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
#variable_conflict use_column
DECLARE key TEXT;
BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR octet_length(d::text)>16384
    OR NOT(d ?& ARRAY['id','version','model','adapter','adapterProfile','locality','schema','prompt','chunkBytes','maxChunks','budget','hash','responseBodyBytes','outputTokens','reasoningTokens','completionTokens','accounting','price'])
    OR (SELECT count(*) FROM jsonb_object_keys(d))<>18 OR d->>'id' !~ '^[a-z][a-z0-9.-]{0,63}$'
    OR d->>'locality' NOT IN ('local','hosted') OR d->>'schema'<>'extraction-v1' OR d->>'prompt'<>'source-reference-v1'
    OR d->>'hash' !~ '^[0-9a-f]{64}$' OR NOT continuum_pipeline_valid_profile(d->'budget') THEN RETURN FALSE; END IF;
  FOREACH key IN ARRAY ARRAY['version','model','adapter','adapterProfile'] LOOP
    IF jsonb_typeof(d->key)<>'string' OR d->>key !~ '^[a-zA-Z0-9_.:/-]{1,128}$' THEN RETURN FALSE; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['id','locality','schema','prompt','hash'] LOOP
    IF jsonb_typeof(d->key) IS DISTINCT FROM 'string' THEN RETURN FALSE; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['chunkBytes','maxChunks','responseBodyBytes','outputTokens','reasoningTokens','completionTokens'] LOOP
    IF jsonb_typeof(d->key)<>'number' OR d->>key !~ '^(0|[1-9][0-9]*)$' OR (d->>key)::numeric>1048576 THEN RETURN FALSE; END IF;
  END LOOP;
  IF (d->>'chunkBytes')::int NOT BETWEEN 4 AND 65536 OR (d->>'maxChunks')::int NOT BETWEEN 1 AND 64
    OR (d->'budget'->>'overallMs')::int>20000 OR (d->>'responseBodyBytes')::int NOT BETWEEN 512 AND 65536
    OR jsonb_typeof(d->'accounting') IS DISTINCT FROM 'object' OR jsonb_typeof(d->'price') IS DISTINCT FROM 'object'
    OR d->'accounting'->>'model' IS DISTINCT FROM d->>'model' OR d->'accounting'->>'profile' IS DISTINCT FROM d->>'adapterProfile'
    OR d->'accounting'->>'kind' NOT IN ('exact','conservative')
    OR d->'accounting'->>'validationId' !~ '^[a-zA-Z0-9_.:/-]{1,128}$'
    OR d->'price'->>'id' IS DISTINCT FROM d->'budget'->>'rateSchedule'
    OR d->'price'->>'currency' IS DISTINCT FROM d->'budget'->>'currency' THEN RETURN FALSE; END IF;
  IF NOT(d->'accounting' ?& ARRAY['kind','model','profile','validationId','overheadTokens'])
    OR (SELECT count(*) FROM jsonb_object_keys(d->'accounting'))<>5
    OR NOT(d->'price' ?& ARRAY['id','currency','unitTokens','inputMicros','outputMicros','reasoningMicros'])
    OR (SELECT count(*) FROM jsonb_object_keys(d->'price'))<>6 THEN RETURN FALSE; END IF;
  FOREACH key IN ARRAY ARRAY['kind','model','profile','validationId'] LOOP
    IF jsonb_typeof(d->'accounting'->key) IS DISTINCT FROM 'string' THEN RETURN FALSE; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['unitTokens','inputMicros','outputMicros','reasoningMicros'] LOOP
    IF jsonb_typeof(d->'price'->key) IS DISTINCT FROM 'number' OR d->'price'->>key !~ '^(0|[1-9][0-9]*)$'
      OR (d->'price'->>key)::numeric>9007199254740991 THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN (d->'price'->>'unitTokens')::numeric>0 AND jsonb_typeof(d->'accounting'->'overheadTokens')='number'
    AND d->'accounting'->>'overheadTokens' ~ '^(0|[1-9][0-9]*)$'
    AND (d->'accounting'->>'overheadTokens')::numeric<=9007199254740991
    AND jsonb_typeof(d->'price'->'id')='string' AND jsonb_typeof(d->'price'->'currency')='string';
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;

CREATE FUNCTION continuum_operator_install_extractor(actor UUID,descriptor JSONB,enabled BOOLEAN) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF enabled IS NULL OR NOT continuum_extraction_valid_descriptor(descriptor) THEN RAISE check_violation USING MESSAGE='invalid extraction profile'; END IF;
  INSERT INTO extraction_profiles VALUES(descriptor->>'id',descriptor,enabled,1)
    ON CONFLICT(id) DO UPDATE SET descriptor=EXCLUDED.descriptor,enabled=EXCLUDED.enabled,generation=extraction_profiles.generation+1;
  INSERT INTO audit_log(principal_id,action,metadata) VALUES(actor,'write',jsonb_build_object('operation','extraction_profile_installed'));
END $$;

CREATE FUNCTION continuum_extraction_scope_admin(actor UUID,target_scope UUID) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT continuum_evidence_can_access(actor,target_scope,TRUE) AND EXISTS(SELECT 1 FROM scope_memberships
    WHERE principal_id=actor AND scope_id=target_scope AND role='admin' AND active
      AND (source_kind<>'entra' OR EXISTS(SELECT 1 FROM entra_sync_state WHERE singleton AND clock_timestamp()<last_success_at+max_staleness)));
$$;
-- Conservative serialized control-record allowance, separate from source and
-- generated payloads. This is an operational bound, not physical DB allocation.
CREATE FUNCTION continuum_extraction_control_bytes(descriptor JSONB) RETURNS BIGINT LANGUAGE sql IMMUTABLE AS $$
  SELECT 2*octet_length(descriptor::text)+8192+(descriptor->>'maxChunks')::bigint*1024
    +(descriptor->'budget'->'limits'->>'calls')::bigint*1024;
$$;
CREATE FUNCTION continuum_extraction_configure(actor UUID,target_scope UUID,profile_id TEXT,source_ids TEXT[],enable BOOLEAN) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE result extraction_scope_config%ROWTYPE;
BEGIN
  PERFORM id FROM principals WHERE id=actor FOR SHARE;
  PERFORM principal_id FROM scope_memberships WHERE principal_id=actor AND scope_id=target_scope FOR SHARE;
  PERFORM singleton FROM entra_sync_state WHERE singleton FOR SHARE;
  IF NOT continuum_extraction_scope_admin(actor,target_scope) THEN RAISE insufficient_privilege USING MESSAGE='extraction administration unavailable'; END IF;
  IF enable IS NULL OR source_ids IS NULL OR cardinality(source_ids) NOT BETWEEN 1 AND 6
    OR EXISTS(SELECT 1 FROM unnest(source_ids) value WHERE value IS NULL OR value NOT IN ('manual','github-pr','github-branch','ado-workitem','deploy-event','terminal-summary'))
    OR (SELECT count(DISTINCT value) FROM unnest(source_ids) value)<>cardinality(source_ids) THEN RAISE check_violation USING MESSAGE='invalid extraction source allowlist'; END IF;
  PERFORM id FROM extraction_profiles WHERE id=profile_id AND (enabled OR NOT enable) FOR SHARE;
  IF NOT FOUND THEN RAISE check_violation USING MESSAGE='extraction profile unavailable'; END IF;
  INSERT INTO extraction_scope_config VALUES(target_scope,profile_id,source_ids,enable,1)
    ON CONFLICT(scope_id) DO UPDATE SET profile=EXCLUDED.profile,sources=EXCLUDED.sources,enabled=EXCLUDED.enabled,generation=extraction_scope_config.generation+1 RETURNING * INTO result;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',target_scope,jsonb_build_object('operation','extraction_configured','enabled',enable));
  RETURN to_jsonb(result);
END $$;

CREATE FUNCTION continuum_extraction_enqueue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE config extraction_scope_config%ROWTYPE; profile extraction_profiles%ROWTYPE; version UUID; bytes INTEGER; run UUID; skipped BOOLEAN:=FALSE; skip_reason TEXT;
BEGIN
  SELECT * INTO config FROM extraction_scope_config WHERE scope_id=NEW.scope_id AND enabled AND NEW.source=ANY(sources) FOR SHARE;
  IF config.scope_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO profile FROM extraction_profiles WHERE id=config.profile AND enabled FOR SHARE;
  IF profile.id IS NULL THEN RETURN NEW; END IF;
  bytes:=octet_length(continuum_evidence_canonical(NEW));
  skipped:=bytes>least(1048576,(profile.descriptor->'budget'->>'maxItemHydratedBytes')::int,
    (profile.descriptor->>'chunkBytes')::int*(profile.descriptor->>'maxChunks')::int)
    OR bytes+continuum_extraction_control_bytes(profile.descriptor)>(profile.descriptor->'budget'->'limits'->>'storageBytes')::bigint;
  skipped:=skipped OR (profile.descriptor->'budget'->'limits'->>'calls')::bigint<1;
  IF skipped THEN skip_reason:='budget'; END IF;
  IF NOT skipped THEN
    -- Evidence admission can abstain independently of a valid legacy capture.
    BEGIN version:=continuum_evidence_source(NEW.author_id,NEW.id);
    EXCEPTION WHEN check_violation OR insufficient_privilege THEN skipped:=TRUE; skip_reason:='policy'; END;
  END IF;
  INSERT INTO extraction_runs(memory_id,scope_id,source_version,profile,descriptor,config_generation,profile_generation,state,reason,source_bytes)
    VALUES(NEW.id,NEW.scope_id,version,profile.id,profile.descriptor,config.generation,profile.generation,
      CASE WHEN skipped THEN 'skipped' ELSE 'queued' END,skip_reason,bytes)
    RETURNING id INTO run;
  INSERT INTO extraction_receipts(run_id,generation,outcome,reason) SELECT id,generation,state,reason FROM extraction_runs WHERE id=run;
  INSERT INTO audit_log(principal_id,action,memory_id,scope_id,metadata) VALUES(NEW.author_id,'write',NEW.id,NEW.scope_id,
    jsonb_build_object('operation','extraction_admitted','outcome',CASE WHEN skipped THEN 'skipped' ELSE 'queued' END));
  RETURN NEW;
END $$;
CREATE TRIGGER extraction_capture_enqueue AFTER INSERT ON memories FOR EACH ROW EXECUTE FUNCTION continuum_extraction_enqueue();

CREATE FUNCTION continuum_extraction_erase_run(run_id UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM extraction_runs WHERE id=run_id FOR UPDATE;
  DELETE FROM extraction_chunks WHERE (extraction_chunks.run_id,chunk_index) IN
    (SELECT c.run_id,c.chunk_index FROM extraction_chunks c WHERE c.run_id=job.id FOR UPDATE SKIP LOCKED);
  UPDATE pipeline_budget_workflows SET cancelled=TRUE,generation=generation+1 WHERE id=job.workflow_id AND NOT cancelled;
  UPDATE extraction_runs SET state='cancelled',reason='cancelled',generation=generation+1,owner=NULL,lease_until=NULL,completed=0,skipped=0,assertion_count=0,chunk_count=0 WHERE id=job.id;
  IF job.state<>'cancelled' THEN INSERT INTO extraction_receipts(run_id,generation,outcome,reason) VALUES(job.id,job.generation+1,'cancelled','cancelled'); END IF;
END $$;
CREATE FUNCTION continuum_extraction_source_erased() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job RECORD;
BEGIN
  FOR job IN SELECT id FROM extraction_runs WHERE source_version=OLD.version_id ORDER BY id LOOP PERFORM continuum_extraction_erase_run(job.id); END LOOP;
  RETURN OLD;
END $$;
CREATE TRIGGER extraction_source_erased AFTER DELETE ON evidence_payloads FOR EACH ROW EXECUTE FUNCTION continuum_extraction_source_erased();

CREATE FUNCTION continuum_extraction_scope_is_erased(target_scope UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NOT EXISTS(SELECT 1 FROM extraction_runs r WHERE (r.scope_id=target_scope OR r.source_version IN (SELECT continuum_evidence_scope_versions(target_scope)))
    AND (r.state<>'cancelled' OR r.owner IS NOT NULL OR r.lease_until IS NOT NULL
      OR EXISTS(SELECT 1 FROM extraction_chunks c WHERE c.run_id=r.id)
      OR EXISTS(SELECT 1 FROM pipeline_budget_workflows w WHERE w.id=r.workflow_id AND NOT w.cancelled)));
$$;
CREATE FUNCTION continuum_operator_scrub_extraction_scope(actor UUID,subject UUID,target_scope UUID,page_limit INTEGER) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job RECORD; processed INTEGER:=0; run principal_offboarding_runs%ROWTYPE;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  PERFORM * FROM continuum_operator_coordination_scope_privacy_state(actor,target_scope);
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 1000 OR NOT EXISTS(SELECT 1 FROM principal_user_scopes WHERE principal_id=subject AND scope_id=target_scope) THEN
    RAISE insufficient_privilege USING MESSAGE='extraction erasure unavailable'; END IF;
  SELECT * INTO STRICT run FROM principal_offboarding_runs WHERE principal_id=subject AND scope_id=target_scope FOR UPDATE;
  FOR job IN SELECT r.id FROM extraction_runs r WHERE (r.scope_id=target_scope OR r.source_version IN (SELECT continuum_evidence_scope_versions(target_scope)))
    AND (r.state<>'cancelled' OR EXISTS(SELECT 1 FROM extraction_chunks c WHERE c.run_id=r.id)) ORDER BY r.id FOR UPDATE SKIP LOCKED LIMIT page_limit LOOP
    PERFORM continuum_extraction_erase_run(job.id); processed:=processed+1;
  END LOOP;
  IF processed>0 THEN INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'archive',target_scope,
    jsonb_build_object('operation','principal_extraction_privacy_repaired','principal_id',subject,'run_id',run.run_id,
      'approval_id',run.approval_id::text,'acknowledged_evidence_hash',run.approval_evidence_hash,'rows_processed',processed)); END IF;
  RETURN jsonb_build_object('complete',continuum_extraction_scope_is_erased(target_scope),'processed',processed,'batch_full',processed=page_limit);
END $$;
ALTER FUNCTION continuum_offboarding_lifecycle_state_is_erased(UUID) RENAME TO continuum_offboarding_lifecycle_state_is_erased_pre_extraction;
CREATE FUNCTION continuum_offboarding_lifecycle_state_is_erased(target_run UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_offboarding_lifecycle_state_is_erased_pre_extraction(target_run)
    AND EXISTS(SELECT 1 FROM principal_offboarding_runs WHERE run_id=target_run AND continuum_extraction_scope_is_erased(scope_id));
$$;

-- Worker roles have a separate exact capability list, no APP/OP table reads,
-- pipeline functions, evidence browsing or general registration privileges.
CREATE FUNCTION continuum_extraction_worker_signatures() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
  'continuum_extraction_claim(text,uuid,jsonb)', 'continuum_extraction_hydrate(uuid,uuid,bigint)',
  'continuum_extraction_prepare(uuid,uuid,bigint,jsonb)', 'continuum_extraction_budget(uuid,uuid,bigint,uuid,text,jsonb,bigint)',
  'continuum_extraction_apply(uuid,uuid,bigint,integer,uuid,jsonb,text)', 'continuum_extraction_stop(uuid,uuid,bigint,text)',
  'continuum_extraction_is_ready()']::text[] $$;
CREATE FUNCTION continuum_extraction_assert_worker(database_role NAME) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
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
    OR EXISTS(SELECT 1 FROM unnest(continuum_extraction_worker_signatures()) signature WHERE NOT has_function_privilege(role_id,to_regprocedure(signature),'EXECUTE'))
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=schema_id AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(role_id,c.oid,'USAGE,SELECT,UPDATE')
      WHEN c.relkind IN ('r','v','m','p','f') THEN has_table_privilege(role_id,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE FALSE END)
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=schema_id AND (c.relowner=role_id OR EXISTS(
      SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a WHERE a.grantee=role_id)))
    OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace=schema_id AND a.attacl IS NOT NULL
      AND EXISTS(SELECT 1 FROM aclexplode(a.attacl) grant_entry WHERE grant_entry.grantee=role_id))
    OR EXISTS(SELECT 1 FROM pg_proc f WHERE f.pronamespace=schema_id AND (f.proowner=role_id OR (has_function_privilege(role_id,f.oid,'EXECUTE')
      AND NOT f.oid=ANY(SELECT to_regprocedure(signature) FROM unnest(continuum_extraction_worker_signatures()) signature)
      AND NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.objid=f.oid AND d.deptype='e' AND e.extname='vector')))) THEN
    RAISE insufficient_privilege USING MESSAGE='extraction worker requires an isolated exact LOGIN profile';
  END IF;
END $$;
CREATE FUNCTION continuum_operator_bind_extraction_worker(actor UUID,database_role NAME,worker_principal UUID,target_scope UUID,profile_id TEXT,enable BOOLEAN) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE role_id OID;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF enable IS NULL THEN RAISE check_violation USING MESSAGE='invalid extraction binding'; END IF;
  IF enable THEN
    PERFORM continuum_extraction_assert_worker(database_role);
    SELECT oid INTO STRICT role_id FROM pg_roles WHERE rolname=database_role;
    PERFORM id FROM principals WHERE id=worker_principal AND kind='service' AND disabled_at IS NULL FOR SHARE;
    IF NOT FOUND OR NOT continuum_evidence_can_access(worker_principal,target_scope,TRUE)
      OR NOT EXISTS(SELECT 1 FROM extraction_profiles WHERE id=profile_id AND enabled) THEN RAISE insufficient_privilege USING MESSAGE='extraction binding unavailable'; END IF;
    INSERT INTO extraction_worker_bindings VALUES(role_id,database_role,worker_principal,target_scope,profile_id,gen_random_uuid(),TRUE)
      ON CONFLICT(role_oid,scope_id,profile) DO UPDATE SET role_name=EXCLUDED.role_name,principal_id=EXCLUDED.principal_id,generation=EXCLUDED.generation,enabled=TRUE;
  ELSE
    UPDATE extraction_worker_bindings SET enabled=FALSE,generation=gen_random_uuid() WHERE role_name=database_role AND scope_id=target_scope AND profile=profile_id;
    IF NOT FOUND THEN RAISE check_violation USING MESSAGE='extraction binding unavailable'; END IF;
  END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',target_scope,jsonb_build_object('operation','extraction_worker_bound','enabled',enable));
END $$;

CREATE FUNCTION continuum_extraction_binding(target_scope UUID,profile_id TEXT) RETURNS extraction_worker_bindings LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE binding extraction_worker_bindings%ROWTYPE;
BEGIN
  PERFORM continuum_extraction_assert_worker(session_user);
  SELECT b.* INTO binding FROM extraction_worker_bindings b JOIN pg_roles role ON role.oid=b.role_oid AND role.rolname=b.role_name
    WHERE role.rolname=session_user AND b.scope_id=target_scope AND b.profile=profile_id AND b.enabled FOR SHARE OF b;
  IF binding.role_oid IS NULL OR NOT continuum_evidence_can_access(binding.principal_id,target_scope,TRUE) THEN
    RAISE insufficient_privilege USING MESSAGE='extraction worker unavailable'; END IF;
  RETURN binding;
END $$;

CREATE FUNCTION continuum_extraction_gate(run_id UUID,worker UUID,epoch BIGINT,disclosure BOOLEAN) RETURNS extraction_runs LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE; binding extraction_worker_bindings%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM extraction_runs WHERE id=run_id FOR UPDATE;
  binding:=continuum_extraction_binding(job.scope_id,job.profile);
  PERFORM continuum_evidence_lock(binding.principal_id,ARRAY[job.source_version],job.scope_id);
  PERFORM scope_id FROM extraction_scope_config WHERE scope_id=job.scope_id FOR SHARE;
  PERFORM id FROM extraction_profiles WHERE id=job.profile FOR SHARE;
  IF job.state<>'running' OR job.owner IS DISTINCT FROM worker OR job.generation IS DISTINCT FROM epoch
    OR job.login_oid<>binding.role_oid OR job.binding_generation<>binding.generation OR job.lease_until<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM extraction_scope_config WHERE scope_id=job.scope_id AND profile=job.profile AND enabled AND generation=job.config_generation)
    OR NOT EXISTS(SELECT 1 FROM extraction_profiles WHERE id=job.profile AND enabled AND generation=job.profile_generation AND descriptor=job.descriptor)
    OR NOT EXISTS(SELECT 1 FROM evidence_roots WHERE source_memory_id=job.memory_id AND current_version=job.source_version AND NOT revoked)
    OR NOT continuum_evidence_eligible(binding.principal_id,job.source_version,CASE WHEN disclosure THEN job.descriptor->>'locality' END)
    OR NOT EXISTS(SELECT 1 FROM pipeline_budget_workflows WHERE id=job.workflow_id AND owner=job.budget_owner AND generation=job.budget_generation AND NOT cancelled AND deadline_at>clock_timestamp()) THEN
    RAISE check_violation USING MESSAGE='extraction work unavailable'; END IF;
  RETURN job;
END $$;

CREATE FUNCTION continuum_extraction_claim(profile_id TEXT,worker UUID,descriptor JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE; binding extraction_worker_bindings%ROWTYPE;
BEGIN
  PERFORM continuum_extraction_assert_worker(session_user);
  IF worker IS NULL THEN RAISE check_violation USING MESSAGE='invalid extraction worker'; END IF;
  SELECT j.* INTO job FROM extraction_runs j JOIN extraction_worker_bindings b ON b.scope_id=j.scope_id AND b.profile=j.profile
    JOIN pg_roles role ON role.oid=b.role_oid AND role.rolname=b.role_name
    WHERE role.rolname=session_user AND b.enabled AND j.profile=profile_id AND j.descriptor=continuum_extraction_claim.descriptor
      AND ((j.state='queued' AND j.retry_at<=clock_timestamp()) OR (j.state='running' AND j.lease_until<=clock_timestamp()))
    ORDER BY j.retry_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1;
  IF job.id IS NULL THEN RETURN NULL; END IF;
  binding:=continuum_extraction_binding(job.scope_id,job.profile);
  IF job.state='running' THEN
    UPDATE extraction_runs SET state='unavailable',reason='ambiguous',generation=generation+1,owner=NULL,lease_until=NULL WHERE id=job.id;
    INSERT INTO extraction_receipts(run_id,generation,outcome,reason) VALUES(job.id,job.generation+1,'unavailable','ambiguous');
    RETURN jsonb_build_object('outcome','unavailable');
  END IF;
  PERFORM continuum_pipeline_create(job.workflow_id,job.budget_owner,job.descriptor->'budget');
  IF job.started_at IS NULL THEN
    UPDATE pipeline_budget_workflows SET used=jsonb_set(used,'{storageBytes}',to_jsonb(job.source_bytes+continuum_extraction_control_bytes(job.descriptor))) WHERE id=job.workflow_id;
  END IF;
  UPDATE extraction_runs SET state='running',owner=worker,login_oid=binding.role_oid,binding_generation=binding.generation,
    generation=generation+1,lease_until=clock_timestamp()+interval '30 seconds',started_at=COALESCE(started_at,clock_timestamp()) WHERE id=job.id RETURNING * INTO job;
  BEGIN PERFORM continuum_extraction_gate(job.id,worker,job.generation,TRUE);
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN
    UPDATE extraction_runs SET state='unavailable',reason='policy',owner=NULL,lease_until=NULL WHERE id=job.id;
    INSERT INTO extraction_receipts(run_id,generation,outcome,reason) VALUES(job.id,job.generation,'unavailable','policy');
    RETURN jsonb_build_object('outcome','unavailable');
  END;
  INSERT INTO extraction_receipts(run_id,generation,outcome) VALUES(job.id,job.generation,'claimed');
  IF NOT EXISTS(SELECT 1 FROM extraction_attempts WHERE run_id=job.id) THEN
    INSERT INTO extraction_attempts(run_id,chunk_index,attempt_owner,attempt_generation,login_oid,claim_generation)
      VALUES(job.id,0,job.budget_owner,job.budget_generation,binding.role_oid,job.generation);
  END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(binding.principal_id,'write',job.scope_id,jsonb_build_object('operation','extraction_claimed'));
  RETURN jsonb_build_object('outcome','claimed','id',job.id,'generation',job.generation,'sourceVersion',job.source_version,'sourceBytes',job.source_bytes,
    'descriptor',job.descriptor,'workflow',continuum_pipeline_read(job.workflow_id),'leaseUntil',job.lease_until,
    'attempts',(SELECT jsonb_agg(jsonb_build_object('id',a.attempt_id,'index',a.chunk_index,'generation',a.claim_generation,'state',p.state))
      FROM extraction_attempts a LEFT JOIN pipeline_budget_attempts p ON p.workflow_id=job.workflow_id AND p.attempt_id=a.attempt_id WHERE a.run_id=job.id));
END $$;

CREATE FUNCTION continuum_extraction_budget(run_id UUID,worker UUID,epoch BIGINT,attempt UUID,phase TEXT,value JSONB,retained BIGINT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE; original extraction_attempts%ROWTYPE; binding extraction_worker_bindings%ROWTYPE; result BOOLEAN;
BEGIN
  SELECT * INTO STRICT job FROM extraction_runs WHERE id=run_id FOR UPDATE;
  IF phase='settle' THEN
    -- Late settlement can release actual process resources after revocation or
    -- lease loss, using only the original bound LOGIN and accounting identities.
    SELECT * INTO STRICT original FROM extraction_attempts WHERE run_id=job.id AND attempt_id=attempt;
    IF original.login_oid IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=session_user) THEN RAISE insufficient_privilege USING MESSAGE='extraction settlement unavailable'; END IF;
    result:=continuum_pipeline_settle(job.workflow_id,attempt,original.attempt_owner,original.attempt_generation,value);
    RETURN to_jsonb(result);
  END IF;
  job:=continuum_extraction_gate(run_id,worker,epoch,TRUE);
  IF phase='attach' THEN
    IF attempt IS NULL OR (value->>'index')::int NOT BETWEEN 0 AND job.chunk_count-1
      OR (SELECT count(*) FROM extraction_attempts WHERE run_id=job.id)>=(job.descriptor->'budget'->'limits'->>'calls')::bigint
      OR NOT EXISTS(SELECT 1 FROM extraction_chunks WHERE run_id=job.id AND chunk_index=(value->>'index')::int AND state='pending')
      OR EXISTS(SELECT 1 FROM extraction_attempts a LEFT JOIN pipeline_budget_attempts p ON p.workflow_id=job.workflow_id AND p.attempt_id=a.attempt_id
        WHERE a.run_id=job.id AND (p.state IS DISTINCT FROM 'settled') AND NOT EXISTS(SELECT 1 FROM extraction_abandoned_attempts WHERE attempt_id=a.attempt_id)) THEN RETURN 'false'::jsonb; END IF;
    INSERT INTO extraction_attempts(run_id,attempt_id,chunk_index,attempt_owner,attempt_generation,login_oid,claim_generation)
      VALUES(job.id,attempt,(value->>'index')::int,job.budget_owner,job.budget_generation,job.login_oid,job.generation);
    RETURN 'true'::jsonb;
  END IF;
  SELECT * INTO STRICT original FROM extraction_attempts WHERE run_id=job.id AND attempt_id=attempt;
  IF original.claim_generation<>epoch OR original.login_oid<>job.login_oid OR EXISTS(SELECT 1 FROM extraction_abandoned_attempts WHERE attempt_id=attempt) THEN RETURN 'false'::jsonb; END IF;
  IF phase='reserve' THEN
    -- Retries are charged from durable history, not a caller-selected flag.
    value:=jsonb_set(value,'{retries}',to_jsonb(CASE WHEN EXISTS(SELECT 1 FROM extraction_attempts a
      JOIN pipeline_budget_attempts p ON p.attempt_id=a.attempt_id AND p.workflow_id=job.workflow_id
      WHERE a.run_id=job.id AND a.chunk_index=original.chunk_index AND a.attempt_id<>attempt) THEN 1 ELSE 0 END));
    result:=continuum_pipeline_reserve(job.workflow_id,attempt,original.attempt_owner,original.attempt_generation,value,retained);
  ELSIF phase='dispatch' THEN
    result:=continuum_pipeline_dispatch(job.workflow_id,attempt,original.attempt_owner,original.attempt_generation);
    IF result THEN INSERT INTO extraction_dispatch_receipts VALUES(attempt); END IF;
  ELSIF phase='authorize' THEN RETURN 'true'::jsonb;
  ELSE RAISE check_violation USING MESSAGE='invalid extraction accounting phase'; END IF;
  RETURN to_jsonb(result);
END $$;

CREATE FUNCTION continuum_extraction_apply(run_id UUID,worker UUID,epoch BIGINT,chunk_number INTEGER,attempt UUID,output JSONB,failure TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE; chunk extraction_chunks%ROWTYPE; binding extraction_worker_bindings%ROWTYPE; a JSONB; citation JSONB;
  source BYTEA; payload TEXT; version UUID; versions UUID[]:='{}'; w pipeline_budget_workflows%ROWTYPE; bytes BIGINT:=0; n INTEGER;
BEGIN
  job:=continuum_extraction_gate(run_id,worker,epoch,FALSE);
  binding:=continuum_extraction_binding(job.scope_id,job.profile);
  SELECT * INTO STRICT chunk FROM extraction_chunks WHERE run_id=job.id AND chunk_index=chunk_number FOR UPDATE;
  IF chunk.state<>'pending' THEN RETURN to_jsonb(chunk.assertions); END IF;
  IF NOT EXISTS(SELECT 1 FROM extraction_attempts a JOIN pipeline_budget_attempts p ON p.workflow_id=job.workflow_id AND p.attempt_id=a.attempt_id
      WHERE a.run_id=job.id AND a.attempt_id=attempt AND a.chunk_index=chunk_number AND a.claim_generation=epoch
        AND p.state='settled' AND EXISTS(SELECT 1 FROM extraction_dispatch_receipts WHERE attempt_id=attempt)) THEN
    -- Pre-dispatch skips have no generated result, but still produce explicit coverage.
    IF output IS NOT NULL THEN RAISE check_violation USING MESSAGE='unsettled extraction result'; END IF;
  END IF;
  IF failure IS NOT NULL AND failure NOT IN ('budget','policy','invalid-output','transient','permanent','ambiguous','deadline','cancelled') THEN RAISE check_violation USING MESSAGE='invalid extraction outcome'; END IF;
  IF failure='transient' THEN
    SELECT * INTO STRICT w FROM pipeline_budget_workflows WHERE id=job.workflow_id FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM extraction_attempts a JOIN pipeline_budget_attempts p ON p.workflow_id=job.workflow_id AND p.attempt_id=a.attempt_id
      WHERE a.run_id=job.id AND a.attempt_id=attempt AND p.state='settled') OR w.active<>0 THEN RAISE check_violation USING MESSAGE='unsettled extraction retry'; END IF;
    UPDATE extraction_runs SET state='queued',reason='transient',retry_at=clock_timestamp()+interval '100 milliseconds',owner=NULL,lease_until=NULL WHERE id=job.id;
    INSERT INTO extraction_receipts(run_id,generation,outcome,reason) VALUES(job.id,job.generation,'retry','transient');
    RETURN '[]'::jsonb;
  END IF;
  IF output IS NOT NULL THEN
    IF failure IS NOT NULL OR jsonb_typeof(output) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(output))<>1
      OR jsonb_typeof(output->'assertions') IS DISTINCT FROM 'array' OR jsonb_array_length(output->'assertions')>16
      OR octet_length(output::text)>65536 THEN RAISE check_violation USING MESSAGE='invalid extraction output'; END IF;
    SELECT convert_to(p.payload,'UTF8') INTO STRICT source FROM evidence_payloads p WHERE p.version_id=job.source_version;
    FOR a IN SELECT value FROM jsonb_array_elements(output->'assertions') LOOP
      IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['text','type','unknown','unsupported','temporal','citations'])
        OR (SELECT count(*) FROM jsonb_object_keys(a))<>6 OR jsonb_typeof(a->'text')<>'string' OR length(a->>'text') NOT BETWEEN 1 AND 4000
        OR jsonb_typeof(a->'type') IS DISTINCT FROM 'string' OR a->>'type' NOT IN ('fact','intent','decision','unknown') OR jsonb_typeof(a->'unknown')<>'boolean'
        OR jsonb_typeof(a->'unsupported')<>'array' OR jsonb_array_length(a->'unsupported')>16
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'unsupported') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 100)
        OR jsonb_typeof(a->'temporal')<>'object' OR NOT(a->'temporal' ?& ARRAY['value','uncertain']) OR (SELECT count(*) FROM jsonb_object_keys(a->'temporal'))<>2
        OR jsonb_typeof(a->'temporal'->'uncertain')<>'boolean' OR jsonb_typeof(a->'temporal'->'value') NOT IN ('string','null')
        OR (jsonb_typeof(a->'temporal'->'value')='string' AND length(a->'temporal'->>'value') NOT BETWEEN 1 AND 100)
        OR jsonb_typeof(a->'citations')<>'array' OR jsonb_array_length(a->'citations') NOT BETWEEN 1 AND 8 THEN RAISE check_violation USING MESSAGE='invalid extraction assertion'; END IF;
      FOR citation IN SELECT value FROM jsonb_array_elements(a->'citations') LOOP
        IF jsonb_typeof(citation) IS DISTINCT FROM 'object' OR NOT(citation ?& ARRAY['start','end','quote']) OR (SELECT count(*) FROM jsonb_object_keys(citation))<>3
          OR jsonb_typeof(citation->'start') IS DISTINCT FROM 'number' OR jsonb_typeof(citation->'end') IS DISTINCT FROM 'number'
          OR citation->>'start' !~ '^(0|[1-9][0-9]*)$' OR citation->>'end' !~ '^[1-9][0-9]*$'
          OR (citation->>'start')::numeric<chunk.start_byte OR (citation->>'end')::numeric>chunk.end_byte
          OR (citation->>'end')::numeric<=(citation->>'start')::numeric OR jsonb_typeof(citation->'quote')<>'string'
          OR length(citation->>'quote') NOT BETWEEN 1 AND 8192 THEN RAISE check_violation USING MESSAGE='invalid extraction citation'; END IF;
        IF convert_from(substring(source FROM (citation->>'start')::int+1 FOR (citation->>'end')::int-(citation->>'start')::int),'UTF8') IS DISTINCT FROM citation->>'quote' THEN RAISE check_violation USING MESSAGE='invalid extraction citation'; END IF;
      END LOOP;
      payload:=jsonb_build_object('schema','extraction-v1','status','generated/unverified','sourceVersion',job.source_version,
        'sourceFamily',job.source_version,'runId',job.id,'chunkId',chunk.chunk_id,'assertion',a)::text;
      bytes:=bytes+octet_length(payload)+4096;
      version:=continuum_evidence_register(binding.principal_id,gen_random_uuid(),NULL,job.scope_id,'extracted-assertion',
        jsonb_build_array(jsonb_build_object('versionId',job.source_version,'kind','source')),
        jsonb_build_object('transform',job.descriptor->>'version','model',job.descriptor->>'model','prompt','source-reference-v1','schema','extraction-v1'),payload);
      versions:=array_append(versions,version);
    END LOOP;
    SELECT * INTO STRICT w FROM pipeline_budget_workflows WHERE id=job.workflow_id FOR UPDATE;
    IF bytes>(w.profile->'limits'->>'artifactBytes')::bigint-(w.used->>'artifactBytes')::bigint
      OR bytes>(w.profile->'limits'->>'storageBytes')::bigint-(w.used->>'storageBytes')::bigint THEN RAISE program_limit_exceeded USING MESSAGE='extraction storage unavailable'; END IF;
    UPDATE pipeline_budget_workflows SET used=jsonb_set(jsonb_set(used,'{artifactBytes}',to_jsonb((used->>'artifactBytes')::bigint+bytes)),
      '{storageBytes}',to_jsonb((used->>'storageBytes')::bigint+bytes)) WHERE id=w.id;
  ELSIF failure IS NULL THEN RAISE check_violation USING MESSAGE='missing extraction outcome'; END IF;
  PERFORM continuum_extraction_gate(run_id,worker,epoch,FALSE);
  UPDATE extraction_chunks SET state=CASE WHEN output IS NULL THEN 'skipped' ELSE 'complete' END,assertions=versions,reason=failure WHERE run_id=job.id AND chunk_index=chunk_number;
  UPDATE extraction_runs SET completed=(SELECT count(*) FROM extraction_chunks WHERE run_id=job.id AND state='complete'),
    skipped=(SELECT count(*) FROM extraction_chunks WHERE run_id=job.id AND state='skipped'),
    assertion_count=(SELECT COALESCE(sum(cardinality(assertions)),0) FROM extraction_chunks WHERE run_id=job.id) WHERE id=job.id RETURNING * INTO job;
  IF job.completed+job.skipped=job.chunk_count THEN
    UPDATE extraction_runs SET state=CASE WHEN skipped=0 THEN 'complete' WHEN completed=0 THEN 'skipped' ELSE 'partial' END,
      reason=failure,finished_at=clock_timestamp(),owner=NULL,lease_until=NULL WHERE id=job.id;
    INSERT INTO extraction_receipts(run_id,generation,outcome,reason) SELECT id,generation,state,reason FROM extraction_runs WHERE id=job.id;
  END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(binding.principal_id,'write',job.scope_id,
    jsonb_build_object('operation','extraction_chunk_finished','outcome',CASE WHEN output IS NULL THEN 'skipped' ELSE 'complete' END,'assertions',cardinality(versions)));
  RETURN to_jsonb(versions);
END $$;

CREATE FUNCTION continuum_extraction_stop(run_id UUID,worker UUID,epoch BIGINT,failure TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM extraction_runs WHERE id=run_id FOR UPDATE;
  IF job.login_oid IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=session_user) OR job.owner IS DISTINCT FROM worker OR job.generation IS DISTINCT FROM epoch
    OR job.state<>'running' OR failure IS NULL OR failure NOT IN ('budget','policy','invalid-output','permanent','ambiguous','deadline','cancelled') THEN RAISE insufficient_privilege USING MESSAGE='extraction cancellation unavailable'; END IF;
  UPDATE pipeline_budget_workflows SET cancelled=TRUE,generation=generation+1 WHERE id=job.workflow_id AND NOT cancelled;
  UPDATE extraction_chunks SET state='skipped',reason=failure WHERE run_id=job.id AND state='pending';
  UPDATE extraction_runs SET state=CASE WHEN completed>0 THEN 'partial' ELSE 'unavailable' END,reason=failure,owner=NULL,lease_until=NULL,finished_at=clock_timestamp(),generation=generation+1,
    skipped=(SELECT count(*) FROM extraction_chunks WHERE run_id=job.id AND state='skipped') WHERE id=job.id;
  INSERT INTO extraction_receipts(run_id,generation,outcome,reason) SELECT id,generation,state,reason FROM extraction_runs WHERE id=job.id;
END $$;

CREATE FUNCTION continuum_extraction_status(actor UUID,memory UUID,include_assertions BOOLEAN) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE scope UUID; job extraction_runs%ROWTYPE; result JSONB; versions UUID[]; version UUID;
BEGIN
  SELECT scope_id INTO scope FROM memories WHERE id=memory AND state='live' AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE;
  IF scope IS NULL OR NOT continuum_evidence_can_access(actor,scope,FALSE) THEN RAISE insufficient_privilege USING MESSAGE='extraction unavailable'; END IF;
  SELECT * INTO job FROM extraction_runs WHERE memory_id=memory ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE;
  IF job.id IS NULL THEN result:=jsonb_build_object('status','not-configured');
  ELSE
    PERFORM continuum_evidence_lock(actor,ARRAY[job.source_version]);
    IF job.source_version IS NOT NULL AND (NOT continuum_evidence_eligible(actor,job.source_version,NULL)
      OR NOT EXISTS(SELECT 1 FROM evidence_roots WHERE source_memory_id=memory AND current_version=job.source_version)) THEN RAISE insufficient_privilege USING MESSAGE='extraction unavailable'; END IF;
    result:=jsonb_build_object('status',job.state,'runId',job.id,'sourceVersion',job.source_version,'profile',job.profile,'generation',job.generation,
      'chunks',job.chunk_count,'completed',job.completed,'skipped',job.skipped,'assertions',job.assertion_count,'reason',job.reason,
      'createdAt',job.created_at,'startedAt',job.started_at,'finishedAt',job.finished_at,'identity',job.descriptor-'budget'-'accounting'-'price',
      'cutoffAt',(SELECT deadline_at FROM pipeline_budget_workflows WHERE id=job.workflow_id),
      'budget',(SELECT jsonb_build_object('profile',w.profile->>'id','currency',w.profile->>'currency','rateSchedule',w.profile->>'rateSchedule',
        'charged',w.used,'active',w.active,'retainedBytes',w.retained_bytes,'cancelled',w.cancelled,
        'settledAttempts',(SELECT count(*) FROM pipeline_budget_attempts WHERE workflow_id=w.id AND state='settled'),
        'unsettledAttempts',(SELECT count(*) FROM pipeline_budget_attempts WHERE workflow_id=w.id AND state<>'settled')) FROM pipeline_budget_workflows w WHERE w.id=job.workflow_id),
      'receipts',(SELECT COALESCE(jsonb_agg(to_jsonb(r)-'id' ORDER BY r.id),'[]'::jsonb) FROM (
        SELECT id,generation,outcome,reason,created_at FROM extraction_receipts WHERE run_id=job.id ORDER BY id DESC LIMIT 32) r),
      'receiptsTruncated',(SELECT count(*)>32 FROM (SELECT id FROM extraction_receipts WHERE run_id=job.id LIMIT 33) bounded),
      'coverage',(SELECT COALESCE(jsonb_agg(jsonb_build_object('index',chunk_index,'status',state,'reason',reason) ORDER BY chunk_index),'[]'::jsonb) FROM extraction_chunks WHERE run_id=job.id));
    SELECT array_agg(v) INTO versions FROM extraction_chunks c,LATERAL unnest(c.assertions) v WHERE c.run_id=job.id;
    IF cardinality(versions)>1024 THEN RAISE check_violation USING MESSAGE='extraction read bounds exceeded'; END IF;
    FOR version IN SELECT unnest(versions) LOOP
      PERFORM continuum_evidence_lock(actor,ARRAY[version]);
      IF NOT continuum_evidence_eligible(actor,version,NULL) THEN RAISE insufficient_privilege USING MESSAGE='extraction unavailable'; END IF;
    END LOOP;
    IF include_assertions THEN
      IF (SELECT COALESCE(sum(octet_length(payload)),0) FROM evidence_payloads WHERE version_id=ANY(versions))>262144 THEN RAISE check_violation USING MESSAGE='extraction read bounds exceeded'; END IF;
      result:=result||jsonb_build_object('items',(SELECT COALESCE(jsonb_agg(jsonb_build_object('versionId',p.version_id,'data',p.payload::jsonb) ORDER BY p.version_id),'[]'::jsonb)
        FROM evidence_payloads p WHERE p.version_id=ANY(versions)));
      IF octet_length(result::text)>262144 THEN RAISE check_violation USING MESSAGE='extraction read bounds exceeded'; END IF;
    END IF;
  END IF;
  INSERT INTO audit_log(principal_id,action,memory_id,scope_id,metadata) VALUES(actor,'read',memory,scope,jsonb_build_object('operation','extraction_read','assertions',include_assertions));
  IF NOT continuum_evidence_can_access(actor,scope,FALSE) OR (job.source_version IS NOT NULL AND NOT continuum_evidence_eligible(actor,job.source_version,NULL)) THEN RAISE insufficient_privilege USING MESSAGE='extraction unavailable'; END IF;
  RETURN result;
END $$;

CREATE FUNCTION continuum_extraction_retry(actor UUID,memory UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE; result JSONB;
BEGIN
  result:=continuum_extraction_status(actor,memory,FALSE);
  SELECT * INTO STRICT job FROM extraction_runs WHERE id=(result->>'runId')::uuid FOR UPDATE;
  IF NOT continuum_extraction_scope_admin(actor,job.scope_id) THEN RAISE insufficient_privilege USING MESSAGE='extraction retry unavailable'; END IF;
  IF job.state NOT IN ('queued','unavailable') OR job.reason IS DISTINCT FROM 'transient'
    OR NOT EXISTS(SELECT 1 FROM extraction_scope_config WHERE scope_id=job.scope_id AND generation=job.config_generation AND enabled)
    OR NOT EXISTS(SELECT 1 FROM extraction_profiles WHERE id=job.profile AND generation=job.profile_generation AND enabled)
    OR NOT EXISTS(SELECT 1 FROM pipeline_budget_workflows WHERE id=job.workflow_id AND active=0 AND NOT cancelled AND deadline_at>clock_timestamp()
      AND (used->>'calls')::bigint<(profile->'limits'->>'calls')::bigint AND (used->>'retries')::bigint<(profile->'limits'->>'retries')::bigint) THEN
    RAISE check_violation USING MESSAGE='extraction original allowance unavailable'; END IF;
  IF job.state='queued' THEN
    UPDATE extraction_runs SET retry_at=clock_timestamp() WHERE id=job.id;
  ELSE
    UPDATE extraction_runs SET state='queued',retry_at=clock_timestamp(),generation=generation+1,owner=NULL,lease_until=NULL WHERE id=job.id;
    INSERT INTO extraction_receipts(run_id,generation,outcome) VALUES(job.id,job.generation+1,'retry');
  END IF;
  INSERT INTO audit_log(principal_id,action,memory_id,scope_id,metadata) VALUES(actor,'write',memory,job.scope_id,jsonb_build_object('operation','extraction_retry'));
  RETURN jsonb_build_object('status','queued','runId',job.id);
END $$;

CREATE FUNCTION continuum_operator_recover_extraction(actor UUID,run_id UUID,attempt UUID,confirmation TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE; original extraction_attempts%ROWTYPE; accounting pipeline_budget_attempts%ROWTYPE;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF confirmation IS DISTINCT FROM 'CONFIRMED ORIGINAL PROCESS EXIT' THEN RAISE check_violation USING MESSAGE='extraction recovery requires proved process exit'; END IF;
  SELECT * INTO STRICT job FROM extraction_runs WHERE id=run_id FOR UPDATE;
  IF job.state='running' AND job.lease_until>clock_timestamp() THEN RAISE check_violation USING MESSAGE='extraction worker lease is active'; END IF;
  SELECT * INTO STRICT original FROM extraction_attempts WHERE run_id=job.id AND attempt_id=attempt;
  SELECT * INTO accounting FROM pipeline_budget_attempts WHERE workflow_id=job.workflow_id AND attempt_id=attempt;
  IF EXISTS(SELECT 1 FROM extraction_recoveries WHERE attempt_id=attempt) THEN
    RETURN (SELECT jsonb_build_object('accounting',r.accounting,'renewed',FALSE) FROM extraction_recoveries r WHERE r.attempt_id=attempt);
  END IF;
  IF accounting.attempt_id IS NOT NULL AND accounting.state<>'settled' THEN
    PERFORM continuum_pipeline_settle(job.workflow_id,attempt,original.attempt_owner,original.attempt_generation,'{"provenance":"unknown"}'::jsonb);
  ELSIF accounting.attempt_id IS NULL THEN
    INSERT INTO extraction_abandoned_attempts VALUES(attempt) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO extraction_recoveries VALUES(attempt,CASE WHEN accounting.attempt_id IS NULL THEN 'no-reservation' ELSE 'settled' END);
  -- Recovery never creates a workflow or renews a deadline, and never restores
  -- a cancelled job. A live remaining allowance can be retried by its scope admin.
  IF job.state<>'cancelled' THEN
    UPDATE extraction_runs SET state='unavailable',reason=CASE WHEN EXISTS(SELECT 1 FROM pipeline_budget_workflows
      WHERE id=job.workflow_id AND NOT cancelled AND deadline_at>clock_timestamp() AND active=0) THEN 'transient' ELSE 'deadline' END,
      owner=NULL,lease_until=NULL,generation=generation+1 WHERE id=job.id;
    INSERT INTO extraction_receipts(run_id,generation,outcome,reason) SELECT id,generation,state,reason FROM extraction_runs WHERE id=job.id;
  END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',job.scope_id,jsonb_build_object('operation','extraction_process_exit_reconciled'));
  RETURN jsonb_build_object('accounting',CASE WHEN accounting.attempt_id IS NULL THEN 'no-reservation' ELSE 'settled' END,'renewed',FALSE);
END $$;

CREATE FUNCTION continuum_extraction_hydrate(run_id UUID,worker UUID,epoch BIGINT) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE; binding extraction_worker_bindings%ROWTYPE; result TEXT; w pipeline_budget_workflows%ROWTYPE;
BEGIN
  job:=continuum_extraction_gate(run_id,worker,epoch,TRUE);
  binding:=continuum_extraction_binding(job.scope_id,job.profile);
  SELECT * INTO STRICT w FROM pipeline_budget_workflows WHERE id=job.workflow_id FOR UPDATE;
  IF job.source_bytes>(w.profile->>'maxItemHydratedBytes')::int OR job.source_bytes>(w.profile->'limits'->>'hydratedBytes')::bigint-(w.used->>'hydratedBytes')::bigint
    OR (w.used->>'candidates')::bigint>=(w.profile->'limits'->>'candidates')::bigint THEN RAISE check_violation USING MESSAGE='extraction hydration unavailable'; END IF;
  UPDATE pipeline_budget_workflows SET used=jsonb_set(jsonb_set(used,'{hydratedBytes}',to_jsonb((used->>'hydratedBytes')::bigint+job.source_bytes)),
    '{candidates}',to_jsonb((used->>'candidates')::bigint+1)) WHERE id=w.id;
  result:=continuum_evidence_payload(binding.principal_id,job.source_version,job.descriptor->>'locality');
  IF result IS NULL OR octet_length(result)<>job.source_bytes THEN RAISE check_violation USING MESSAGE='extraction hydration unavailable'; END IF;
  PERFORM continuum_extraction_gate(run_id,worker,epoch,TRUE);
  RETURN result;
END $$;

CREATE FUNCTION continuum_extraction_prepare(run_id UUID,worker UUID,epoch BIGINT,chunks JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
#variable_conflict use_column
DECLARE job extraction_runs%ROWTYPE; c JSONB; previous_end INTEGER:=0; count INTEGER:=0; source TEXT; bytes BYTEA; digest TEXT; planned_id TEXT;
BEGIN
  job:=continuum_extraction_gate(run_id,worker,epoch,TRUE);
  IF jsonb_typeof(chunks) IS DISTINCT FROM 'array' OR jsonb_array_length(chunks) NOT BETWEEN 1 AND (job.descriptor->>'maxChunks')::int THEN RAISE check_violation USING MESSAGE='invalid extraction chunks'; END IF;
  SELECT payload INTO STRICT source FROM evidence_payloads WHERE version_id=job.source_version;
  bytes:=convert_to(source,'UTF8');
  FOR c IN SELECT value FROM jsonb_array_elements(chunks) LOOP
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR NOT(c ?& ARRAY['id','hash','index','start','end'])
      OR (SELECT count(*) FROM jsonb_object_keys(c))<>5
      OR jsonb_typeof(c->'index') IS DISTINCT FROM 'number' OR jsonb_typeof(c->'start') IS DISTINCT FROM 'number' OR jsonb_typeof(c->'end') IS DISTINCT FROM 'number'
      OR c->>'index' !~ '^(0|[1-9][0-9]*)$' OR c->>'start' !~ '^(0|[1-9][0-9]*)$' OR c->>'end' !~ '^[1-9][0-9]*$'
      OR (c->>'index')::int<>count OR (c->>'start')::int<>previous_end OR (c->>'end')::int<=previous_end
      OR (c->>'end')::int>octet_length(bytes) OR (c->>'end')::int-previous_end>(job.descriptor->>'chunkBytes')::int THEN RAISE check_violation USING MESSAGE='invalid extraction chunks'; END IF;
    -- convert_from rejects invalid UTF-8 chunk boundaries.
    PERFORM convert_from(substring(bytes FROM previous_end+1 FOR (c->>'end')::int-previous_end),'UTF8');
    digest:=encode(sha256(substring(bytes FROM previous_end+1 FOR (c->>'end')::int-previous_end)),'hex');
    planned_id:=encode(sha256(convert_to(job.source_version::text||':'||previous_end::text||':'||(c->>'end')||':'||digest,'UTF8')),'hex');
    IF c->>'hash' IS DISTINCT FROM digest OR c->>'id' IS DISTINCT FROM planned_id THEN RAISE check_violation USING MESSAGE='invalid extraction chunks'; END IF;
    INSERT INTO extraction_chunks(run_id,chunk_index,chunk_id,content_hash,start_byte,end_byte)
      VALUES(job.id,count,planned_id,digest,previous_end,(c->>'end')::int) ON CONFLICT DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM extraction_chunks WHERE run_id=job.id AND chunk_index=count AND extraction_chunks.chunk_id=planned_id
      AND content_hash=digest AND start_byte=previous_end AND end_byte=(c->>'end')::int) THEN RAISE check_violation USING MESSAGE='conflicting extraction chunks'; END IF;
    previous_end:=(c->>'end')::int; count:=count+1;
  END LOOP;
  IF previous_end<>octet_length(bytes) THEN RAISE check_violation USING MESSAGE='incomplete extraction chunks'; END IF;
  UPDATE extraction_runs SET chunk_count=count WHERE id=job.id;
  RETURN (SELECT jsonb_agg(jsonb_build_object('index',chunk_index,'state',state) ORDER BY chunk_index) FROM extraction_chunks WHERE run_id=job.id);
END $$;

CREATE TABLE extraction_contract_functions(signature TEXT PRIMARY KEY,body_hash TEXT NOT NULL,definer BOOLEAN NOT NULL,volatility "char" NOT NULL);
REVOKE ALL ON extraction_contract_functions FROM PUBLIC;
CREATE FUNCTION continuum_extraction_is_ready() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_evidence_is_ready() AND continuum_pipeline_budgets_is_ready()
    AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('extraction_attempts'::regclass,'extraction_attempt_immutable'),('extraction_receipts'::regclass,'extraction_receipt_immutable'),
      ('extraction_dispatch_receipts'::regclass,'extraction_dispatch_immutable'),('extraction_abandoned_attempts'::regclass,'extraction_abandoned_immutable'),
      ('extraction_recoveries'::regclass,'extraction_recovery_immutable')) expected(relation,name)
      LEFT JOIN pg_trigger t ON t.tgrelid=expected.relation AND t.tgname=expected.name
      WHERE t.oid IS NULL OR t.tgenabled<>'O' OR t.tgtype<>27 OR t.tgfoid<>'continuum_evidence_immutable()'::regprocedure)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='extraction_runs'::regclass AND tgname='extraction_run_identity' AND tgenabled='O'
      AND tgfoid='continuum_extraction_run_identity()'::regprocedure AND tgtype=19)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='memories'::regclass AND tgname='extraction_capture_enqueue' AND tgenabled='O'
      AND tgfoid='continuum_extraction_enqueue()'::regprocedure AND tgtype=5)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='evidence_payloads'::regclass AND tgname='extraction_source_erased' AND tgenabled='O'
      AND tgfoid='continuum_extraction_source_erased()'::regprocedure AND tgtype=9)
    AND EXISTS(SELECT 1 FROM extraction_contract_functions)
    AND NOT EXISTS(SELECT 1 FROM extraction_contract_functions contract LEFT JOIN pg_proc f ON f.oid=to_regprocedure(contract.signature)
      WHERE f.oid IS NULL OR encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>contract.body_hash OR f.prosecdef<>contract.definer
        OR f.provolatile<>contract.volatility OR f.proowner<>(SELECT relowner FROM pg_class WHERE oid='memories'::regclass)
        OR NOT(f.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',(SELECT n.nspname FROM pg_namespace n JOIN pg_class m ON m.relnamespace=n.oid WHERE m.oid='memories'::regclass))])
        OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'));
$$;

DO $$
DECLARE definition TEXT; revised TEXT; signature TEXT;
BEGIN
  definition:=pg_get_functiondef('continuum_guard_evidence_privacy_audit()'::regprocedure);
  revised:=replace(replace(definition,'continuum_guard_evidence_privacy_audit','continuum_guard_extraction_privacy_audit'),
    'principal_evidence_privacy_repaired','principal_extraction_privacy_repaired');
  EXECUTE revised;
  definition:=pg_get_functiondef('continuum_offboarding_expected_audit_metadata(jsonb)'::regprocedure);
  revised:=replace(definition,'  SELECT CASE',$branch$  SELECT CASE
    WHEN audit_metadata->>'operation'='principal_extraction_privacy_repaired' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb) FROM jsonb_each(audit_metadata) entry
        WHERE entry.key=ANY(ARRAY['operation','principal_id','run_id','approval_id','acknowledged_evidence_hash','rows_processed']::text[]))$branch$);
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend extraction audit classifier'; END IF;
  EXECUTE revised;
  definition:=pg_get_functiondef('continuum_reject_offboarded_principal_audit()'::regprocedure);
  revised:=replace(definition,'''principal_evidence_privacy_repaired''','''principal_evidence_privacy_repaired'',''principal_extraction_privacy_repaired''');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend extraction audit admission'; END IF;
  EXECUTE revised;
  FOREACH signature IN ARRAY ARRAY['continuum_redact_offboarding_audit(uuid,uuid,bigint[])','continuum_protect_offboarded_audit_tombstone()',
    'continuum_apply_audit_retention_internal_v44(uuid,timestamp with time zone,integer,uuid,integer,jsonb,text,text)'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'''principal_offboarding_access_revoked''','''principal_offboarding_access_revoked'', ''principal_extraction_privacy_repaired''');
    IF revised=definition THEN RAISE EXCEPTION 'unable to preserve extraction erasure receipts'; END IF;
    EXECUTE revised;
  END LOOP;
END $$;
CREATE TRIGGER guard_extraction_privacy_audit BEFORE INSERT OR UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION continuum_guard_extraction_privacy_audit();

DO $$
DECLARE schema_name TEXT:=current_schema(); f RECORD; signature TEXT; definition TEXT; revised TEXT; candidate RECORD;
  app_signatures TEXT[]:=ARRAY['continuum_extraction_configure(uuid,uuid,text,text[],boolean)',
    'continuum_extraction_status(uuid,uuid,boolean)','continuum_extraction_retry(uuid,uuid)','continuum_extraction_is_ready()'];
  op_signatures TEXT[]:=ARRAY['continuum_operator_install_extractor(uuid,jsonb,boolean)',
    'continuum_operator_bind_extraction_worker(uuid,name,uuid,uuid,text,boolean)','continuum_operator_scrub_extraction_scope(uuid,uuid,uuid,integer)',
    'continuum_operator_recover_extraction(uuid,uuid,uuid,text)'];
BEGIN
  FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=quote_ident(schema_name)::regnamespace
    AND (proname LIKE 'continuum_extraction_%' OR proname LIKE 'continuum_operator_%extract%'
      OR proname IN ('continuum_guard_extraction_privacy_audit','continuum_offboarding_lifecycle_state_is_erased','continuum_offboarding_lifecycle_state_is_erased_pre_extraction')) LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',f.signature,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['continuum_assert_application_role_allowlist(name,boolean)','continuum_assert_standup_application_role_allowlist(name,boolean)'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'(''continuum_standup_is_ready()'')','(''continuum_standup_is_ready()''),('''||replace(array_to_string(app_signatures,'''),('''),' ','')||''')');
    revised:=replace(revised,'(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'')',
      '(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)''),('''||replace(array_to_string(op_signatures,'''),('''),' ','')||''')');
    IF revised=definition THEN RAISE EXCEPTION 'unable to extend extraction allowlist'; END IF;
    EXECUTE revised;
  END LOOP;
  FOR candidate IN SELECT * FROM continuum_extraction_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    FOREACH signature IN ARRAY app_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name); END LOOP;
    IF candidate.operator THEN FOREACH signature IN ARRAY op_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name); END LOOP; END IF;
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END $$;
-- This reviewed forward wrapper extends the prior physical predicate. Preserve
-- the old function as a separately checked dependency rather than weakening it.
UPDATE evidence_contract_functions contract SET body_hash=encode(sha256(convert_to(f.prosrc,'UTF8')),'hex'),definer=f.prosecdef,volatility=f.provolatile
  FROM pg_proc f WHERE contract.signature='continuum_offboarding_lifecycle_state_is_erased(uuid)' AND f.oid='continuum_offboarding_lifecycle_state_is_erased(uuid)'::regprocedure;
INSERT INTO extraction_contract_functions SELECT oid::regprocedure::text,encode(sha256(convert_to(prosrc,'UTF8')),'hex'),prosecdef,provolatile FROM pg_proc
  WHERE pronamespace=quote_ident(current_schema())::regnamespace AND (proname LIKE 'continuum_extraction_%' OR proname LIKE 'continuum_operator_%extract%'
    OR proname IN ('continuum_guard_extraction_privacy_audit','continuum_offboarding_lifecycle_state_is_erased','continuum_offboarding_lifecycle_state_is_erased_pre_extraction'));
