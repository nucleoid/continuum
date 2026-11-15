-- Durable deferred embeddings. Empty operator registries authorize no dispatch.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ DECLARE ledger TEXT; drift BOOLEAN; BEGIN
  IF continuum_connector_is_ready() IS NOT TRUE OR continuum_brief_is_ready() IS NOT TRUE THEN
    RAISE EXCEPTION 'embedding predecessor integrity unavailable'; END IF;
  -- Forward wrapping must not adopt a modified predecessor as its baseline.
  FOREACH ledger IN ARRAY ARRAY['evidence_contract_functions','extraction_contract_functions',
    'memory_event_contract_functions','connector_contract_functions','brief_contract_functions'] LOOP
    IF to_regclass(format('%I.%I',current_schema(),ledger)) IS NULL THEN
      RAISE EXCEPTION 'embedding predecessor integrity unavailable';
    END IF;
    EXECUTE format('SELECT NOT EXISTS(SELECT 1 FROM %I.%I) OR EXISTS(SELECT 1 FROM %I.%I c
      LEFT JOIN pg_proc f ON f.oid=to_regprocedure(c.signature)
      WHERE f.oid IS NULL OR encode(sha256(convert_to(f.prosrc,''UTF8'')),''hex'')<>c.body_hash
        OR f.prosecdef<>c.definer OR f.provolatile<>c.volatility
        OR f.proowner<>(SELECT relowner FROM pg_class WHERE oid=''memories''::regclass)
        OR NOT COALESCE(f.proconfig @> ARRAY[format(''search_path=pg_catalog, %%I, pg_temp'',current_schema())],FALSE)
        OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault(''f'',f.proowner))) acl
          WHERE acl.grantee=0 AND acl.privilege_type=''EXECUTE''))',current_schema(),ledger,current_schema(),ledger) INTO drift;
    IF drift THEN RAISE EXCEPTION 'embedding predecessor integrity unavailable'; END IF;
  END LOOP;
END $$;
CREATE TEMP TABLE continuum_embedding_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $$ DECLARE candidate RECORD; BEGIN
  FOR candidate IN SELECT p.*,r.rolname FROM continuum_pgvector_role_profiles p JOIN pg_roles r ON r.oid=p.database_role_oid
    WHERE profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_embedding_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Continuum skipped embedding grants for role OID % (SQLSTATE %); explicit regrant required',candidate.database_role_oid,SQLSTATE;
    END;
  END LOOP;
END $$;

CREATE TABLE embedding_vector_spaces(
  provider TEXT NOT NULL,dim INTEGER NOT NULL CHECK(dim=768),space_fingerprint TEXT NOT NULL CHECK(space_fingerprint~'^[0-9a-f]{64}$'),
  descriptor JSONB NOT NULL,PRIMARY KEY(provider,dim)
);
CREATE TRIGGER embedding_space_immutable BEFORE UPDATE OR DELETE ON embedding_vector_spaces FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE TABLE embedding_targets(
  fingerprint TEXT PRIMARY KEY CHECK(fingerprint~'^[0-9a-f]{64}$'),descriptor JSONB NOT NULL,
  provider TEXT NOT NULL,dim INTEGER NOT NULL,FOREIGN KEY(provider,dim) REFERENCES embedding_vector_spaces(provider,dim),
  profile JSONB NOT NULL CHECK(continuum_pipeline_valid_profile(profile)),window_policy JSONB NOT NULL,enabled BOOLEAN NOT NULL
);
CREATE TABLE embedding_policy(
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),generation BIGINT NOT NULL CHECK(generation>0),
  digest TEXT NOT NULL CHECK(digest~'^[0-9a-f]{64}$'),routing JSONB NOT NULL,paused BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE embedding_sources(
  memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,generation BIGINT NOT NULL CHECK(generation>0),
  input_hash TEXT CHECK(input_hash~'^[0-9a-f]{64}$'),origin_scope_id UUID NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','retry_wait','ready','not_configured','blocked_policy','permanent_failure','cancelled','superseded')),
  current_target TEXT,erased BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE embedding_source_scopes(
  memory_id UUID NOT NULL REFERENCES embedding_sources(memory_id) ON DELETE CASCADE,scope_id UUID NOT NULL,
  PRIMARY KEY(memory_id,scope_id)
);
CREATE INDEX embedding_source_scope_idx ON embedding_source_scopes(scope_id,memory_id);
CREATE TABLE embedding_jobs(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,scope_id UUID,
  source_generation BIGINT CHECK(source_generation>0),target_fingerprint TEXT,policy_generation BIGINT,
  state TEXT NOT NULL CHECK(state IN ('queued','processing','retry_wait','ready','blocked_policy','permanent_failure','cancelled','superseded')),
  isolate_item BOOLEAN NOT NULL DEFAULT FALSE,probe_group UUID,
  lease_owner UUID,lease_generation BIGINT NOT NULL DEFAULT 0,lease_until TIMESTAMPTZ,cohort_id UUID,
  available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,failure_code TEXT,attempts BIGINT NOT NULL DEFAULT 0 CHECK(attempts>=0),
  CHECK((lease_owner IS NULL)=(lease_until IS NULL)),CHECK(state<>'processing' OR lease_owner IS NOT NULL),
  UNIQUE(memory_id,source_generation,target_fingerprint)
);
CREATE UNIQUE INDEX embedding_jobs_blocked_identity_idx ON embedding_jobs(memory_id,source_generation) WHERE target_fingerprint IS NULL AND memory_id IS NOT NULL;
CREATE INDEX embedding_jobs_due_idx ON embedding_jobs(target_fingerprint,available_at,id) WHERE state IN ('queued','retry_wait');
CREATE INDEX embedding_jobs_lease_idx ON embedding_jobs(lease_until,id) WHERE state='processing';
CREATE INDEX embedding_jobs_scope_idx ON embedding_jobs(scope_id,id);
CREATE INDEX embedding_jobs_active_scope_idx ON embedding_jobs(scope_id,id) WHERE state IN ('queued','processing','retry_wait','blocked_policy');
CREATE INDEX embedding_jobs_memory_idx ON embedding_jobs(memory_id,accepted_at DESC,id);
CREATE TABLE embedding_capture_receipts(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),principal_id UUID,scope_id UUID,operation TEXT NOT NULL DEFAULT 'capture.v1' CHECK(operation='capture.v1'),
  key_hash TEXT,payload_digest TEXT,memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),retain_until TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  CHECK(retain_until>=accepted_at+interval '24 hours'),CHECK(key_hash IS NULL OR key_hash~'^[0-9a-f]{64}$'),
  CHECK(payload_digest IS NULL OR payload_digest~'^[0-9a-f]{64}$'),UNIQUE(principal_id,scope_id,operation,key_hash)
);
CREATE INDEX embedding_capture_receipts_prune_idx ON embedding_capture_receipts(principal_id,retain_until,id);
CREATE INDEX embedding_capture_receipts_memory_idx ON embedding_capture_receipts(memory_id,id);
CREATE TABLE embedding_admission(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),active INTEGER NOT NULL DEFAULT 0 CHECK(active BETWEEN 0 AND 100000));
INSERT INTO embedding_admission VALUES(TRUE,0);
CREATE TABLE embedding_scope_admission(scope_id UUID PRIMARY KEY,active INTEGER NOT NULL DEFAULT 0 CHECK(active BETWEEN 0 AND 10000));
CREATE TABLE embedding_receipt_admission(principal_id UUID PRIMARY KEY);
CREATE TABLE embedding_provider_control(
  provider TEXT NOT NULL,dim INTEGER NOT NULL,PRIMARY KEY(provider,dim),
  state TEXT NOT NULL DEFAULT 'closed' CHECK(state IN ('closed','open','half_open','parked')),
  failures BIGINT NOT NULL DEFAULT 0 CHECK(failures>=0),next_probe_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  cohort_id UUID,credential_generation BIGINT NOT NULL DEFAULT 1
);
CREATE TABLE embedding_dispatch_windows(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),target_fingerprint TEXT NOT NULL,policy_generation BIGINT NOT NULL,
  provider TEXT NOT NULL,dim INTEGER NOT NULL,max_dispatches BIGINT NOT NULL,max_input_bytes BIGINT NOT NULL,max_tokens BIGINT NOT NULL,max_cost_micros BIGINT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,ends_at TIMESTAMPTZ NOT NULL CHECK(ends_at>starts_at),
  dispatches BIGINT NOT NULL DEFAULT 0,input_bytes BIGINT NOT NULL DEFAULT 0,tokens BIGINT NOT NULL DEFAULT 0,cost_micros BIGINT NOT NULL DEFAULT 0,
  UNIQUE(provider,dim,starts_at)
);
-- Jobs keep the original allowance within an approved provider window. A later
-- window may allocate a new workflow, while all previous cohorts remain intact.
ALTER TABLE embedding_jobs ADD COLUMN current_window UUID REFERENCES embedding_dispatch_windows(id);
ALTER TABLE embedding_jobs ADD COLUMN workflow_id UUID REFERENCES pipeline_budget_workflows(id);
ALTER TABLE embedding_jobs ADD COLUMN budget_owner UUID;
ALTER TABLE embedding_jobs ADD COLUMN budget_generation BIGINT;
ALTER TABLE embedding_jobs ADD CONSTRAINT embedding_job_original_budget CHECK(
  (current_window IS NULL AND workflow_id IS NULL AND budget_owner IS NULL AND budget_generation IS NULL)
  OR (current_window IS NOT NULL AND workflow_id IS NOT NULL AND budget_owner IS NOT NULL AND budget_generation>0));
CREATE TABLE embedding_worker_bindings(
  role_oid OID NOT NULL,role_name NAME NOT NULL,principal_id UUID NOT NULL REFERENCES principals(id),
  scope_id UUID NOT NULL REFERENCES scopes(id),target_fingerprint TEXT NOT NULL REFERENCES embedding_targets(fingerprint),
  generation UUID NOT NULL DEFAULT gen_random_uuid(),enabled BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY(role_oid,scope_id,target_fingerprint),UNIQUE(role_name,scope_id,target_fingerprint)
);
CREATE TABLE embedding_cohorts(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),owner UUID NOT NULL,generation BIGINT NOT NULL DEFAULT 1,
  scope_id UUID,policy_generation BIGINT NOT NULL,target_fingerprint TEXT,
  login_oid OID NOT NULL,binding_generation UUID NOT NULL,principal_id UUID,credential_generation BIGINT NOT NULL,
  workflow_id UUID NOT NULL,attempt_id UUID NOT NULL UNIQUE,attempt_owner UUID NOT NULL,attempt_generation BIGINT NOT NULL DEFAULT 1,
  window_id UUID NOT NULL REFERENCES embedding_dispatch_windows(id),
  lease_until TIMESTAMPTZ NOT NULL,deadline_at TIMESTAMPTZ NOT NULL,profile JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'attached' CHECK(state IN ('attached','reserved','dispatched','settled','complete','cancelled','abandoned')),
  reservation JSONB,retained_bytes BIGINT,hydrated_bytes BIGINT,settlement JSONB,
  diagnostic_ambiguous BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX embedding_cohorts_scope_idx ON embedding_cohorts(scope_id,id);
CREATE INDEX embedding_cohorts_workflow_idx ON embedding_cohorts(workflow_id,id);
CREATE TABLE embedding_cohort_jobs(cohort_id UUID NOT NULL REFERENCES embedding_cohorts(id),job_id UUID NOT NULL REFERENCES embedding_jobs(id),lease_generation BIGINT NOT NULL,PRIMARY KEY(cohort_id,job_id));
CREATE FUNCTION continuum_embedding_cohort_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (OLD.id,OLD.owner,OLD.generation,OLD.login_oid,OLD.binding_generation,OLD.credential_generation,OLD.workflow_id,OLD.attempt_id,
    OLD.attempt_owner,OLD.attempt_generation,OLD.window_id,OLD.deadline_at,OLD.profile,OLD.created_at) IS DISTINCT FROM
    (NEW.id,NEW.owner,NEW.generation,NEW.login_oid,NEW.binding_generation,NEW.credential_generation,NEW.workflow_id,NEW.attempt_id,
    NEW.attempt_owner,NEW.attempt_generation,NEW.window_id,NEW.deadline_at,NEW.profile,NEW.created_at) THEN
    RAISE check_violation USING MESSAGE='Original embedding accounting identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_cohort_identity BEFORE UPDATE ON embedding_cohorts FOR EACH ROW EXECUTE FUNCTION continuum_embedding_cohort_identity();
CREATE FUNCTION continuum_embedding_window_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (OLD.id,OLD.target_fingerprint,OLD.policy_generation,OLD.provider,OLD.dim,OLD.max_dispatches,OLD.max_input_bytes,OLD.max_tokens,OLD.max_cost_micros,OLD.starts_at,OLD.ends_at)
    IS DISTINCT FROM (NEW.id,NEW.target_fingerprint,NEW.policy_generation,NEW.provider,NEW.dim,NEW.max_dispatches,NEW.max_input_bytes,NEW.max_tokens,NEW.max_cost_micros,NEW.starts_at,NEW.ends_at)
    OR NEW.dispatches<OLD.dispatches OR NEW.input_bytes<OLD.input_bytes OR NEW.tokens<OLD.tokens OR NEW.cost_micros<OLD.cost_micros THEN
    RAISE check_violation USING MESSAGE='Original embedding window allowance is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_window_identity BEFORE UPDATE ON embedding_dispatch_windows FOR EACH ROW EXECUTE FUNCTION continuum_embedding_window_identity();
ALTER TABLE embedding_dispatch_windows ADD CONSTRAINT embedding_window_charges CHECK(dispatches BETWEEN 0 AND max_dispatches
  AND input_bytes BETWEEN 0 AND max_input_bytes AND tokens BETWEEN 0 AND max_tokens AND cost_micros BETWEEN 0 AND max_cost_micros);
CREATE INDEX embedding_cohort_job_idx ON embedding_cohort_jobs(job_id,cohort_id);
CREATE TABLE embedding_cohort_scopes(cohort_id UUID NOT NULL REFERENCES embedding_cohorts(id),scope_id UUID NOT NULL,PRIMARY KEY(cohort_id,scope_id));
CREATE INDEX embedding_cohort_scope_idx ON embedding_cohort_scopes(scope_id,cohort_id);
CREATE TABLE embedding_completions(job_id UUID PRIMARY KEY REFERENCES embedding_jobs(id),completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER embedding_completion_immutable BEFORE UPDATE OR DELETE ON embedding_completions FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE TABLE embedding_transition_receipts(cohort_id UUID NOT NULL REFERENCES embedding_cohorts(id),operation TEXT NOT NULL,PRIMARY KEY(cohort_id,operation));
CREATE TRIGGER embedding_transition_immutable BEFORE UPDATE OR DELETE ON embedding_transition_receipts FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
ALTER TABLE memory_embeddings ADD COLUMN source_generation BIGINT;
ALTER TABLE memory_embeddings ADD COLUMN space_fingerprint TEXT;

CREATE FUNCTION continuum_embedding_source_eligible(memory UUID) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM memories m WHERE m.id=memory AND m.state='live' AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM principal_user_scopes u JOIN principals p ON p.id=u.principal_id WHERE u.scope_id=m.scope_id AND p.disabled_at IS NOT NULL));
$$;
CREATE FUNCTION continuum_embedding_route(target_scope UUID) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(p.routing->'scopes'->target_scope::text,p.routing->'kinds'->s.kind,p.routing->'default')
    FROM scopes s CROSS JOIN embedding_policy p WHERE s.id=target_scope AND p.singleton;
$$;
CREATE FUNCTION continuum_embedding_source_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id UUID; changed BOOLEAN;
BEGIN
  source_id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  IF TG_OP='UPDATE' THEN
    changed:=(OLD.title,OLD.body,OLD.scope_id,OLD.type,OLD.tags,OLD.author_id,OLD.source,OLD.source_ref,OLD.state,OLD.expires_at,OLD.metadata-'related')
      IS DISTINCT FROM (NEW.title,NEW.body,NEW.scope_id,NEW.type,NEW.tags,NEW.author_id,NEW.source,NEW.source_ref,NEW.state,NEW.expires_at,NEW.metadata-'related');
    IF NOT changed THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' THEN
    IF NOT continuum_embedding_erase_memory(source_id) THEN RAISE check_violation USING MESSAGE='Embedding source requires bounded privacy scrub before deletion'; END IF;
    RETURN OLD;
  END IF;
  INSERT INTO embedding_sources(memory_id,generation,input_hash,origin_scope_id,status)
    VALUES(NEW.id,1,NULL,NEW.scope_id,'not_configured')
    ON CONFLICT(memory_id) DO UPDATE SET generation=embedding_sources.generation+1,
      input_hash=CASE WHEN embedding_sources.input_hash IS NOT NULL AND NOT embedding_sources.erased THEN encode(sha256(convert_to(NEW.title||E'\n\n'||NEW.body,'UTF8')),'hex') ELSE NULL END,current_target=NULL,status=CASE WHEN NEW.state='live' THEN 'superseded' ELSE 'cancelled' END;
  IF (SELECT count(*) FROM embedding_source_scopes WHERE memory_id=NEW.id)>=256
    AND NOT EXISTS(SELECT 1 FROM embedding_source_scopes WHERE memory_id=NEW.id AND scope_id=NEW.scope_id) THEN
    RAISE check_violation USING MESSAGE='Embedding source lineage bound exceeded'; END IF;
  INSERT INTO embedding_source_scopes VALUES(NEW.id,NEW.scope_id) ON CONFLICT DO NOTHING;
  UPDATE embedding_jobs SET state=CASE WHEN NEW.state='live' THEN 'superseded' ELSE 'cancelled' END,
    lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1 WHERE memory_id=NEW.id AND state IN ('queued','processing','retry_wait','blocked_policy');
  UPDATE pipeline_budget_workflows w SET cancelled=TRUE,generation=w.generation+1 FROM embedding_cohorts c
    WHERE c.workflow_id=w.id AND NOT w.cancelled AND EXISTS(SELECT 1 FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id WHERE cj.cohort_id=c.id AND j.memory_id=NEW.id);
  DELETE FROM memory_embeddings WHERE memory_id=NEW.id;
  RETURN NEW;
END $$;
-- AFTER INSERT can reference the new FK row; BEFORE UPDATE/DELETE fences every old writer.
CREATE TRIGGER embedding_source_insert AFTER INSERT ON memories FOR EACH ROW EXECUTE FUNCTION continuum_embedding_source_fence();
CREATE TRIGGER embedding_source_change BEFORE UPDATE OR DELETE ON memories FOR EACH ROW EXECUTE FUNCTION continuum_embedding_source_fence();

CREATE FUNCTION continuum_embedding_enroll_lineage(memory UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE scopes_value UUID[];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM embedding_sources WHERE memory_id=memory) THEN RETURN; END IF;
  SELECT array_agg(scope_id ORDER BY scope_id) INTO scopes_value FROM (
    SELECT scope_id FROM embedding_source_scopes WHERE memory_id=memory
    UNION SELECT v.scope_id FROM evidence_roots own_root JOIN evidence_closure closure ON closure.version_id=own_root.current_version
      JOIN evidence_versions v ON v.root_id=closure.root_id WHERE own_root.source_memory_id=memory
    LIMIT 257) bounded;
  IF cardinality(scopes_value)>256 THEN RAISE check_violation USING MESSAGE='Embedding owned-source lineage bound exceeded'; END IF;
  INSERT INTO embedding_source_scopes SELECT memory,unnest(scopes_value) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION continuum_embedding_evidence_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE memory UUID; status_value TEXT;
BEGIN
  IF TG_TABLE_NAME='evidence_roots' THEN
    IF NEW.source_memory_id IS NOT NULL THEN PERFORM continuum_embedding_enroll_lineage(NEW.source_memory_id); END IF;
    IF (OLD.generation,OLD.revoked,OLD.residency,OLD.external_state,OLD.checked_at,OLD.valid_until,OLD.expiry_ceiling,OLD.scope_id)
      IS NOT DISTINCT FROM (NEW.generation,NEW.revoked,NEW.residency,NEW.external_state,NEW.checked_at,NEW.valid_until,NEW.expiry_ceiling,NEW.scope_id) THEN RETURN NEW; END IF;
    memory:=NEW.source_memory_id;
  ELSE
    IF OLD.state IS NOT DISTINCT FROM NEW.state THEN RETURN NEW; END IF;
    SELECT r.source_memory_id INTO memory FROM evidence_roots r WHERE r.current_version=NEW.version_id;
  END IF;
  IF memory IS NULL THEN RETURN NEW; END IF;
  PERFORM id FROM memories WHERE id=memory FOR UPDATE;
  status_value:=CASE WHEN continuum_embedding_source_eligible(memory) THEN 'superseded' ELSE 'cancelled' END;
  UPDATE embedding_sources SET generation=generation+1,status=status_value,current_target=NULL WHERE memory_id=memory AND NOT erased;
  UPDATE embedding_jobs SET state=status_value,lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1
    WHERE memory_id=memory AND state IN ('queued','processing','retry_wait','blocked_policy');
  UPDATE pipeline_budget_workflows w SET cancelled=TRUE,generation=w.generation+1 FROM embedding_cohorts c
    WHERE c.workflow_id=w.id AND NOT w.cancelled AND EXISTS(SELECT 1 FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id WHERE cj.cohort_id=c.id AND j.memory_id=memory);
  DELETE FROM memory_embeddings WHERE memory_id=memory;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_evidence_root_fence AFTER UPDATE ON evidence_roots FOR EACH ROW EXECUTE FUNCTION continuum_embedding_evidence_fence();
CREATE TRIGGER embedding_evidence_state_fence AFTER UPDATE ON evidence_state FOR EACH ROW EXECUTE FUNCTION continuum_embedding_evidence_fence();

CREATE FUNCTION continuum_embedding_job_admission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE was_active INTEGER:=0; now_active INTEGER:=0; target_scope UUID;
BEGIN
  IF TG_OP<>'INSERT' AND OLD.state IN ('queued','processing','retry_wait','blocked_policy') THEN was_active:=1; END IF;
  IF TG_OP<>'DELETE' AND NEW.state IN ('queued','processing','retry_wait','blocked_policy') THEN now_active:=1; END IF;
  target_scope:=CASE WHEN was_active=1 THEN OLD.scope_id ELSE NEW.scope_id END;
  IF now_active<>was_active THEN
    UPDATE embedding_admission SET active=active+now_active-was_active WHERE singleton AND active+now_active-was_active BETWEEN 0 AND 100000;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='EMBEDDING_QUEUE_QUOTA_EXCEEDED'; END IF;
    INSERT INTO embedding_scope_admission(scope_id) VALUES(target_scope) ON CONFLICT DO NOTHING;
    UPDATE embedding_scope_admission SET active=active+now_active-was_active WHERE scope_id=target_scope AND active+now_active-was_active BETWEEN 0 AND 10000;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='EMBEDDING_QUEUE_QUOTA_EXCEEDED'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER embedding_job_admission BEFORE INSERT OR UPDATE OR DELETE ON embedding_jobs FOR EACH ROW EXECUTE FUNCTION continuum_embedding_job_admission();

CREATE FUNCTION continuum_embedding_source_policy(memory UUID,target JSONB) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE root RECORD;
BEGIN
  IF NOT continuum_embedding_source_eligible(memory) THEN RETURN FALSE; END IF;
  FOR root IN SELECT r.* FROM evidence_roots r WHERE r.source_memory_id=memory OR r.id IN (
    SELECT d.upstream_root_id FROM evidence_source_dependencies d JOIN evidence_roots own_root ON own_root.id=d.root_id WHERE own_root.source_memory_id=memory)
    ORDER BY r.id FOR SHARE LOOP
    IF root.current_version IS NULL OR NOT EXISTS(SELECT 1 FROM evidence_state WHERE version_id=root.current_version AND state='active')
      OR NOT EXISTS(SELECT 1 FROM evidence_payloads WHERE version_id=root.current_version) OR root.revoked OR root.external_state IN ('deny','unknown') OR (root.expiry_ceiling IS NOT NULL AND root.expiry_ceiling<=clock_timestamp())
      OR (root.external_state='allow' AND (root.checked_at IS NULL OR root.valid_until IS NULL OR root.checked_at>clock_timestamp() OR root.valid_until<=clock_timestamp()))
      OR (root.residency='local-only' AND (target->>'local')::boolean IS NOT TRUE)
      OR EXISTS(SELECT 1 FROM evidence_source_dependencies d JOIN evidence_roots r ON r.id=d.upstream_root_id
        WHERE d.root_id IN (SELECT id FROM evidence_roots WHERE source_memory_id=memory) AND r.id=root.id AND r.generation<>d.generation)
      OR EXISTS(SELECT 1 FROM principal_user_scopes u JOIN principals p ON p.id=u.principal_id WHERE u.scope_id=root.scope_id AND p.disabled_at IS NOT NULL)
      THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN TRUE;
END $$;
CREATE FUNCTION continuum_embedding_admit_vector(memory UUID,target JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s embedding_sources%ROWTYPE; t embedding_targets%ROWTYPE; p embedding_policy%ROWTYPE; m RECORD; route JSONB;
BEGIN
  SELECT id,scope_id,octet_length(title)::bigint+2+octet_length(body)::bigint bytes INTO m FROM memories WHERE id=memory FOR UPDATE;
  IF NOT FOUND OR NOT continuum_embedding_source_eligible(memory) THEN RETURN NULL; END IF;
  SELECT * INTO p FROM embedding_policy WHERE singleton FOR SHARE;
  SELECT * INTO t FROM embedding_targets WHERE fingerprint=target->>'fingerprint' AND enabled FOR SHARE;
  route:=continuum_embedding_route(m.scope_id);
  IF p.singleton IS NULL OR t.fingerprint IS NULL OR t.descriptor IS DISTINCT FROM target OR route->>'target' IS DISTINCT FROM t.fingerprint
    OR (COALESCE((route->>'localOnly')::boolean,FALSE) AND (target->>'local')::boolean IS NOT TRUE) THEN RETURN NULL; END IF;
  INSERT INTO embedding_sources(memory_id,generation,input_hash,origin_scope_id,status)
    SELECT id,1,encode(sha256(convert_to(title||E'\n\n'||body,'UTF8')),'hex'),scope_id,'not_configured' FROM memories
      WHERE id=m.id AND m.bytes<=4194304 ON CONFLICT DO NOTHING;
  SELECT * INTO s FROM embedding_sources WHERE memory_id=memory FOR SHARE;
  IF s.memory_id IS NULL OR s.erased OR NOT continuum_embedding_source_policy(memory,target) THEN RETURN NULL; END IF;
  IF s.input_hash IS NULL THEN
    IF m.bytes>4194304 THEN RETURN NULL; END IF;
    UPDATE embedding_sources source SET input_hash=encode(sha256(convert_to(body.title||E'\n\n'||body.body,'UTF8')),'hex') FROM memories body WHERE source.memory_id=memory AND body.id=memory RETURNING source.* INTO s;
  END IF;
  INSERT INTO embedding_source_scopes VALUES(m.id,m.scope_id) ON CONFLICT DO NOTHING;
  PERFORM continuum_embedding_enroll_lineage(memory);
  RETURN jsonb_build_object('memoryId',memory,'generation',s.generation::text,'inputHash',s.input_hash,
    'target',target,'policyGeneration',p.generation::text,'policyDigest',p.digest);
END $$;
CREATE FUNCTION continuum_embedding_vector_is_current(memory UUID,provider_id TEXT,dimension INTEGER) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM memory_embeddings e JOIN embedding_sources s ON s.memory_id=e.memory_id
    JOIN embedding_vector_spaces v ON v.provider=e.provider AND v.dim=e.dim
    JOIN memories m ON m.id=e.memory_id JOIN embedding_targets t ON t.fingerprint=continuum_embedding_route(m.scope_id)->>'target'
    WHERE e.memory_id=memory AND e.provider=provider_id AND e.dim=dimension AND e.source_generation=s.generation AND NOT s.erased AND s.input_hash IS NOT NULL
      AND e.space_fingerprint=v.space_fingerprint AND t.provider=e.provider AND t.dim=e.dim AND t.enabled
      AND t.descriptor->>'spaceFingerprint'=v.space_fingerprint AND continuum_embedding_source_policy(memory,t.descriptor));
$$;
CREATE FUNCTION continuum_embedding_vector_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source embedding_sources%ROWTYPE; registered embedding_vector_spaces%ROWTYPE;
BEGIN
  PERFORM id FROM memories WHERE id=NEW.memory_id FOR UPDATE;
  SELECT * INTO source FROM embedding_sources WHERE memory_id=NEW.memory_id FOR SHARE;
  SELECT * INTO registered FROM embedding_vector_spaces WHERE provider=NEW.provider AND dim=NEW.dim;
  IF source.memory_id IS NULL OR source.erased OR source.input_hash IS NULL OR source.generation IS DISTINCT FROM NEW.source_generation
    OR registered.provider IS NULL OR registered.space_fingerprint IS DISTINCT FROM NEW.space_fingerprint
    OR NOT continuum_embedding_source_eligible(NEW.memory_id)
    OR NOT EXISTS(SELECT 1 FROM embedding_targets t JOIN memories m ON m.id=NEW.memory_id
      WHERE t.fingerprint=continuum_embedding_route(m.scope_id)->>'target' AND t.provider=NEW.provider AND t.dim=NEW.dim AND t.enabled
        AND t.descriptor->>'spaceFingerprint'=NEW.space_fingerprint AND continuum_embedding_source_policy(NEW.memory_id,t.descriptor)) THEN RAISE check_violation USING MESSAGE='Embedding source or vector space unavailable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER embedding_vector_guard BEFORE INSERT OR UPDATE ON memory_embeddings FOR EACH ROW EXECUTE FUNCTION continuum_embedding_vector_guard();
CREATE FUNCTION continuum_embedding_apply_vector(memory UUID,vector_text TEXT,admission JSONB) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m memories%ROWTYPE; current_admission JSONB; target JSONB:=admission->'target'; provider_schema TEXT; stored INTEGER;
BEGIN
  IF admission->>'memoryId' IS DISTINCT FROM memory::text OR octet_length(vector_text)>65536 THEN RETURN FALSE; END IF;
  current_admission:=continuum_embedding_admit_vector(memory,target);
  IF current_admission IS NULL OR current_admission IS DISTINCT FROM admission THEN RETURN FALSE; END IF;
  SELECT n.nspname INTO STRICT provider_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector';
  EXECUTE format('INSERT INTO memory_embeddings(memory_id,provider,dim,embedding,source_generation,space_fingerprint)
    VALUES($1,$2,768,$3::%I.vector,$4,$5) ON CONFLICT(memory_id,provider,dim) DO UPDATE SET embedding=EXCLUDED.embedding,
    source_generation=EXCLUDED.source_generation,space_fingerprint=EXCLUDED.space_fingerprint,embedded_at=clock_timestamp()
    WHERE memory_embeddings.space_fingerprint IS NULL OR memory_embeddings.space_fingerprint=EXCLUDED.space_fingerprint',provider_schema)
    USING memory,target->'space'->>'provider',vector_text,(admission->>'generation')::bigint,target->>'spaceFingerprint';
  GET DIAGNOSTICS stored=ROW_COUNT;
  RETURN stored=1;
END $$;

CREATE FUNCTION continuum_embedding_capture_writer(actor UUID,target_scope UUID) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM scope_memberships m JOIN principals p ON p.id=m.principal_id
    WHERE m.principal_id=actor AND m.scope_id=target_scope AND p.disabled_at IS NULL AND m.role IN ('writer','admin')
      AND continuum_membership_is_effective(m.active,m.source_kind));
$$;
CREATE FUNCTION continuum_embedding_can_read(actor UUID,target_scope UUID) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM principals WHERE id=actor AND disabled_at IS NULL) AND EXISTS(SELECT 1 FROM scopes s WHERE s.id=target_scope
    AND (s.kind='org' OR EXISTS(SELECT 1 FROM scope_memberships m WHERE m.principal_id=actor AND m.scope_id=target_scope
      AND continuum_membership_is_effective(m.active,m.source_kind))));
$$;
CREATE FUNCTION continuum_embedding_enqueue(actor UUID,memory UUID,target JSONB,process_policy JSONB,intent TEXT) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m RECORD; source embedding_sources%ROWTYPE; admitted JSONB; p embedding_policy%ROWTYPE; result TEXT;
BEGIN
  SELECT id,scope_id,author_id INTO m FROM memories WHERE id=memory FOR UPDATE;
  IF NOT FOUND OR m.author_id IS DISTINCT FROM actor OR NOT continuum_embedding_capture_writer(actor,m.scope_id) THEN
    RAISE insufficient_privilege USING MESSAGE='Embedding capture unavailable'; END IF;
  SELECT * INTO STRICT source FROM embedding_sources WHERE memory_id=memory FOR UPDATE;
  IF intent IS NULL OR intent NOT IN ('queued','not_configured','blocked_policy') THEN RAISE check_violation USING MESSAGE='Invalid embedding intent'; END IF;
  result:=CASE WHEN intent='not_configured' THEN 'not_configured' ELSE 'blocked_policy' END;
  IF intent<>'not_configured' THEN
    UPDATE embedding_sources stored SET input_hash=encode(sha256(convert_to(body.title||E'\n\n'||body.body,'UTF8')),'hex') FROM memories body WHERE stored.memory_id=memory AND body.id=memory;
    PERFORM continuum_embedding_enroll_lineage(memory);
  END IF;
  SELECT * INTO p FROM embedding_policy WHERE singleton FOR SHARE;
  IF intent='queued' AND target IS NOT NULL AND p.singleton IS NOT NULL
    AND p.generation::text=process_policy->>'generation' AND p.digest=process_policy->>'digest' THEN
    admitted:=continuum_embedding_admit_vector(memory,target);
    IF admitted IS NOT NULL THEN
      INSERT INTO embedding_jobs(memory_id,scope_id,source_generation,target_fingerprint,policy_generation,state)
        VALUES(memory,m.scope_id,source.generation,target->>'fingerprint',p.generation,'queued') ON CONFLICT DO NOTHING;
      SELECT state INTO STRICT result FROM embedding_jobs WHERE memory_id=memory AND source_generation=source.generation AND target_fingerprint=target->>'fingerprint';
    END IF;
  END IF;
  IF result='blocked_policy' AND intent<>'not_configured' THEN
    INSERT INTO embedding_jobs(memory_id,scope_id,source_generation,state) VALUES(memory,m.scope_id,source.generation,'blocked_policy') ON CONFLICT DO NOTHING;
  END IF;
  UPDATE embedding_sources SET status=result,current_target=CASE WHEN admitted IS NOT NULL THEN target->>'fingerprint' END WHERE memory_id=memory;
  RETURN result;
END $$;
CREATE FUNCTION continuum_embedding_status(actor UUID,memory UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m RECORD; source embedding_sources%ROWTYPE; job embedding_jobs%ROWTYPE; result TEXT; matching BOOLEAN:=FALSE;
BEGIN
  SELECT id,scope_id INTO m FROM memories WHERE id=memory FOR SHARE;
  IF NOT FOUND OR NOT continuum_embedding_can_read(actor,m.scope_id) THEN RETURN NULL; END IF;
  PERFORM id FROM principals WHERE id=actor FOR SHARE;
  PERFORM principal_id FROM scope_memberships WHERE principal_id=actor AND scope_id=m.scope_id FOR SHARE;
  PERFORM singleton FROM entra_sync_state WHERE singleton FOR SHARE;
  IF NOT continuum_embedding_can_read(actor,m.scope_id) THEN RETURN NULL; END IF;
  SELECT * INTO source FROM embedding_sources WHERE memory_id=memory;
  result:=COALESCE(source.status,'not_configured');
  SELECT * INTO job FROM embedding_jobs WHERE memory_id=memory AND source_generation=source.generation AND target_fingerprint=source.current_target;
  IF job.id IS NOT NULL THEN result:=job.state; END IF;
  SELECT EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id=memory AND continuum_embedding_vector_is_current(memory,e.provider,e.dim)) INTO matching;
  IF matching THEN result:='ready';
  ELSIF NOT continuum_embedding_source_eligible(memory) OR source.erased THEN result:='cancelled';
  ELSIF source.current_target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM embedding_policy p,embedding_targets t
    WHERE p.singleton AND t.fingerprint=source.current_target AND t.enabled AND t.fingerprint=continuum_embedding_route(m.scope_id)->>'target'
      AND (job.id IS NULL OR job.policy_generation=p.generation)) THEN result:='blocked_policy';
  ELSIF result='ready' THEN result:='superseded'; END IF;
  RETURN jsonb_build_object('embeddingStatus',result,'embedded',matching,'attempts',COALESCE(job.attempts,0),
    'acceptedAt',job.accepted_at,'completedAt',job.completed_at,'nextAttemptAt',CASE WHEN result='retry_wait' THEN job.available_at END);
END $$;
CREATE FUNCTION continuum_embedding_receipt_begin(actor UUID,target_scope UUID,key_digest TEXT,payload_hash TEXT,source_name TEXT) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE receipt embedding_capture_receipts%ROWTYPE;
BEGIN
  IF key_digest IS NULL OR key_digest!~'^[0-9a-f]{64}$' OR payload_hash IS NULL OR payload_hash!~'^[0-9a-f]{64}$'
    OR NOT continuum_embedding_can_read(actor,target_scope) THEN RAISE insufficient_privilege USING MESSAGE='Capture replay unavailable'; END IF;
  INSERT INTO embedding_receipt_admission VALUES(actor) ON CONFLICT DO NOTHING;
  PERFORM principal_id FROM embedding_receipt_admission WHERE principal_id=actor FOR UPDATE;
  -- A bounded page never evicts a replay guarantee or any acknowledged pending work.
  DELETE FROM embedding_capture_receipts r WHERE r.id IN (SELECT candidate.id FROM embedding_capture_receipts candidate
    WHERE candidate.principal_id=actor AND candidate.retain_until<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM embedding_jobs j WHERE j.memory_id=candidate.memory_id AND j.state IN ('queued','processing','retry_wait','blocked_policy'))
      AND NOT EXISTS(SELECT 1 FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id JOIN embedding_cohorts c ON c.id=cj.cohort_id
        WHERE j.memory_id=candidate.memory_id AND c.state IN ('reserved','dispatched'))
    ORDER BY candidate.retain_until,candidate.id LIMIT 100);
  SELECT * INTO receipt FROM embedding_capture_receipts WHERE principal_id=actor AND scope_id=target_scope AND key_hash=key_digest AND operation='capture.v1' FOR UPDATE;
  IF FOUND THEN
    IF receipt.payload_digest IS DISTINCT FROM payload_hash THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='EMBEDDING_CAPTURE_CONFLICT'; END IF;
    IF NOT EXISTS(SELECT 1 FROM memories WHERE id=receipt.memory_id AND source=source_name AND scope_id=target_scope
        AND state='live' AND (expires_at IS NULL OR expires_at>clock_timestamp()))
      OR continuum_embedding_status(actor,receipt.memory_id) IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Capture replay unavailable'; END IF;
    RETURN receipt.memory_id;
  END IF;
  IF (SELECT count(*) FROM embedding_capture_receipts WHERE principal_id=actor)>=10000 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='EMBEDDING_RECEIPT_QUOTA_EXCEEDED'; END IF;
  RETURN NULL;
END $$;
-- Replay is a current source read. It must not require the writer-only capture
-- path or create extraction work after an original creator loses writer access.
CREATE FUNCTION continuum_embedding_replay_extraction(actor UUID,memory UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_scope UUID; job extraction_runs%ROWTYPE;
BEGIN
  IF continuum_embedding_status(actor,memory) IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE='Capture replay unavailable'; END IF;
  SELECT scope_id INTO source_scope FROM memories WHERE id=memory AND state='live'
    AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE;
  IF source_scope IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Capture replay unavailable'; END IF;
  SELECT * INTO job FROM extraction_runs WHERE memory_id=memory ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE;
  IF job.id IS NULL THEN RETURN jsonb_build_object('status','not-configured'); END IF;
  IF NOT continuum_evidence_can_access(actor,source_scope,FALSE) THEN RETURN jsonb_build_object('status','skipped'); END IF;
  IF job.source_version IS NOT NULL THEN
    PERFORM continuum_evidence_lock(actor,ARRAY[job.source_version]);
    IF NOT continuum_evidence_eligible(actor,job.source_version,NULL)
      OR NOT EXISTS(SELECT 1 FROM evidence_roots WHERE source_memory_id=memory AND current_version=job.source_version) THEN
      RETURN jsonb_build_object('status','skipped'); END IF;
  END IF;
  RETURN jsonb_build_object('status',job.state,'runId',job.id);
END $$;
CREATE FUNCTION continuum_embedding_receipt_finish(actor UUID,target_scope UUID,key_digest TEXT,payload_hash TEXT,memory UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM principal_id FROM embedding_receipt_admission WHERE principal_id=actor FOR UPDATE;
  IF NOT FOUND OR NOT continuum_embedding_capture_writer(actor,target_scope)
    OR NOT EXISTS(SELECT 1 FROM memories WHERE id=memory AND scope_id=target_scope AND author_id=actor)
    OR key_digest IS NULL OR key_digest!~'^[0-9a-f]{64}$' OR payload_hash IS NULL OR payload_hash!~'^[0-9a-f]{64}$'
    OR (SELECT count(*) FROM embedding_capture_receipts WHERE principal_id=actor)>=10000 THEN
    RAISE check_violation USING MESSAGE='Capture receipt admission unavailable'; END IF;
  INSERT INTO embedding_capture_receipts(principal_id,scope_id,key_hash,payload_digest,memory_id) VALUES(actor,target_scope,key_digest,payload_hash,memory);
END $$;

CREATE FUNCTION continuum_embedding_valid_target(t JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s JSONB:=t->'space'; hash_value TEXT; canonical TEXT; field TEXT;
BEGIN
  IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(t))<>5
    OR NOT(t ?& ARRAY['space','spaceFingerprint','configFingerprint','fingerprint','local']) OR jsonb_typeof(t->'local') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(s) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(s))<>5
    OR NOT(s ?& ARRAY['provider','model','profile','dim','inputTransform']) OR jsonb_typeof(s->'dim') IS DISTINCT FROM 'number' OR s->>'dim' IS DISTINCT FROM '768'
    OR s->>'inputTransform' IS DISTINCT FROM 'memory-title-body-v1' THEN RETURN FALSE; END IF;
  FOREACH field IN ARRAY ARRAY['provider','model','profile','inputTransform'] LOOP
    IF jsonb_typeof(s->field) IS DISTINCT FROM 'string' OR s->>field!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' THEN RETURN FALSE; END IF;
  END LOOP;
  -- Match the TypeScript field projection byte-for-byte, independently of jsonb key order.
  canonical:='["continuum.embedding-space.v1",{"provider":'||to_json(s->>'provider')::text||',"model":'||to_json(s->>'model')::text||
    ',"profile":'||to_json(s->>'profile')::text||',"dim":768,"inputTransform":'||to_json(s->>'inputTransform')::text||'}]';
  hash_value:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  RETURN t->>'spaceFingerprint'=hash_value AND t->>'configFingerprint'~'^[0-9a-f]{64}$'
    AND t->>'fingerprint'=encode(sha256(convert_to('["continuum.embedding-target.v1","'||hash_value||'","'||(t->>'configFingerprint')||'"]','UTF8')),'hex');
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;
CREATE FUNCTION continuum_operator_embedding_target(actor UUID,target JSONB,budget JSONB,window_policy JSONB,enable BOOLEAN) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE registered embedding_vector_spaces%ROWTYPE; item TEXT; changed BOOLEAN;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF NOT continuum_embedding_valid_target(target) OR NOT continuum_pipeline_valid_profile(budget) OR enable IS NULL
    OR (budget->>'maxConcurrency')::bigint<>1 OR (budget->'limits'->>'hydratedBytes')::bigint>4194304
    OR (budget->>'overallMs')::bigint>300000 OR (budget->>'stageMs')::bigint>300000
    OR jsonb_typeof(window_policy) IS DISTINCT FROM 'object'
    OR NOT(window_policy ?& ARRAY['seconds','dispatches','inputBytes','tokens','spendMicros','rateSchedule'])
    OR (SELECT count(*) FROM jsonb_object_keys(window_policy))<>6
    OR window_policy->>'rateSchedule' IS DISTINCT FROM budget->>'rateSchedule' THEN RAISE check_violation USING MESSAGE='Invalid embedding target policy'; END IF;
  FOREACH item IN ARRAY ARRAY['seconds','dispatches','inputBytes','tokens','spendMicros'] LOOP
    IF jsonb_typeof(window_policy->item) IS DISTINCT FROM 'number' OR window_policy->>item!~'^(0|[1-9][0-9]*)$'
      OR (window_policy->>item)::numeric>9007199254740991 THEN RAISE check_violation USING MESSAGE='Invalid embedding window bound'; END IF;
  END LOOP;
  IF (window_policy->>'seconds')::bigint NOT BETWEEN 1 AND 86400 OR (window_policy->>'dispatches')::bigint NOT BETWEEN 1 AND 100000
    OR (window_policy->>'inputBytes')::bigint<1 OR (window_policy->>'tokens')::bigint<1 THEN RAISE check_violation USING MESSAGE='Invalid embedding window bound'; END IF;
  INSERT INTO embedding_vector_spaces VALUES(target->'space'->>'provider',768,target->>'spaceFingerprint',target->'space') ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT registered FROM embedding_vector_spaces WHERE provider=target->'space'->>'provider' AND dim=768 FOR SHARE;
  IF registered.descriptor IS DISTINCT FROM target->'space' OR registered.space_fingerprint IS DISTINCT FROM target->>'spaceFingerprint' THEN
    RAISE check_violation USING MESSAGE='Embedding storage identity conflicts with its approved vector space'; END IF;
  -- Changed target budgets cannot reset an installed allowance window.
  IF EXISTS(SELECT 1 FROM embedding_targets installed WHERE installed.provider=target->'space'->>'provider' AND installed.dim=768
    AND installed.window_policy->>'seconds' IS DISTINCT FROM $4->>'seconds') THEN
    RAISE check_violation USING MESSAGE='Embedding provider window duration is immutable'; END IF;
  SELECT enabled IS DISTINCT FROM enable OR profile IS DISTINCT FROM budget OR embedding_targets.window_policy IS DISTINCT FROM $4
    INTO changed FROM embedding_targets WHERE fingerprint=target->>'fingerprint' FOR UPDATE;
  INSERT INTO embedding_targets VALUES(target->>'fingerprint',target,target->'space'->>'provider',768,budget,window_policy,enable)
    ON CONFLICT(fingerprint) DO UPDATE SET enabled=EXCLUDED.enabled,profile=EXCLUDED.profile,window_policy=EXCLUDED.window_policy WHERE embedding_targets.descriptor=EXCLUDED.descriptor;
  IF NOT FOUND THEN RAISE check_violation USING MESSAGE='Embedding target identity conflict'; END IF;
  IF changed THEN UPDATE embedding_policy SET generation=generation+1 WHERE singleton; END IF;
  INSERT INTO embedding_provider_control(provider,dim) VALUES(registered.provider,768) ON CONFLICT DO NOTHING;
  INSERT INTO audit_log(principal_id,action,metadata) VALUES(actor,'write',jsonb_build_object('operation','embedding_target_configured','enabled',enable));
END $$;
CREATE FUNCTION continuum_operator_embedding_policy(actor UUID,routing JSONB,policy_digest TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE route RECORD; selection JSONB; result embedding_policy%ROWTYPE;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF jsonb_typeof(routing) IS DISTINCT FROM 'object' OR NOT(routing ?& ARRAY['default','scopes','kinds'])
    OR (SELECT count(*) FROM jsonb_object_keys(routing))<>3 OR jsonb_typeof(routing->'scopes') IS DISTINCT FROM 'object'
    OR jsonb_typeof(routing->'kinds') IS DISTINCT FROM 'object' OR octet_length(routing::text)>65536
    OR policy_digest IS NULL OR policy_digest!~'^[0-9a-f]{64}$' THEN RAISE check_violation USING MESSAGE='Invalid embedding routing policy'; END IF;
  FOR route IN SELECT 'default' key,routing->'default' value UNION ALL SELECT * FROM jsonb_each(routing->'scopes') UNION ALL SELECT * FROM jsonb_each(routing->'kinds') LOOP
    selection:=route.value;
    IF jsonb_typeof(selection) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(selection))<>2
      OR NOT(selection ?& ARRAY['target','localOnly']) OR jsonb_typeof(selection->'localOnly') IS DISTINCT FROM 'boolean'
      OR (selection->>'target' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM embedding_targets WHERE fingerprint=selection->>'target' AND enabled
        AND (NOT(selection->>'localOnly')::boolean OR (descriptor->>'local')::boolean))) THEN
      RAISE check_violation USING MESSAGE='Invalid embedding routing target'; END IF;
  END LOOP;
  FOR route IN SELECT * FROM jsonb_each(routing->'scopes') LOOP
    IF NOT EXISTS(SELECT 1 FROM scopes WHERE id::text=route.key) THEN RAISE check_violation USING MESSAGE='Invalid embedding routing scope'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(routing->'kinds') key WHERE key NOT IN ('org','team','project','user','role')) THEN
    RAISE check_violation USING MESSAGE='Invalid embedding routing kind'; END IF;
  INSERT INTO embedding_policy(singleton,generation,digest,routing) VALUES(TRUE,1,policy_digest,routing)
    ON CONFLICT(singleton) DO UPDATE SET generation=embedding_policy.generation+1,digest=EXCLUDED.digest,routing=EXCLUDED.routing
      WHERE embedding_policy.routing<>EXCLUDED.routing OR embedding_policy.digest<>EXCLUDED.digest;
  SELECT * INTO STRICT result FROM embedding_policy WHERE singleton;
  INSERT INTO audit_log(principal_id,action,metadata) VALUES(actor,'write',jsonb_build_object('operation','embedding_policy_configured','generation',result.generation));
  RETURN jsonb_build_object('generation',result.generation::text,'digest',result.digest);
END $$;

CREATE FUNCTION continuum_embedding_worker_signatures() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
  'continuum_embedding_claim(jsonb,jsonb,uuid,integer,jsonb)','continuum_embedding_hydrate(uuid,uuid,bigint,integer)',
  'continuum_embedding_renew(uuid,uuid,bigint)','continuum_embedding_authorize(uuid,uuid,bigint)',
  'continuum_embedding_attempt(uuid,uuid,bigint,uuid,uuid,uuid,bigint,text,jsonb,bigint)',
  'continuum_embedding_apply(uuid,uuid,bigint,jsonb)','continuum_embedding_fail(uuid,uuid,bigint,jsonb)',
  'continuum_embedding_release(uuid,uuid,bigint)','continuum_embedding_worker_config(jsonb,jsonb,jsonb)','continuum_embedding_is_ready()']::text[] $$;
-- Same isolated LOGIN verification as the existing extraction capability,
-- with its own exact set. Keep source ACL validation in the predecessor gate.
DO $$ DECLARE definition TEXT; BEGIN
  definition:=pg_get_functiondef('continuum_extraction_assert_worker(name)'::regprocedure);
  IF position('continuum_extraction_worker_signatures()' IN definition)=0 THEN RAISE EXCEPTION 'embedding worker profile prerequisite unavailable'; END IF;
  EXECUTE replace(replace(replace(definition,'continuum_extraction_assert_worker','continuum_embedding_assert_worker'),
    'continuum_extraction_worker_signatures','continuum_embedding_worker_signatures'),'extraction worker','embedding worker');
END $$;
CREATE FUNCTION continuum_operator_bind_embedding_worker(actor UUID,database_role NAME,worker_principal UUID,target_scope UUID,target TEXT,enable BOOLEAN) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE role_id OID;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF enable IS NULL THEN RAISE check_violation USING MESSAGE='Invalid embedding binding'; END IF;
  IF enable THEN
    PERFORM continuum_embedding_assert_worker(database_role);
    SELECT oid INTO STRICT role_id FROM pg_roles WHERE rolname=database_role;
    PERFORM id FROM principals WHERE id=worker_principal AND kind='service' AND disabled_at IS NULL FOR SHARE;
    IF NOT FOUND OR NOT continuum_evidence_can_access(actor,target_scope,TRUE)
      OR NOT EXISTS(SELECT 1 FROM embedding_targets WHERE fingerprint=target AND enabled) THEN RAISE insufficient_privilege USING MESSAGE='Embedding binding unavailable'; END IF;
    INSERT INTO embedding_worker_bindings VALUES(role_id,database_role,worker_principal,target_scope,target,gen_random_uuid(),TRUE)
      ON CONFLICT(role_oid,scope_id,target_fingerprint) DO UPDATE SET role_name=EXCLUDED.role_name,principal_id=EXCLUDED.principal_id,generation=EXCLUDED.generation,enabled=TRUE;
  ELSE
    UPDATE embedding_worker_bindings SET enabled=FALSE,generation=gen_random_uuid() WHERE role_name=database_role AND scope_id=target_scope AND target_fingerprint=target;
    IF NOT FOUND THEN RAISE check_violation USING MESSAGE='Embedding binding unavailable'; END IF;
  END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',target_scope,jsonb_build_object('operation','embedding_worker_bound','enabled',enable));
END $$;
CREATE FUNCTION continuum_embedding_binding(target_scope UUID,target TEXT) RETURNS embedding_worker_bindings LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE binding embedding_worker_bindings%ROWTYPE;
BEGIN
  PERFORM continuum_embedding_assert_worker(session_user);
  SELECT b.* INTO binding FROM embedding_worker_bindings b JOIN pg_roles role ON role.oid=b.role_oid AND role.rolname=b.role_name
    JOIN principals p ON p.id=b.principal_id AND p.disabled_at IS NULL AND p.kind='service'
    WHERE b.role_name=session_user AND b.scope_id=target_scope AND b.target_fingerprint=target AND b.enabled FOR SHARE OF b,p;
  IF binding.role_oid IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Embedding worker unavailable'; END IF;
  RETURN binding;
END $$;
CREATE FUNCTION continuum_embedding_gate(cohort UUID,worker UUID,epoch BIGINT,require_lease BOOLEAN DEFAULT TRUE) RETURNS embedding_cohorts LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c embedding_cohorts%ROWTYPE; p embedding_policy%ROWTYPE; t embedding_targets%ROWTYPE; b embedding_worker_bindings%ROWTYPE; item RECORD;
BEGIN
  SELECT * INTO c FROM embedding_cohorts WHERE id=cohort;
  IF NOT FOUND OR worker IS NULL OR epoch IS NULL OR c.owner<>worker OR c.generation<>epoch OR c.target_fingerprint IS NULL THEN RETURN NULL; END IF;
  b:=continuum_embedding_binding(c.scope_id,c.target_fingerprint);
  SELECT * INTO p FROM embedding_policy WHERE singleton FOR SHARE;
  SELECT * INTO t FROM embedding_targets WHERE fingerprint=c.target_fingerprint AND enabled FOR SHARE;
  PERFORM provider FROM embedding_provider_control WHERE provider=t.provider AND dim=t.dim FOR UPDATE;
  IF b.role_oid<>c.login_oid OR b.generation<>c.binding_generation OR b.principal_id<>c.principal_id OR p.singleton IS NULL
    OR p.generation<>c.policy_generation OR p.paused OR t.fingerprint IS NULL
    OR continuum_embedding_route(c.scope_id)->>'target' IS DISTINCT FROM t.fingerprint THEN RETURN NULL; END IF;
  -- Sources first, then cohort/jobs. A source trigger never waits for provider
  -- control, avoiding the inverse provider -> source claim order.
  FOR item IN SELECT m.id FROM memories m JOIN embedding_jobs j ON j.memory_id=m.id JOIN embedding_cohort_jobs cj ON cj.job_id=j.id
    WHERE cj.cohort_id=cohort ORDER BY m.id FOR UPDATE OF m LOOP
    IF NOT continuum_embedding_source_policy(item.id,t.descriptor) THEN RETURN NULL; END IF;
  END LOOP;
  SELECT * INTO c FROM embedding_cohorts WHERE id=cohort FOR UPDATE;
  PERFORM j.id FROM embedding_jobs j JOIN embedding_cohort_jobs cj ON cj.job_id=j.id WHERE cj.cohort_id=cohort ORDER BY j.id FOR UPDATE OF j;
  IF c.state IN ('cancelled','abandoned','complete') OR c.deadline_at<=clock_timestamp()
    OR (require_lease AND c.lease_until<=clock_timestamp()) OR NOT EXISTS(SELECT 1 FROM embedding_cohort_jobs WHERE cohort_id=cohort)
    OR EXISTS(SELECT 1 FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id LEFT JOIN embedding_sources s ON s.memory_id=j.memory_id
      WHERE cj.cohort_id=cohort AND j.state='processing' AND (s.memory_id IS NULL OR s.erased OR s.input_hash IS NULL OR s.generation<>j.source_generation
        OR j.lease_owner<>worker OR j.lease_generation<>cj.lease_generation OR j.lease_until<=clock_timestamp()
        OR j.target_fingerprint<>c.target_fingerprint OR j.policy_generation<>p.generation))
    OR EXISTS(SELECT 1 FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id WHERE cj.cohort_id=cohort AND j.state NOT IN ('processing','permanent_failure')) THEN RETURN NULL; END IF;
  RETURN c;
END $$;
CREATE FUNCTION continuum_embedding_claim(target JSONB,process_policy JSONB,worker UUID,batch INTEGER,budget JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE p embedding_policy%ROWTYPE; t embedding_targets%ROWTYPE; control embedding_provider_control%ROWTYPE;
  old_cohort embedding_cohorts%ROWTYPE; c embedding_cohorts%ROWTYPE; b embedding_worker_bindings%ROWTYPE;
  item RECORD; selected UUID[]:='{}'; target_scope UUID; bytes BIGINT:=0; item_bytes BIGINT; probe_group_value UUID; privacy_scopes UUID[];
  w embedding_dispatch_windows%ROWTYPE; start_value TIMESTAMPTZ; original pipeline_budget_workflows%ROWTYPE;
  original_workflow UUID; original_owner UUID; original_generation BIGINT; candidate_workflow UUID;
BEGIN
  PERFORM continuum_embedding_assert_worker(session_user);
  IF worker IS NULL OR batch IS NULL OR batch NOT BETWEEN 1 AND 32 OR NOT continuum_pipeline_valid_profile(budget) THEN RAISE check_violation USING MESSAGE='Invalid embedding claim'; END IF;
  SELECT * INTO p FROM embedding_policy WHERE singleton FOR SHARE;
  SELECT * INTO t FROM embedding_targets WHERE fingerprint=target->>'fingerprint' AND enabled FOR SHARE;
  IF p.singleton IS NULL OR p.paused OR t.fingerprint IS NULL OR t.descriptor IS DISTINCT FROM target OR t.profile IS DISTINCT FROM budget
    OR p.generation::text IS DISTINCT FROM process_policy->>'generation' OR p.digest IS DISTINCT FROM process_policy->>'digest' THEN RETURN NULL; END IF;
  SELECT * INTO STRICT control FROM embedding_provider_control WHERE provider=t.provider AND dim=t.dim FOR UPDATE;
  IF control.state='parked' OR control.next_probe_at>clock_timestamp() THEN RETURN NULL; END IF;
  IF control.cohort_id IS NOT NULL THEN
    SELECT * INTO STRICT old_cohort FROM embedding_cohorts WHERE id=control.cohort_id;
    IF old_cohort.lease_until>clock_timestamp() THEN RETURN NULL; END IF;
    -- An expired lease never proves that an externally dispatched call settled.
    IF EXISTS(SELECT 1 FROM pipeline_budget_attempts WHERE workflow_id=old_cohort.workflow_id AND attempt_id=old_cohort.attempt_id AND state<>'settled') THEN RETURN NULL; END IF;
    FOR item IN SELECT m.id FROM memories m JOIN embedding_jobs j ON j.memory_id=m.id JOIN embedding_cohort_jobs cj ON cj.job_id=j.id
      WHERE cj.cohort_id=old_cohort.id ORDER BY m.id FOR UPDATE OF m SKIP LOCKED LOOP
      UPDATE embedding_jobs SET state='retry_wait',available_at=clock_timestamp()+interval '1 second',lease_owner=NULL,lease_until=NULL,
        lease_generation=lease_generation+1 WHERE memory_id=item.id AND cohort_id=old_cohort.id AND state='processing';
    END LOOP;
    IF EXISTS(SELECT 1 FROM embedding_jobs WHERE cohort_id=old_cohort.id AND state='processing') THEN RETURN NULL; END IF;
    UPDATE embedding_cohorts SET state=CASE WHEN state='complete' THEN state ELSE 'cancelled' END WHERE id=old_cohort.id;
    UPDATE embedding_provider_control SET cohort_id=NULL WHERE provider=t.provider AND dim=t.dim;
  END IF;
  -- Bounded reconciliation concerns already accepted pending captures only.
  -- Approved new policy never grants historical corpus or cancelled-source adoption.
  FOR item IN SELECT m.id FROM memories m JOIN embedding_sources source ON source.memory_id=m.id
    JOIN embedding_worker_bindings binding ON binding.scope_id=m.scope_id AND binding.target_fingerprint=t.fingerprint
      AND binding.role_name=session_user AND binding.enabled AND binding.role_oid=(SELECT oid FROM pg_roles WHERE rolname=session_user)
    WHERE source.status IN ('queued','processing','retry_wait','blocked_policy','superseded') AND NOT source.erased
      AND continuum_embedding_source_eligible(m.id) AND continuum_embedding_route(m.scope_id)->>'target'=t.fingerprint
      AND EXISTS(SELECT 1 FROM embedding_jobs prior WHERE prior.memory_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM embedding_jobs current_job WHERE current_job.memory_id=m.id AND current_job.source_generation=source.generation
        AND current_job.target_fingerprint=t.fingerprint AND current_job.policy_generation=p.generation)
    ORDER BY m.id LIMIT batch FOR UPDATE OF m SKIP LOCKED LOOP
    b:=continuum_embedding_binding((SELECT scope_id FROM memories WHERE id=item.id),t.fingerprint);
    IF NOT continuum_embedding_source_policy(item.id,t.descriptor) THEN CONTINUE; END IF;
    UPDATE pipeline_budget_workflows workflow SET cancelled=TRUE,generation=workflow.generation+1 FROM embedding_cohorts old_claim JOIN embedding_cohort_jobs membership ON membership.cohort_id=old_claim.id
      JOIN embedding_jobs old_job ON old_job.id=membership.job_id WHERE old_job.memory_id=item.id AND workflow.id=old_claim.workflow_id AND NOT workflow.cancelled;
    UPDATE embedding_jobs SET state='superseded',lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1
      WHERE memory_id=item.id AND state IN ('queued','processing','retry_wait','blocked_policy');
    UPDATE embedding_sources SET generation=generation+1,current_target=t.fingerprint,status='queued' WHERE memory_id=item.id;
    INSERT INTO embedding_jobs(memory_id,scope_id,source_generation,target_fingerprint,policy_generation,state)
      SELECT m.id,m.scope_id,source.generation,t.fingerprint,p.generation,'queued' FROM memories m JOIN embedding_sources source ON source.memory_id=m.id WHERE m.id=item.id;
  END LOOP;
  start_value:=to_timestamp(floor(extract(epoch FROM clock_timestamp())/(t.window_policy->>'seconds')::bigint)*(t.window_policy->>'seconds')::bigint);
  INSERT INTO embedding_dispatch_windows(target_fingerprint,policy_generation,provider,dim,max_dispatches,max_input_bytes,max_tokens,max_cost_micros,starts_at,ends_at)
    VALUES(t.fingerprint,p.generation,t.provider,t.dim,(t.window_policy->>'dispatches')::bigint,(t.window_policy->>'inputBytes')::bigint,
      (t.window_policy->>'tokens')::bigint,(t.window_policy->>'spendMicros')::bigint,start_value,start_value+(t.window_policy->>'seconds')::bigint*interval '1 second') ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT w FROM embedding_dispatch_windows WHERE provider=t.provider AND dim=t.dim AND starts_at=start_value FOR UPDATE;
  IF w.dispatches>=least(w.max_dispatches,(t.window_policy->>'dispatches')::bigint) OR w.input_bytes>=least(w.max_input_bytes,(t.window_policy->>'inputBytes')::bigint)
    OR w.tokens>=least(w.max_tokens,(t.window_policy->>'tokens')::bigint) THEN RETURN NULL; END IF;
  -- Filter original exhausted/deadline-closed allowances before the prefix.
  -- A retry in this window cannot allocate a fresh workflow or extend its life.
  FOR item IN SELECT m.id,j.id job_id,m.scope_id,j.isolate_item,j.probe_group,j.current_window,j.workflow_id,j.budget_owner,j.budget_generation,
      (SELECT array_agg(scope_id ORDER BY scope_id) FROM embedding_source_scopes WHERE memory_id=m.id) privacy_scopes,octet_length(m.title)::bigint+2+octet_length(m.body)::bigint input_bytes
    FROM embedding_jobs j JOIN memories m ON m.id=j.memory_id JOIN embedding_sources s ON s.memory_id=m.id
    JOIN embedding_worker_bindings binding ON binding.scope_id=m.scope_id AND binding.target_fingerprint=t.fingerprint
      AND binding.role_name=session_user AND binding.enabled AND binding.role_oid=(SELECT oid FROM pg_roles WHERE rolname=session_user)
    WHERE j.target_fingerprint=t.fingerprint AND j.policy_generation=p.generation AND j.state IN ('queued','retry_wait')
      AND j.available_at<=clock_timestamp() AND s.generation=j.source_generation AND NOT s.erased AND s.input_hash IS NOT NULL AND continuum_embedding_source_eligible(m.id)
      AND continuum_embedding_route(m.scope_id)->>'target'=t.fingerprint
      AND (j.current_window IS DISTINCT FROM w.id OR EXISTS(SELECT 1 FROM pipeline_budget_workflows original_budget
        WHERE original_budget.id=j.workflow_id AND original_budget.owner=j.budget_owner AND original_budget.generation=j.budget_generation
          AND NOT original_budget.cancelled AND original_budget.profile=budget AND original_budget.deadline_at>clock_timestamp() AND original_budget.active=0
          AND (original_budget.used->>'calls')::bigint<(budget->'limits'->>'calls')::bigint
          AND (original_budget.used->>'retries')::bigint<(budget->'limits'->>'retries')::bigint
          AND (original_budget.used->>'candidates')::bigint<(budget->'limits'->>'candidates')::bigint
          AND (original_budget.used->>'hydratedBytes')::bigint<(budget->'limits'->>'hydratedBytes')::bigint
          AND (NOT j.isolate_item OR ((SELECT count(*) FROM pipeline_budget_attempts WHERE workflow_id=original_budget.id)<=64
            AND (SELECT count(*) FROM embedding_cohorts WHERE workflow_id=original_budget.id AND diagnostic_ambiguous)<8))))
    ORDER BY j.available_at,j.id LIMIT batch FOR UPDATE OF m SKIP LOCKED LOOP
    IF cardinality(selected)>0 AND (probe_group_value IS DISTINCT FROM item.probe_group OR privacy_scopes IS DISTINCT FROM item.privacy_scopes) THEN CONTINUE; END IF;
    candidate_workflow:=CASE WHEN item.current_window=w.id THEN item.workflow_id ELSE NULL END;
    IF cardinality(selected)>0 AND original_workflow IS DISTINCT FROM candidate_workflow THEN CONTINUE; END IF;
    IF target_scope IS NOT NULL AND target_scope<>item.scope_id THEN CONTINUE; END IF;
    b:=continuum_embedding_binding(item.scope_id,t.fingerprint);
    IF NOT continuum_embedding_source_policy(item.id,t.descriptor) THEN CONTINUE; END IF;
    PERFORM id FROM embedding_jobs WHERE id=item.job_id AND state IN ('queued','retry_wait') AND available_at<=clock_timestamp() FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    item_bytes:=least(item.input_bytes,(budget->>'maxItemHydratedBytes')::bigint);
    IF bytes+item_bytes>(budget->'limits'->>'hydratedBytes')::bigint OR cardinality(selected)+1>(budget->'limits'->>'candidates')::bigint THEN CONTINUE; END IF;
    IF candidate_workflow IS NOT NULL THEN
      SELECT * INTO STRICT original FROM pipeline_budget_workflows WHERE id=candidate_workflow FOR UPDATE;
      IF original.owner IS DISTINCT FROM item.budget_owner OR original.generation IS DISTINCT FROM item.budget_generation
        OR original.cancelled OR original.deadline_at<=clock_timestamp() OR original.active<>0 OR original.profile IS DISTINCT FROM budget
        OR bytes+item_bytes>(budget->'limits'->>'hydratedBytes')::bigint-(original.used->>'hydratedBytes')::bigint
        OR cardinality(selected)+1>(budget->'limits'->>'candidates')::bigint-(original.used->>'candidates')::bigint THEN CONTINUE; END IF;
    END IF;
    IF cardinality(selected)=0 THEN
      original_workflow:=candidate_workflow;
      original_owner:=CASE WHEN candidate_workflow IS NOT NULL THEN item.budget_owner ELSE NULL END;
      original_generation:=CASE WHEN candidate_workflow IS NOT NULL THEN item.budget_generation ELSE NULL END;
    END IF;
    target_scope:=item.scope_id;probe_group_value:=item.probe_group;privacy_scopes:=item.privacy_scopes;bytes:=bytes+item_bytes;selected:=array_append(selected,item.job_id);
  END LOOP;
  IF cardinality(selected)=0 THEN RETURN NULL; END IF;
  b:=continuum_embedding_binding(target_scope,t.fingerprint);
  IF original_workflow IS NULL THEN
    original_workflow:=gen_random_uuid();original_owner:=gen_random_uuid();original_generation:=1;
    PERFORM continuum_pipeline_create(original_workflow,original_owner,budget);
  END IF;
  SELECT * INTO STRICT original FROM pipeline_budget_workflows WHERE id=original_workflow FOR UPDATE;
  INSERT INTO embedding_cohorts(owner,scope_id,policy_generation,target_fingerprint,login_oid,binding_generation,principal_id,credential_generation,
    workflow_id,attempt_id,attempt_owner,attempt_generation,window_id,lease_until,deadline_at,profile)
    VALUES(worker,target_scope,p.generation,t.fingerprint,b.role_oid,b.generation,b.principal_id,control.credential_generation,
      original_workflow,gen_random_uuid(),original_owner,original_generation,w.id,clock_timestamp()+interval '30 seconds',original.deadline_at,budget) RETURNING * INTO c;
  UPDATE embedding_jobs SET state='processing',cohort_id=c.id,lease_owner=worker,lease_generation=lease_generation+1,
    lease_until=c.lease_until,attempts=attempts+1,current_window=w.id,workflow_id=c.workflow_id,budget_owner=c.attempt_owner,budget_generation=c.attempt_generation WHERE id=ANY(selected);
  INSERT INTO embedding_cohort_jobs SELECT c.id,id,lease_generation FROM embedding_jobs WHERE id=ANY(selected);
  INSERT INTO embedding_cohort_scopes SELECT c.id,unnest(privacy_scopes);
  UPDATE embedding_provider_control SET cohort_id=c.id,state=CASE WHEN state='open' THEN 'half_open' ELSE state END WHERE provider=t.provider AND dim=t.dim;
  RETURN jsonb_build_object('id',c.id,'owner',worker,'generation',c.generation::text,'target',t.fingerprint,'policyGeneration',p.generation::text,
    'policyDigest',p.digest,'workflowId',c.workflow_id,'attemptId',c.attempt_id,'attemptOwner',c.attempt_owner,'attemptGeneration',c.attempt_generation,
    'remainingMs',greatest(0,floor(extract(epoch FROM c.deadline_at-clock_timestamp())*1000)),
    'retry',EXISTS(SELECT 1 FROM embedding_cohorts WHERE workflow_id=c.workflow_id AND id<>c.id),
    'jobs',(SELECT jsonb_agg(jsonb_build_object('id',id,'memoryId',memory_id,'sourceGeneration',source_generation::text,'leaseGeneration',lease_generation::text) ORDER BY id)
      FROM embedding_jobs WHERE id=ANY(selected)));
END $$;
CREATE FUNCTION continuum_embedding_hydrate(cohort UUID,worker UUID,epoch BIGINT,max_bytes INTEGER) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c embedding_cohorts%ROWTYPE; item RECORD; total BIGINT:=0; candidates BIGINT:=0; oversized UUID[]:='{}'; result JSONB; original pipeline_budget_workflows%ROWTYPE;
BEGIN
  IF max_bytes IS NULL OR max_bytes NOT BETWEEN 1 AND 4194304 THEN RAISE check_violation USING MESSAGE='Invalid embedding hydration bound'; END IF;
  c:=continuum_embedding_gate(cohort,worker,epoch);
  IF c.id IS NULL OR c.state<>'attached' OR c.hydrated_bytes IS NOT NULL THEN RAISE check_violation USING MESSAGE='Embedding source unavailable'; END IF;
  FOR item IN SELECT j.id,octet_length(m.title)::bigint+2+octet_length(m.body)::bigint bytes FROM embedding_cohort_jobs cj
    JOIN embedding_jobs j ON j.id=cj.job_id JOIN memories m ON m.id=j.memory_id WHERE cj.cohort_id=cohort ORDER BY j.id LOOP
    IF item.bytes>(c.profile->>'maxItemHydratedBytes')::bigint OR item.bytes>max_bytes THEN
      oversized:=array_append(oversized,item.id);
      UPDATE embedding_jobs SET state='permanent_failure',failure_code='EMBEDDING_INPUT_TOO_LARGE',lease_owner=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=item.id;
      UPDATE embedding_sources s SET status='permanent_failure' FROM embedding_jobs j WHERE j.id=item.id AND s.memory_id=j.memory_id AND s.generation=j.source_generation;
    ELSE total:=total+item.bytes;candidates:=candidates+1; END IF;
  END LOOP;
  IF total>least(max_bytes,(c.profile->'limits'->>'hydratedBytes')::bigint) THEN RAISE check_violation USING MESSAGE='Embedding hydration exceeds aggregate bound'; END IF;
  SELECT * INTO STRICT original FROM pipeline_budget_workflows WHERE id=c.workflow_id FOR UPDATE;
  IF original.owner IS DISTINCT FROM c.attempt_owner OR original.generation IS DISTINCT FROM c.attempt_generation OR original.cancelled
    OR original.deadline_at<=clock_timestamp() OR original.profile IS DISTINCT FROM c.profile
    OR total>(c.profile->'limits'->>'hydratedBytes')::bigint-(original.used->>'hydratedBytes')::bigint
    OR candidates>(c.profile->'limits'->>'candidates')::bigint-(original.used->>'candidates')::bigint THEN
    RAISE check_violation USING MESSAGE='Original embedding hydration allowance exhausted'; END IF;
  -- Charge before source text is selected, cumulatively across original retries.
  UPDATE pipeline_budget_workflows SET used=jsonb_set(jsonb_set(used,ARRAY['hydratedBytes'],
    to_jsonb((used->>'hydratedBytes')::bigint+total)),ARRAY['candidates'],to_jsonb((used->>'candidates')::bigint+candidates)) WHERE id=c.workflow_id;
  UPDATE embedding_cohorts SET hydrated_bytes=total WHERE id=cohort;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',j.id,'title',m.title,'body',m.body) ORDER BY j.id),'[]'::jsonb) INTO result
    FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id JOIN memories m ON m.id=j.memory_id
    WHERE cj.cohort_id=cohort AND j.state='processing';
  IF cardinality(oversized)>0 THEN INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(c.principal_id,'write',c.scope_id,
    jsonb_build_object('operation','embedding_input_too_large','count',cardinality(oversized))); END IF;
  IF total=0 THEN
    UPDATE embedding_cohorts SET state='complete' WHERE id=cohort;
    UPDATE embedding_provider_control SET cohort_id=NULL WHERE cohort_id=cohort;
  END IF;
  RETURN jsonb_build_object('items',result,'oversized',to_jsonb(oversized));
END $$;
CREATE FUNCTION continuum_embedding_authorize(cohort UUID,worker UUID,epoch BIGINT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c embedding_cohorts%ROWTYPE;
BEGIN c:=continuum_embedding_gate(cohort,worker,epoch);RETURN c.id IS NOT NULL; END $$;
CREATE FUNCTION continuum_embedding_renew(cohort UUID,worker UUID,epoch BIGINT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c embedding_cohorts%ROWTYPE;
BEGIN
  c:=continuum_embedding_gate(cohort,worker,epoch);
  IF c.id IS NULL THEN RETURN FALSE; END IF;
  UPDATE embedding_cohorts SET lease_until=clock_timestamp()+interval '30 seconds' WHERE id=cohort;
  UPDATE embedding_jobs SET lease_until=clock_timestamp()+interval '30 seconds' WHERE cohort_id=cohort AND state='processing';
  RETURN TRUE;
END $$;
CREATE FUNCTION continuum_embedding_attempt(cohort UUID,worker UUID,epoch BIGINT,workflow UUID,attempt UUID,original_owner UUID,original_epoch BIGINT,
  phase TEXT,value JSONB,retained BIGINT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c embedding_cohorts%ROWTYPE; t embedding_targets%ROWTYPE; w embedding_dispatch_windows%ROWTYPE; publish BOOLEAN; reserve_tokens BIGINT;
BEGIN
  SELECT * INTO c FROM embedding_cohorts WHERE id=cohort;
  IF c.id IS NULL OR worker IS NULL OR epoch IS NULL OR c.owner<>worker OR c.generation<>epoch
    OR c.workflow_id IS DISTINCT FROM workflow OR c.attempt_id IS DISTINCT FROM attempt OR c.attempt_owner IS DISTINCT FROM original_owner
    OR c.attempt_generation IS DISTINCT FROM original_epoch OR c.login_oid IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=session_user) THEN RETURN FALSE; END IF;
  IF phase='settle' THEN
    -- Original actual LOGIN/attempt authority survives privacy and lease fences,
    -- solely to record actual settlement. This grants no hydration/publication.
    SELECT * INTO c FROM embedding_cohorts WHERE id=cohort FOR UPDATE;
    IF c.settlement IS NOT NULL THEN
      IF c.settlement IS DISTINCT FROM value THEN RAISE check_violation USING MESSAGE='Conflicting embedding settlement'; END IF;
      RETURN FALSE;
    END IF;
    IF c.reservation IS NULL THEN RETURN FALSE; END IF;
    publish:=continuum_pipeline_settle(workflow,attempt,original_owner,original_epoch,value);
    UPDATE embedding_cohorts SET settlement=value,state=CASE WHEN state IN ('cancelled','abandoned') THEN state ELSE 'settled' END WHERE id=cohort;
    RETURN publish;
  END IF;
  c:=continuum_embedding_gate(cohort,worker,epoch);
  IF c.id IS NULL THEN RETURN FALSE; END IF;
  IF phase='reserve' THEN
    IF c.state<>'attached' OR NOT continuum_pipeline_valid_amounts(value) OR retained IS NULL OR retained<0 THEN RETURN FALSE; END IF;
    SELECT * INTO STRICT t FROM embedding_targets WHERE fingerprint=c.target_fingerprint;
    SELECT * INTO STRICT w FROM embedding_dispatch_windows WHERE id=c.window_id FOR UPDATE;
    reserve_tokens:=(value->>'contextTokens')::bigint+(value->>'completionTokens')::bigint;
    IF w.ends_at<=clock_timestamp() OR (value->>'calls')::bigint<>1
      OR w.dispatches+1>least(w.max_dispatches,(t.window_policy->>'dispatches')::bigint)
      OR w.input_bytes+(value->>'inputBytes')::bigint>least(w.max_input_bytes,(t.window_policy->>'inputBytes')::bigint)
      OR w.tokens+reserve_tokens>least(w.max_tokens,(t.window_policy->>'tokens')::bigint)
      OR w.cost_micros+(value->>'spendMicros')::bigint>least(w.max_cost_micros,(t.window_policy->>'spendMicros')::bigint) THEN RETURN FALSE; END IF;
    IF NOT continuum_pipeline_reserve(workflow,attempt,original_owner,original_epoch,value,retained) THEN RETURN FALSE; END IF;
    UPDATE embedding_dispatch_windows SET dispatches=dispatches+1,input_bytes=input_bytes+(value->>'inputBytes')::bigint,
      tokens=embedding_dispatch_windows.tokens+reserve_tokens,cost_micros=cost_micros+(value->>'spendMicros')::bigint WHERE id=w.id;
    UPDATE embedding_cohorts SET state='reserved',reservation=value,retained_bytes=retained WHERE id=cohort;
    RETURN TRUE;
  ELSIF phase='dispatch' THEN
    IF c.state<>'reserved' OR NOT continuum_pipeline_dispatch(workflow,attempt,original_owner,original_epoch) THEN RETURN FALSE; END IF;
    UPDATE embedding_cohorts SET state='dispatched' WHERE id=cohort;
    RETURN TRUE;
  END IF;
  RAISE check_violation USING MESSAGE='Invalid embedding accounting phase';
END $$;
CREATE FUNCTION continuum_embedding_apply(cohort UUID,worker UUID,epoch BIGINT,vectors JSONB) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c embedding_cohorts%ROWTYPE; t embedding_targets%ROWTYPE; item RECORD; vector_json JSONB; admission JSONB; count_value INTEGER;
BEGIN
  c:=continuum_embedding_gate(cohort,worker,epoch);
  IF c.id IS NULL OR c.state<>'settled' OR c.settlement IS NULL OR jsonb_typeof(vectors) IS DISTINCT FROM 'array'
    OR jsonb_array_length(vectors)>32 OR octet_length(vectors::text)>2097152 THEN RETURN FALSE; END IF;
  SELECT count(*) INTO count_value FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id WHERE cj.cohort_id=cohort AND j.state='processing';
  IF jsonb_array_length(vectors)<>count_value OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(vectors))<>count_value THEN RETURN FALSE; END IF;
  SELECT * INTO STRICT t FROM embedding_targets WHERE fingerprint=c.target_fingerprint;
  FOR item IN SELECT j.* FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id WHERE cj.cohort_id=cohort AND j.state='processing' ORDER BY j.id LOOP
    SELECT value->'vector' INTO vector_json FROM jsonb_array_elements(vectors) WHERE value->>'id'=item.id::text;
    IF jsonb_typeof(vector_json) IS DISTINCT FROM 'array' OR jsonb_array_length(vector_json)<>768 OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(vector_json) n WHERE jsonb_typeof(n)<>'number' OR abs(n::text::numeric)>3.4028234663852886e38) THEN
      RAISE check_violation USING MESSAGE='Invalid embedding response'; END IF;
    admission:=continuum_embedding_admit_vector(item.memory_id,t.descriptor);
    IF admission IS NULL OR admission->>'generation' IS DISTINCT FROM item.source_generation::text THEN RETURN FALSE; END IF;
    IF NOT continuum_embedding_vector_is_current(item.memory_id,t.provider,t.dim)
      AND NOT continuum_embedding_apply_vector(item.memory_id,vector_json::text,admission) THEN RETURN FALSE; END IF;
    -- The queue never replaces unrelated concurrent metadata with a snapshot.
    -- No relation candidate is accepted from a worker-supplied JSON object.
    UPDATE memories SET metadata=jsonb_set(metadata,'{related}','[]'::jsonb,TRUE),updated_at=clock_timestamp() WHERE id=item.memory_id;
    INSERT INTO embedding_completions(job_id) VALUES(item.id) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      INSERT INTO audit_log(principal_id,action,memory_id,scope_id,metadata) VALUES(c.principal_id,'write',item.memory_id,item.scope_id,
        jsonb_build_object('record_kind','embedding','operation','embedding_completed','embedded',TRUE,
          'embedding',jsonb_build_object('provider',t.provider,'dim',t.dim,'status','succeeded')));
    END IF;
    UPDATE embedding_jobs SET state='ready',completed_at=clock_timestamp(),failure_code=NULL,lease_owner=NULL,lease_until=NULL WHERE id=item.id;
    UPDATE embedding_sources SET status='ready' WHERE memory_id=item.memory_id AND generation=item.source_generation;
  END LOOP;
  UPDATE embedding_cohorts SET state='complete' WHERE id=cohort;
  UPDATE embedding_provider_control SET cohort_id=NULL,state='closed',failures=0,next_probe_at=clock_timestamp() WHERE cohort_id=cohort;
  RETURN TRUE;
END $$;
CREATE FUNCTION continuum_embedding_fail(cohort UUID,worker UUID,epoch BIGINT,failure JSONB) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c embedding_cohorts%ROWTYPE; t embedding_targets%ROWTYPE; failures_value BIGINT; delay_value BIGINT; permanent BOOLEAN;
  code_value TEXT:=failure->>'code';action_value TEXT:=failure->>'action';count_value INTEGER; left_group UUID; right_group UUID;
BEGIN
  IF code_value IS NULL OR code_value NOT IN ('EMBEDDING_ITEM_FAILED','EMBEDDING_INPUT_TOO_LARGE','EMBEDDING_TIMEOUT','EMBEDDING_NETWORK','EMBEDDING_AUTH',
    'EMBEDDING_RATE_LIMIT','EMBEDDING_SERVER','EMBEDDING_INVALID_RESPONSE','EMBEDDING_FAILED','EMBEDDING_STORAGE','EMBEDDING_BUDGET','EMBEDDING_POLICY','EMBEDDING_CANCELLED')
    OR action_value IS NULL OR action_value NOT IN ('retry','park_provider','isolate_item') OR octet_length(failure::text)>256
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(failure) key WHERE key NOT IN ('code','action','retryAfterMs')) THEN RAISE check_violation USING MESSAGE='Invalid embedding failure'; END IF;
  c:=continuum_embedding_gate(cohort,worker,epoch);
  IF c.id IS NULL THEN RETURN FALSE; END IF;
  INSERT INTO embedding_transition_receipts VALUES(cohort,'failure') ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  SELECT * INTO STRICT t FROM embedding_targets WHERE fingerprint=c.target_fingerprint;
  SELECT failures+1 INTO failures_value FROM embedding_provider_control WHERE provider=t.provider AND dim=t.dim FOR UPDATE;
  delay_value:=greatest(1000,least(300000,floor(1000*power(2,least(failures_value-1,20))*(0.5+random()/2))::bigint));
  IF failure ? 'retryAfterMs' THEN
    IF jsonb_typeof(failure->'retryAfterMs')<>'number' OR failure->>'retryAfterMs'!~'^(0|[1-9][0-9]*)$' THEN RAISE check_violation USING MESSAGE='Invalid embedding retry delay'; END IF;
    delay_value:=greatest(delay_value,least(300000,(failure->>'retryAfterMs')::bigint));
  END IF;
  SELECT count(*) INTO count_value FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id WHERE cj.cohort_id=cohort AND j.state='processing';
  IF c.state IN ('reserved','dispatched') THEN
    UPDATE embedding_jobs SET failure_code=code_value,available_at=clock_timestamp()+delay_value*interval '1 millisecond' WHERE cohort_id=cohort AND state='processing';
    UPDATE embedding_provider_control SET failures=failures_value,state=CASE WHEN action_value='park_provider' THEN 'parked' ELSE 'open' END,
      next_probe_at=clock_timestamp()+delay_value*interval '1 millisecond' WHERE provider=t.provider AND dim=t.dim AND credential_generation=c.credential_generation;
    INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(c.principal_id,'write',c.scope_id,
      jsonb_build_object('operation','embedding_transition','status','retry_wait','errorCode',code_value,'settlementPending',TRUE));
    RETURN TRUE;
  END IF;
  -- A diagnostic singleton needs a successful control from its ORIGINAL
  -- workflow. An all-failing tree never establishes blanket source poison.
  permanent:=code_value='EMBEDDING_ITEM_FAILED' AND action_value='isolate_item' AND count_value=1
    AND (NOT EXISTS(SELECT 1 FROM embedding_jobs WHERE cohort_id=cohort AND isolate_item)
      OR EXISTS(SELECT 1 FROM embedding_cohorts successful JOIN embedding_cohort_jobs membership ON membership.cohort_id=successful.id
        JOIN embedding_completions completed ON completed.job_id=membership.job_id WHERE successful.workflow_id=c.workflow_id));
  IF action_value='isolate_item' AND count_value>1 THEN
    left_group:=gen_random_uuid();right_group:=gen_random_uuid();
    WITH halves AS (SELECT id,row_number() OVER(ORDER BY id) position FROM embedding_jobs WHERE cohort_id=cohort AND state='processing')
      UPDATE embedding_jobs j SET probe_group=CASE WHEN halves.position<=(count_value+1)/2 THEN left_group ELSE right_group END
        FROM halves WHERE j.id=halves.id;
  END IF;
  UPDATE embedding_jobs SET state=CASE WHEN permanent THEN 'permanent_failure' ELSE 'retry_wait' END,failure_code=code_value,
    available_at=clock_timestamp()+delay_value*interval '1 millisecond',lease_owner=NULL,lease_until=NULL,
    isolate_item=isolate_item OR action_value='isolate_item',completed_at=CASE WHEN permanent THEN clock_timestamp() END
    WHERE cohort_id=cohort AND state='processing';
  UPDATE embedding_sources s SET status=j.state FROM embedding_jobs j WHERE j.cohort_id=cohort AND j.memory_id=s.memory_id AND j.source_generation=s.generation;
  UPDATE embedding_cohorts SET state='complete',diagnostic_ambiguous=(action_value='retry' AND code_value IN
    ('EMBEDDING_FAILED','EMBEDDING_INVALID_RESPONSE','EMBEDDING_SERVER')) OR (action_value='isolate_item' AND count_value=1 AND NOT permanent) WHERE id=cohort;
  UPDATE embedding_provider_control SET cohort_id=NULL,
    failures=CASE WHEN credential_generation<>c.credential_generation OR permanent OR (action_value='isolate_item' AND count_value>1) THEN failures ELSE failures_value END,
    state=CASE WHEN credential_generation<>c.credential_generation THEN state WHEN action_value='park_provider' THEN 'parked'
      WHEN permanent OR (action_value='isolate_item' AND count_value>1) THEN 'closed' ELSE 'open' END,
    next_probe_at=CASE WHEN credential_generation<>c.credential_generation THEN next_probe_at ELSE clock_timestamp()+delay_value*interval '1 millisecond' END
    WHERE provider=t.provider AND dim=t.dim AND cohort_id=cohort;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(c.principal_id,'write',c.scope_id,
    jsonb_build_object('operation','embedding_transition','status',CASE WHEN permanent THEN 'permanent_failure' ELSE 'retry_wait' END,'errorCode',code_value));
  RETURN TRUE;
END $$;
CREATE FUNCTION continuum_embedding_release(cohort UUID,worker UUID,epoch BIGINT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c embedding_cohorts%ROWTYPE;
BEGIN
  c:=continuum_embedding_gate(cohort,worker,epoch);
  IF c.id IS NULL OR c.state IN ('reserved','dispatched') THEN RETURN FALSE; END IF;
  UPDATE embedding_jobs SET state='retry_wait',available_at=clock_timestamp()+interval '1 second',lease_owner=NULL,lease_until=NULL WHERE cohort_id=cohort AND state='processing';
  UPDATE embedding_cohorts SET state='complete' WHERE id=cohort;
  UPDATE embedding_provider_control SET cohort_id=NULL WHERE cohort_id=cohort;
  RETURN TRUE;
END $$;

CREATE FUNCTION continuum_embedding_scope_memories(target_scope UUID) RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT memory_id FROM embedding_source_scopes WHERE scope_id=target_scope
  UNION SELECT r.source_memory_id FROM evidence_roots r JOIN evidence_versions v ON v.root_id=r.id
    WHERE r.source_memory_id IS NOT NULL AND v.id IN (SELECT continuum_evidence_scope_versions(target_scope));
$$;
CREATE FUNCTION continuum_embedding_erase_memory(memory UUID,page_limit INTEGER DEFAULT 1000) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE item RECORD;
BEGIN
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 1000 THEN RAISE check_violation USING MESSAGE='Invalid embedding erasure bound'; END IF;
  FOR item IN SELECT c.id,c.workflow_id FROM embedding_cohorts c WHERE EXISTS(SELECT 1 FROM embedding_cohort_jobs cj JOIN embedding_jobs j ON j.id=cj.job_id
      WHERE cj.cohort_id=c.id AND j.memory_id=memory) AND (c.scope_id IS NOT NULL OR c.target_fingerprint IS NOT NULL OR c.principal_id IS NOT NULL)
    ORDER BY c.id LIMIT page_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE pipeline_budget_workflows SET cancelled=TRUE,generation=generation+1 WHERE id=item.workflow_id AND NOT cancelled;
    UPDATE embedding_cohorts SET scope_id=NULL,target_fingerprint=NULL,principal_id=NULL,state='cancelled',lease_until=clock_timestamp() WHERE id=item.id;
  END LOOP;
  FOR item IN SELECT id FROM embedding_jobs WHERE memory_id=memory ORDER BY id LIMIT page_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE embedding_jobs SET state='cancelled',memory_id=NULL,scope_id=NULL,source_generation=NULL,target_fingerprint=NULL,policy_generation=NULL,
      lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1,failure_code=NULL,probe_group=NULL,
      current_window=NULL,workflow_id=NULL,budget_owner=NULL,budget_generation=NULL WHERE id=item.id;
  END LOOP;
  FOR item IN SELECT id FROM embedding_capture_receipts WHERE memory_id=memory ORDER BY id LIMIT page_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE embedding_capture_receipts SET principal_id=NULL,scope_id=NULL,key_hash=NULL,payload_digest=NULL,memory_id=NULL WHERE id=item.id;
  END LOOP;
  UPDATE embedding_sources SET input_hash=NULL,current_target=NULL,erased=TRUE,status='cancelled',generation=generation+1
    WHERE memory_id=memory AND (NOT erased OR input_hash IS NOT NULL OR current_target IS NOT NULL);
  DELETE FROM memory_embeddings WHERE memory_id=memory;
  RETURN NOT EXISTS(SELECT 1 FROM embedding_jobs WHERE memory_id=memory)
    AND NOT EXISTS(SELECT 1 FROM embedding_capture_receipts WHERE memory_id=memory);
END $$;
CREATE FUNCTION continuum_embedding_scope_is_erased(target_scope UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NOT EXISTS(SELECT 1 FROM embedding_sources s
      WHERE s.memory_id IN (SELECT continuum_embedding_scope_memories(target_scope)) AND (s.input_hash IS NOT NULL OR s.current_target IS NOT NULL OR NOT s.erased))
    AND NOT EXISTS(SELECT 1 FROM embedding_jobs j WHERE j.scope_id=target_scope OR j.memory_id IN (
      SELECT continuum_embedding_scope_memories(target_scope)))
    AND NOT EXISTS(SELECT 1 FROM embedding_capture_receipts r WHERE (r.scope_id=target_scope OR r.memory_id IN (
      SELECT continuum_embedding_scope_memories(target_scope)))
      AND (r.key_hash IS NOT NULL OR r.payload_digest IS NOT NULL OR r.principal_id IS NOT NULL OR r.memory_id IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM embedding_cohorts c JOIN embedding_cohort_scopes lineage ON lineage.cohort_id=c.id
      WHERE lineage.scope_id=target_scope AND (c.scope_id IS NOT NULL OR c.target_fingerprint IS NOT NULL OR c.principal_id IS NOT NULL OR c.state<>'cancelled'
        OR c.lease_until>clock_timestamp() OR EXISTS(SELECT 1 FROM pipeline_budget_workflows w WHERE w.id=c.workflow_id AND NOT w.cancelled)))
    AND NOT EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id IN (SELECT continuum_embedding_scope_memories(target_scope)));
$$;
CREATE FUNCTION continuum_operator_scrub_embedding_scope(actor UUID,subject UUID,target_scope UUID,page_limit INTEGER) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE item RECORD; processed INTEGER:=0; clean BOOLEAN; run principal_offboarding_runs%ROWTYPE;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  PERFORM * FROM continuum_operator_coordination_scope_privacy_state(actor,target_scope);
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 1000 OR NOT EXISTS(SELECT 1 FROM principal_user_scopes WHERE principal_id=subject AND scope_id=target_scope)
    OR NOT EXISTS(SELECT 1 FROM principal_offboarding_runs WHERE principal_id=subject AND scope_id=target_scope) THEN
    RAISE insufficient_privilege USING MESSAGE='Embedding erasure requires approved lifecycle'; END IF;
  SELECT * INTO STRICT run FROM principal_offboarding_runs WHERE principal_id=subject AND scope_id=target_scope FOR SHARE;
  FOR item IN SELECT m.id FROM memories m LEFT JOIN embedding_sources s ON s.memory_id=m.id
    WHERE m.id IN (SELECT continuum_embedding_scope_memories(target_scope)) AND (s.input_hash IS NOT NULL OR s.current_target IS NOT NULL OR NOT s.erased
      OR EXISTS(SELECT 1 FROM memory_embeddings WHERE memory_id=m.id)
      OR EXISTS(SELECT 1 FROM embedding_jobs WHERE memory_id=m.id) OR EXISTS(SELECT 1 FROM embedding_capture_receipts WHERE memory_id=m.id))
    ORDER BY m.id LIMIT page_limit FOR UPDATE OF m SKIP LOCKED LOOP
    PERFORM continuum_embedding_erase_memory(item.id,least(page_limit,100));processed:=processed+1;
  END LOOP;
  -- A cohort's owned-source lineage survives job detachment and source moves.
  FOR item IN SELECT c.id,c.workflow_id FROM embedding_cohorts c JOIN embedding_cohort_scopes lineage ON lineage.cohort_id=c.id
    WHERE lineage.scope_id=target_scope AND (c.scope_id IS NOT NULL OR c.target_fingerprint IS NOT NULL OR c.principal_id IS NOT NULL OR c.state<>'cancelled'
      OR EXISTS(SELECT 1 FROM pipeline_budget_workflows w WHERE w.id=c.workflow_id AND NOT w.cancelled))
    ORDER BY c.id LIMIT page_limit FOR UPDATE OF c SKIP LOCKED LOOP
    UPDATE pipeline_budget_workflows SET cancelled=TRUE,generation=generation+1 WHERE id=item.workflow_id AND NOT cancelled;
    UPDATE embedding_cohorts SET scope_id=NULL,target_fingerprint=NULL,principal_id=NULL,state='cancelled',lease_until=clock_timestamp() WHERE id=item.id;processed:=processed+1;
  END LOOP;
  FOR item IN SELECT r.id FROM embedding_capture_receipts r WHERE r.scope_id=target_scope
      AND (r.key_hash IS NOT NULL OR r.payload_digest IS NOT NULL OR r.principal_id IS NOT NULL OR r.memory_id IS NOT NULL)
    ORDER BY r.id LIMIT page_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE embedding_capture_receipts SET principal_id=NULL,scope_id=NULL,key_hash=NULL,payload_digest=NULL,memory_id=NULL WHERE id=item.id;processed:=processed+1;
  END LOOP;
  UPDATE embedding_worker_bindings SET enabled=FALSE,generation=gen_random_uuid() WHERE scope_id=target_scope AND enabled;
  DELETE FROM embedding_receipt_admission WHERE principal_id=subject;
  clean:=continuum_embedding_scope_is_erased(target_scope);
  -- Reuse the protected approval-bound lifecycle receipt. An ordinary scoped
  -- audit is correctly forbidden once the owned scope has been fenced.
  IF processed>0 THEN INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'archive',target_scope,
    jsonb_build_object('operation','principal_evidence_privacy_repaired','principal_id',subject,'run_id',run.run_id,
      'approval_id',run.approval_id::text,'acknowledged_evidence_hash',run.approval_evidence_hash,'rows_processed',processed)); END IF;
  RETURN jsonb_build_object('complete',clean,'processed',processed,'batch_full',NOT clean AND processed>=page_limit);
END $$;
ALTER FUNCTION continuum_offboarding_lifecycle_state_is_erased(UUID) RENAME TO continuum_offboarding_lifecycle_state_is_erased_pre_embedding;
CREATE FUNCTION continuum_offboarding_lifecycle_state_is_erased(target_run UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_offboarding_lifecycle_state_is_erased_pre_embedding(target_run) AND EXISTS(SELECT 1 FROM principal_offboarding_runs
    WHERE run_id=target_run AND continuum_embedding_scope_is_erased(scope_id));
$$;

CREATE FUNCTION continuum_operator_embedding_control(actor UUID,operation TEXT,target TEXT,page_limit INTEGER) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE t embedding_targets%ROWTYPE; item RECORD; processed INTEGER:=0;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF operation IS NULL OR operation NOT IN ('pause','resume','drain','retry','cancel','reconcile') OR page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE check_violation USING MESSAGE='Invalid embedding operation'; END IF;
  IF target IS NULL THEN
    IF operation NOT IN ('pause','resume','drain') THEN RAISE check_violation USING MESSAGE='Embedding target is required'; END IF;
    UPDATE embedding_policy SET paused=operation<>'resume' WHERE singleton;
  ELSE
    SELECT * INTO STRICT t FROM embedding_targets WHERE fingerprint=target FOR SHARE;
    IF operation IN ('pause','drain') THEN
      UPDATE embedding_provider_control SET state='parked' WHERE provider=t.provider AND dim=t.dim;
    ELSIF operation='resume' THEN
      UPDATE embedding_provider_control SET state='open',credential_generation=credential_generation+1,next_probe_at=clock_timestamp() WHERE provider=t.provider AND dim=t.dim;
    ELSIF operation='retry' THEN
      -- Retry only current nonprivacy failures. Original attempt records and
      -- window reservations remain; this is never a budget refund.
      FOR item IN SELECT m.id memory_id,j.id FROM embedding_jobs j JOIN memories m ON m.id=j.memory_id JOIN embedding_sources s ON s.memory_id=m.id
        WHERE j.target_fingerprint=target AND j.state IN ('permanent_failure','retry_wait','blocked_policy') AND j.source_generation=s.generation AND NOT s.erased
          AND continuum_embedding_source_eligible(m.id) AND continuum_embedding_route(m.scope_id)->>'target'=target
        ORDER BY j.id LIMIT page_limit FOR UPDATE OF m SKIP LOCKED LOOP
        UPDATE embedding_jobs SET state='queued',available_at=clock_timestamp(),failure_code=NULL WHERE id=item.id;processed:=processed+1;
      END LOOP;
    ELSIF operation='cancel' THEN
      FOR item IN SELECT m.id memory_id,j.id FROM embedding_jobs j JOIN memories m ON m.id=j.memory_id WHERE j.target_fingerprint=target
        AND j.state IN ('queued','processing','retry_wait','blocked_policy') ORDER BY j.id LIMIT page_limit FOR UPDATE OF m SKIP LOCKED LOOP
        UPDATE pipeline_budget_workflows w SET cancelled=TRUE,generation=w.generation+1 FROM embedding_cohorts c JOIN embedding_cohort_jobs cj ON cj.cohort_id=c.id
          WHERE cj.job_id=item.id AND w.id=c.workflow_id AND NOT w.cancelled;
        UPDATE embedding_jobs SET state='cancelled',lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1 WHERE id=item.id;
        UPDATE embedding_sources SET status='cancelled' WHERE memory_id=item.memory_id;processed:=processed+1;
      END LOOP;
    ELSIF operation='reconcile' THEN
      -- Only previously accepted queue work is eligible. This does not enqueue
      -- the historical corpus, promotion or supersession writers.
      FOR item IN SELECT m.id FROM memories m JOIN embedding_sources s ON s.memory_id=m.id
        WHERE s.status IN ('queued','processing','retry_wait','blocked_policy','superseded') AND NOT s.erased
          AND EXISTS(SELECT 1 FROM embedding_jobs j WHERE j.memory_id=m.id)
          AND continuum_embedding_route(m.scope_id)->>'target'=target AND continuum_embedding_source_policy(m.id,t.descriptor)
        ORDER BY m.id LIMIT page_limit FOR UPDATE OF m SKIP LOCKED LOOP
        UPDATE embedding_jobs SET state='superseded',lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1
          WHERE memory_id=item.id AND state IN ('queued','processing','retry_wait','blocked_policy')
            AND (target_fingerprint IS DISTINCT FROM target OR policy_generation IS DISTINCT FROM (SELECT generation FROM embedding_policy WHERE singleton));
        UPDATE embedding_sources SET generation=generation+1 WHERE memory_id=item.id;
        INSERT INTO embedding_jobs(memory_id,scope_id,source_generation,target_fingerprint,policy_generation,state)
          SELECT m.id,m.scope_id,s.generation,target,p.generation,'queued' FROM memories m JOIN embedding_sources s ON s.memory_id=m.id CROSS JOIN embedding_policy p
          WHERE m.id=item.id AND p.singleton ON CONFLICT DO NOTHING;
        UPDATE embedding_sources SET current_target=target,status='queued' WHERE memory_id=item.id;processed:=processed+1;
      END LOOP;
    END IF;
  END IF;
  INSERT INTO audit_log(principal_id,action,metadata) VALUES(actor,'write',jsonb_build_object('operation','embedding_'||operation,'processed',processed));
  RETURN jsonb_build_object('operation',operation,'processed',processed,'activeLeases',
    (SELECT count(*) FROM embedding_jobs WHERE state='processing' AND lease_until>clock_timestamp()),'settled',
    NOT EXISTS(SELECT 1 FROM embedding_cohorts c JOIN pipeline_budget_attempts a ON a.workflow_id=c.workflow_id AND a.attempt_id=c.attempt_id WHERE a.state<>'settled'));
END $$;
CREATE FUNCTION continuum_operator_embedding_metrics(actor UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSONB;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('status',state,'count',count_value,'oldestAgeSeconds',age_value,'attempts',attempt_value,
      'latestHeartbeatAgeSeconds',heartbeat_age_value) ORDER BY state),'[]'::jsonb)
    INTO result FROM (SELECT state,count(*) count_value,greatest(0,floor(extract(epoch FROM clock_timestamp()-min(accepted_at)))) age_value,
      least(9007199254740991,sum(attempts)) attempt_value,
      CASE WHEN state='processing' THEN greatest(0,floor(extract(epoch FROM clock_timestamp()-max(lease_until)+interval '30 seconds'))) END heartbeat_age_value
      FROM embedding_jobs GROUP BY state) counts;
  INSERT INTO audit_log(principal_id,action,metadata) VALUES(actor,'read',jsonb_build_object('operation','embedding_metrics'));
  RETURN result;
END $$;

CREATE FUNCTION continuum_embedding_worker_config(target JSONB,process_policy JSONB,budget JSONB) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_embedding_assert_worker(session_user);
  RETURN continuum_embedding_is_ready() AND EXISTS(SELECT 1 FROM embedding_policy p,embedding_targets t,embedding_worker_bindings b,principals principal
    WHERE p.singleton AND p.generation::text=process_policy->>'generation' AND p.digest=process_policy->>'digest'
      AND t.fingerprint=target->>'fingerprint' AND t.descriptor=target AND t.profile=budget AND t.enabled
      AND b.target_fingerprint=t.fingerprint AND b.enabled AND b.role_name=session_user AND b.role_oid=(SELECT oid FROM pg_roles WHERE rolname=session_user)
      AND principal.id=b.principal_id AND principal.kind='service' AND principal.disabled_at IS NULL);
END $$;
CREATE FUNCTION continuum_operator_embedding_leases(actor UUID,target TEXT,page_limit INTEGER) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE items JSONB; count_value INTEGER;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 1000 OR (target IS NOT NULL AND target!~'^[0-9a-f]{64}$') THEN
    RAISE check_violation USING MESSAGE='Invalid embedding lease status bound'; END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY position) FILTER(WHERE position<=page_limit),'[]'::jsonb),count(*) INTO items,count_value FROM (
    SELECT jsonb_build_object('cohortId',c.id,'originalOwner',c.owner,'status',c.state,'leaseUntil',c.lease_until,'deadlineAt',c.deadline_at,
      'unsettledAccounting',EXISTS(SELECT 1 FROM pipeline_budget_attempts a WHERE a.workflow_id=c.workflow_id AND a.attempt_id=c.attempt_id AND a.state<>'settled')) value,
      row_number() OVER(ORDER BY c.created_at,c.id) position
    FROM embedding_cohorts c WHERE (target IS NULL OR c.target_fingerprint=target) AND (
      EXISTS(SELECT 1 FROM embedding_jobs j WHERE j.cohort_id=c.id AND j.state='processing')
      OR EXISTS(SELECT 1 FROM pipeline_budget_attempts a WHERE a.workflow_id=c.workflow_id AND a.attempt_id=c.attempt_id AND a.state<>'settled'))
    ORDER BY c.created_at,c.id LIMIT page_limit+1) bounded;
  INSERT INTO audit_log(principal_id,action,metadata) VALUES(actor,'read',jsonb_build_object('operation','embedding_lease_status','count',count_value));
  RETURN jsonb_build_object('items',items,'limit',page_limit,'truncated',count_value>page_limit);
END $$;
CREATE TABLE embedding_recoveries(cohort_id UUID PRIMARY KEY REFERENCES embedding_cohorts(id),accounting TEXT NOT NULL CHECK(accounting IN ('settled','no-reservation')));
CREATE TRIGGER embedding_recovery_immutable BEFORE UPDATE OR DELETE ON embedding_recoveries FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE FUNCTION continuum_operator_recover_embedding(actor UUID,cohort UUID,original_owner UUID,confirmation TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c embedding_cohorts%ROWTYPE; accounting pipeline_budget_attempts%ROWTYPE; t embedding_targets%ROWTYPE; item RECORD;
BEGIN
  PERFORM continuum_evidence_require_operator(actor);
  IF confirmation IS DISTINCT FROM 'CONFIRMED ORIGINAL PROCESS EXIT' THEN RAISE check_violation USING MESSAGE='Embedding recovery requires proved original process exit'; END IF;
  SELECT * INTO STRICT c FROM embedding_cohorts WHERE id=cohort;
  IF c.owner IS DISTINCT FROM original_owner OR c.lease_until>clock_timestamp() THEN RAISE check_violation USING MESSAGE='Original embedding owner is still leased'; END IF;
  SELECT * INTO t FROM embedding_targets WHERE fingerprint=c.target_fingerprint;
  IF t.fingerprint IS NOT NULL THEN PERFORM provider FROM embedding_provider_control WHERE provider=t.provider AND dim=t.dim FOR UPDATE; END IF;
  FOR item IN SELECT m.id FROM memories m JOIN embedding_jobs j ON j.memory_id=m.id JOIN embedding_cohort_jobs cj ON cj.job_id=j.id
    WHERE cj.cohort_id=cohort ORDER BY m.id FOR UPDATE OF m LOOP NULL; END LOOP;
  SELECT * INTO STRICT c FROM embedding_cohorts WHERE id=cohort FOR UPDATE;
  IF c.owner IS DISTINCT FROM original_owner OR c.lease_until>clock_timestamp() THEN RAISE check_violation USING MESSAGE='Original embedding owner is still leased'; END IF;
  IF EXISTS(SELECT 1 FROM embedding_recoveries WHERE cohort_id=cohort) THEN RETURN jsonb_build_object('recovered',FALSE,'renewed',FALSE); END IF;
  SELECT * INTO accounting FROM pipeline_budget_attempts WHERE workflow_id=c.workflow_id AND attempt_id=c.attempt_id;
  IF accounting.attempt_id IS NOT NULL AND accounting.state<>'settled' THEN
    PERFORM continuum_pipeline_settle(c.workflow_id,c.attempt_id,c.attempt_owner,c.attempt_generation,'{"provenance":"unknown"}'::jsonb);
  END IF;
  INSERT INTO embedding_recoveries VALUES(cohort,CASE WHEN accounting.attempt_id IS NULL THEN 'no-reservation' ELSE 'settled' END);
  -- Preserve every original maximum/window charge. No source cancellation is
  -- reversed; only still-current processing jobs become eligible for a future
  -- separately admitted dispatch under the existing provider-window policy.
  UPDATE embedding_jobs j SET state='retry_wait',available_at=clock_timestamp()+interval '1 second',lease_owner=NULL,lease_until=NULL,lease_generation=j.lease_generation+1
    WHERE j.cohort_id=cohort AND j.state='processing' AND EXISTS(SELECT 1 FROM embedding_sources s WHERE s.memory_id=j.memory_id AND s.generation=j.source_generation AND NOT s.erased)
      AND continuum_embedding_source_eligible(j.memory_id);
  UPDATE embedding_cohorts SET state=CASE WHEN state='cancelled' THEN state ELSE 'abandoned' END WHERE id=cohort;
  UPDATE embedding_provider_control SET cohort_id=NULL,state=CASE WHEN state='parked' THEN state ELSE 'open' END,next_probe_at=clock_timestamp()+interval '1 second' WHERE cohort_id=cohort;
  INSERT INTO audit_log(principal_id,action,metadata) VALUES(actor,'write',jsonb_build_object('operation','embedding_process_exit_reconciled'));
  RETURN jsonb_build_object('recovered',TRUE,'renewed',FALSE);
END $$;
CREATE FUNCTION continuum_embedding_app_signatures() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
  'continuum_embedding_enqueue(uuid,uuid,jsonb,jsonb,text)','continuum_embedding_status(uuid,uuid)',
  'continuum_embedding_receipt_begin(uuid,uuid,text,text,text)','continuum_embedding_receipt_finish(uuid,uuid,text,text,uuid)',
  'continuum_embedding_replay_extraction(uuid,uuid)',
  'continuum_embedding_admit_vector(uuid,jsonb)','continuum_embedding_apply_vector(uuid,text,jsonb)',
  'continuum_embedding_vector_is_current(uuid,text,integer)','continuum_embedding_target_is_current(jsonb,uuid[])',
  'continuum_embedding_is_ready()']::text[] $$;
CREATE FUNCTION continuum_embedding_operator_signatures() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
  'continuum_operator_embedding_target(uuid,jsonb,jsonb,jsonb,boolean)','continuum_operator_embedding_policy(uuid,jsonb,text)',
  'continuum_operator_bind_embedding_worker(uuid,name,uuid,uuid,text,boolean)',
  'continuum_operator_embedding_control(uuid,text,text,integer)','continuum_operator_embedding_metrics(uuid)',
  'continuum_operator_embedding_leases(uuid,text,integer)',
  'continuum_operator_scrub_embedding_scope(uuid,uuid,uuid,integer)','continuum_operator_recover_embedding(uuid,uuid,uuid,text)']::text[] $$;
CREATE FUNCTION continuum_embedding_target_is_current(target JSONB,target_scopes UUID[]) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT target IS NOT NULL AND cardinality(target_scopes)>0 AND cardinality(target_scopes)<=10000
    AND EXISTS(SELECT 1 FROM embedding_targets t JOIN embedding_vector_spaces v ON v.provider=t.provider AND v.dim=t.dim
      WHERE t.fingerprint=target->>'fingerprint' AND t.descriptor=target AND t.enabled AND v.space_fingerprint=target->>'spaceFingerprint')
    AND EXISTS(SELECT 1 FROM embedding_policy WHERE singleton)
    AND NOT EXISTS(SELECT 1 FROM unnest(target_scopes) scope WHERE continuum_embedding_route(scope)->>'target' IS DISTINCT FROM target->>'fingerprint'
      OR (COALESCE((continuum_embedding_route(scope)->>'localOnly')::boolean,FALSE) AND (target->>'local')::boolean IS NOT TRUE));
$$;
CREATE TABLE embedding_contract_functions(signature TEXT PRIMARY KEY,body_hash TEXT NOT NULL,definer BOOLEAN NOT NULL,volatility "char" NOT NULL);
CREATE TABLE embedding_contract_relations(name TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
CREATE FUNCTION continuum_embedding_private_tables() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
  'embedding_vector_spaces','embedding_targets','embedding_policy','embedding_sources','embedding_source_scopes','embedding_jobs',
  'embedding_capture_receipts','embedding_admission','embedding_scope_admission','embedding_receipt_admission','embedding_provider_control',
  'embedding_dispatch_windows','embedding_worker_bindings','embedding_cohorts','embedding_cohort_jobs','embedding_cohort_scopes',
  'embedding_completions','embedding_transition_receipts','embedding_recoveries','embedding_contract_functions','embedding_contract_relations']::text[] $$;
CREATE FUNCTION continuum_embedding_relation_fingerprint(relation REGCLASS) RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('owner',c.relowner,'kind',c.relkind,
    'attributes',(SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(pg_get_constraintdef(oid,TRUE) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(indexrelid),indisvalid,indisready) ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid=c.oid),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid,TRUE) ORDER BY tgname) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal))::text,'UTF8')),'hex')
    FROM pg_class c WHERE c.oid=relation;
$$;
CREATE FUNCTION continuum_embedding_is_ready() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_brief_is_ready() AND EXISTS(SELECT 1 FROM embedding_contract_functions) AND EXISTS(SELECT 1 FROM embedding_contract_relations)
    AND NOT EXISTS(SELECT 1 FROM embedding_contract_functions c LEFT JOIN pg_proc f ON f.oid=to_regprocedure(c.signature)
      WHERE f.oid IS NULL OR encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>c.body_hash OR f.prosecdef<>c.definer OR f.provolatile<>c.volatility
        OR f.proowner<>(SELECT relowner FROM pg_class WHERE oid='memories'::regclass)
        OR NOT COALESCE(f.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',(SELECT n.nspname FROM pg_namespace n JOIN pg_class m ON m.relnamespace=n.oid WHERE m.oid='memories'::regclass))],FALSE)
        OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM embedding_contract_relations WHERE fingerprint IS DISTINCT FROM continuum_embedding_relation_fingerprint(to_regclass(name)))
    AND NOT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
      WHERE c.relnamespace=(SELECT relnamespace FROM pg_class WHERE oid='memories'::regclass) AND c.relname=ANY(continuum_embedding_private_tables())
        AND c.relkind='r' AND acl.grantee<>c.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) acl
      WHERE c.relnamespace=(SELECT relnamespace FROM pg_class WHERE oid='memories'::regclass) AND c.relname=ANY(continuum_embedding_private_tables()) AND acl.grantee<>c.relowner)
    AND EXISTS(SELECT 1 FROM embedding_admission WHERE singleton AND active=(SELECT count(*) FROM embedding_jobs WHERE state IN ('queued','processing','retry_wait','blocked_policy')))
    AND NOT EXISTS(SELECT 1 FROM embedding_jobs j WHERE j.state IN ('queued','processing','retry_wait','blocked_policy')
      AND NOT EXISTS(SELECT 1 FROM embedding_scope_admission counter WHERE counter.scope_id=j.scope_id))
    AND NOT EXISTS(SELECT 1 FROM embedding_scope_admission counter WHERE counter.active<>(SELECT count(*) FROM embedding_jobs j WHERE j.scope_id=counter.scope_id AND j.state IN ('queued','processing','retry_wait','blocked_policy')));
$$;
DO $$
DECLARE schema_name TEXT:=current_schema();f RECORD;grant_entry RECORD;signature TEXT;definition TEXT;revised TEXT;candidate RECORD;ledger TEXT;
  app_signatures TEXT[]:=continuum_embedding_app_signatures();op_signatures TEXT[]:=continuum_embedding_operator_signatures();
BEGIN
  -- No inherited default grant may expose the private queue or worker ports.
  FOR f IN SELECT c.oid,c.oid::regclass qualified_name,c.relowner FROM pg_class c WHERE c.relnamespace=quote_ident(schema_name)::regnamespace AND c.relname=ANY(continuum_embedding_private_tables()) AND c.relkind='r' LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',f.qualified_name);
    FOR grant_entry IN SELECT DISTINCT r.rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE c.oid=f.oid AND acl.grantee<>c.relowner LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',f.qualified_name,grant_entry.rolname);
    END LOOP;
  END LOOP;
  FOR f IN SELECT oid,oid::regprocedure signature,proowner FROM pg_proc WHERE pronamespace=quote_ident(schema_name)::regnamespace
    AND (proname LIKE 'continuum_embedding_%' OR proname LIKE 'continuum_operator_embedding_%'
      OR proname IN ('continuum_operator_bind_embedding_worker','continuum_operator_scrub_embedding_scope','continuum_operator_recover_embedding',
        'continuum_offboarding_lifecycle_state_is_erased','continuum_offboarding_lifecycle_state_is_erased_pre_embedding')) LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',f.signature,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    FOR grant_entry IN SELECT DISTINCT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE p.oid=f.oid AND acl.grantee<>p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,grant_entry.rolname);
    END LOOP;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['continuum_assert_application_role_allowlist(name,boolean)','continuum_assert_standup_application_role_allowlist(name,boolean)'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'(''continuum_standup_is_ready()'')','(''continuum_standup_is_ready()''),('''||replace(array_to_string(app_signatures,'''),('''),' ','')||''')');
    revised:=replace(revised,'(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'')',
      '(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)''),('''||replace(array_to_string(op_signatures,'''),('''),' ','')||''')');
    IF revised=definition THEN RAISE EXCEPTION 'unable to extend embedding allowlist'; END IF;
    EXECUTE revised;
  END LOOP;
  FOR candidate IN SELECT * FROM continuum_embedding_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    FOREACH signature IN ARRAY app_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name); END LOOP;
    IF candidate.operator THEN FOREACH signature IN ARRAY op_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name); END LOOP; END IF;
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
  -- Only the verified lifecycle wrapper was changed, never adopt unrelated drift.
  FOREACH ledger IN ARRAY ARRAY['evidence_contract_functions','extraction_contract_functions','connector_contract_functions','brief_contract_functions'] LOOP
    IF to_regclass(format('%I.%I',schema_name,ledger)) IS NOT NULL THEN
      EXECUTE format('UPDATE %I c SET body_hash=encode(sha256(convert_to(f.prosrc,''UTF8'')),''hex''),definer=f.prosecdef,volatility=f.provolatile FROM pg_proc f
        WHERE f.oid=to_regprocedure(c.signature) AND f.oid=''continuum_offboarding_lifecycle_state_is_erased(uuid)''::regprocedure',ledger);
    END IF;
  END LOOP;
END $$;
INSERT INTO embedding_contract_functions SELECT oid::regprocedure::text,encode(sha256(convert_to(prosrc,'UTF8')),'hex'),prosecdef,provolatile
  FROM pg_proc WHERE pronamespace=quote_ident(current_schema())::regnamespace
    AND (proname LIKE 'continuum_embedding_%' OR proname LIKE 'continuum_operator_embedding_%'
      OR proname IN ('continuum_operator_bind_embedding_worker','continuum_operator_scrub_embedding_scope','continuum_operator_recover_embedding',
        'continuum_offboarding_lifecycle_state_is_erased','continuum_offboarding_lifecycle_state_is_erased_pre_embedding'));
INSERT INTO embedding_contract_relations SELECT oid::regclass::text,continuum_embedding_relation_fingerprint(oid)
  FROM pg_class WHERE relnamespace=quote_ident(current_schema())::regnamespace AND relkind='r' AND (relname=ANY(continuum_embedding_private_tables()) OR relname IN ('memories','memory_embeddings','evidence_roots','evidence_state'));
