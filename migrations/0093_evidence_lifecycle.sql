-- Empty, lazy evidence foundation. No historical source rewrite or enabled generator.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE continuum_evidence_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $$
DECLARE candidate RECORD;
BEGIN
  FOR candidate IN SELECT profile.*,role.rolname FROM continuum_pgvector_role_profiles profile
    JOIN pg_catalog.pg_roles role ON role.oid=profile.database_role_oid WHERE profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_evidence_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Continuum skipped evidence grants for role OID % (SQLSTATE %); explicit regrant required',candidate.database_role_oid,SQLSTATE;
    END;
  END LOOP;
END;
$$;

CREATE TABLE evidence_roots(
  id UUID PRIMARY KEY,
  source_memory_id UUID UNIQUE,
  scope_id UUID NOT NULL REFERENCES scopes(id),
  generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0),
  current_version UUID,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  expiry_ceiling TIMESTAMPTZ,
  residency TEXT NOT NULL DEFAULT 'any' CHECK(residency IN ('any','local-only')),
  -- Local memory reference data needs no external document grant. Connector
  -- artifacts cannot use this default; unsupported connector kinds deny below.
  external_state TEXT NOT NULL DEFAULT 'not-required' CHECK(external_state IN ('not-required','allow','deny','unknown')),
  checked_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  CHECK(external_state<>'allow' OR (checked_at IS NOT NULL AND valid_until>checked_at))
);
CREATE TABLE evidence_versions(
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  root_id UUID NOT NULL REFERENCES evidence_roots(id),
  scope_id UUID NOT NULL REFERENCES scopes(id),
  kind TEXT NOT NULL CHECK(kind IN ('source-document-version','extracted-assertion','derived-observation','brief-section-version','history','cache','trace','managed-export','queued-payload')),
  previous_version UUID REFERENCES evidence_versions(id),
  provenance JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ,
  depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 16),
  root_count INTEGER NOT NULL CHECK(root_count BETWEEN 1 AND 256),
  parent_count INTEGER NOT NULL CHECK(parent_count BETWEEN 0 AND 64)
);
CREATE INDEX evidence_versions_scope_idx ON evidence_versions(scope_id,root_id,id);
CREATE INDEX evidence_versions_root_idx ON evidence_versions(root_id,id);
ALTER TABLE evidence_roots ADD CONSTRAINT evidence_current_version_fk FOREIGN KEY(current_version) REFERENCES evidence_versions(id);
CREATE TABLE evidence_payloads(
  version_id UUID PRIMARY KEY REFERENCES evidence_versions(id),
  payload TEXT NOT NULL CHECK(octet_length(payload)<=1048576),
  content_hash TEXT NOT NULL CHECK(content_hash~'^[0-9a-f]{64}$')
);
CREATE TABLE evidence_edges(
  version_id UUID NOT NULL REFERENCES evidence_versions(id),
  parent_id UUID NOT NULL REFERENCES evidence_versions(id),
  kind TEXT NOT NULL CHECK(kind IN ('source','assertion','derivation','copy')),
  PRIMARY KEY(version_id,parent_id), CHECK(version_id<>parent_id)
);
CREATE INDEX evidence_edges_parent_idx ON evidence_edges(parent_id,version_id);
CREATE TABLE evidence_closure(
  version_id UUID NOT NULL REFERENCES evidence_versions(id),
  root_id UUID NOT NULL REFERENCES evidence_roots(id),
  generation BIGINT NOT NULL CHECK(generation>0),
  PRIMARY KEY(version_id,root_id)
);
CREATE INDEX evidence_closure_root_idx ON evidence_closure(root_id,generation,version_id);
CREATE TABLE evidence_state(
  version_id UUID PRIMARY KEY REFERENCES evidence_versions(id),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','quarantined','erased'))
);
-- Each committed generation remains independently discoverable. An allocated
-- sequence/high-water mark is never used as evidence of commit order.
CREATE TABLE evidence_dirty_roots(
  root_id UUID NOT NULL REFERENCES evidence_roots(id),
  generation BIGINT NOT NULL,
  erase BOOLEAN NOT NULL DEFAULT FALSE,
  cursor UUID,
  owner UUID,
  claim_generation BIGINT NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(root_id,generation)
);
CREATE INDEX evidence_dirty_pending_idx ON evidence_dirty_roots(root_id,generation) WHERE NOT complete;
CREATE TABLE evidence_repair_jobs(
  version_id UUID PRIMARY KEY REFERENCES evidence_versions(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','completed','unavailable','cancelled')),
  owner UUID,
  generation BIGINT NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  -- Original accounting identities survive requeue. No expiry-based refunds.
  workflow_id UUID,
  attempt_id UUID,
  attempt_owner UUID,
  attempt_generation BIGINT,
  result_version UUID REFERENCES evidence_versions(id),
  CHECK((workflow_id IS NULL AND attempt_id IS NULL AND attempt_owner IS NULL AND attempt_generation IS NULL)
    OR (workflow_id IS NOT NULL AND attempt_id IS NOT NULL AND attempt_owner IS NOT NULL AND attempt_generation>0))
);
CREATE INDEX evidence_repair_pending_idx ON evidence_repair_jobs(version_id) WHERE state IN ('pending','claimed');
REVOKE ALL ON evidence_roots,evidence_versions,evidence_payloads,evidence_edges,evidence_closure,evidence_state,evidence_dirty_roots,evidence_repair_jobs FROM PUBLIC;

CREATE FUNCTION continuum_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE check_violation USING MESSAGE='evidence provenance is immutable'; END;
$$;
CREATE TRIGGER evidence_version_immutable BEFORE UPDATE OR DELETE ON evidence_versions FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
CREATE TRIGGER evidence_edge_immutable BEFORE UPDATE OR DELETE ON evidence_edges FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();
-- Payload deletion is the canonical erasure operation. It also deletes hashes.
CREATE TRIGGER evidence_payload_immutable BEFORE UPDATE ON evidence_payloads FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();

CREATE FUNCTION continuum_evidence_canonical(memory memories) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('scopeId',memory.scope_id,'title',memory.title,'body',memory.body,'type',memory.type,
    'tags',memory.tags,'source',memory.source,'sourceRef',memory.source_ref,'metadata',memory.metadata-'related')::text;
$$;
CREATE FUNCTION continuum_evidence_can_access(actor UUID,scope UUID,writing BOOLEAN) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM principals WHERE id=actor AND disabled_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM principal_user_scopes mapping JOIN principals owner ON owner.id=mapping.principal_id
      WHERE mapping.scope_id=scope AND owner.disabled_at IS NOT NULL)
    AND ((NOT writing AND EXISTS(SELECT 1 FROM scopes WHERE id=scope AND kind='org'))
      OR EXISTS(SELECT 1 FROM scope_memberships m WHERE m.principal_id=actor AND m.scope_id=scope AND m.active
        AND (NOT writing OR m.role IN ('writer','admin'))
        AND (m.source_kind<>'entra' OR EXISTS(SELECT 1 FROM entra_sync_state WHERE singleton
          AND clock_timestamp()<last_success_at+max_staleness))));
$$;
CREATE FUNCTION continuum_evidence_snapshot(memory memories) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE root evidence_roots%ROWTYPE; version UUID:=gen_random_uuid(); canonical TEXT;
BEGIN
  SELECT * INTO STRICT root FROM evidence_roots WHERE id=memory.id FOR UPDATE;
  IF root.revoked OR memory.state<>'live' OR (root.expiry_ceiling IS NOT NULL AND root.expiry_ceiling<=clock_timestamp()) THEN
    RETURN NULL;
  END IF;
  canonical:=continuum_evidence_canonical(memory);
  IF octet_length(canonical)>1048576 THEN RAISE check_violation USING MESSAGE='evidence payload bounds exceeded'; END IF;
  INSERT INTO evidence_versions(id,root_id,scope_id,kind,previous_version,provenance,expires_at,depth,root_count,parent_count)
    VALUES(version,root.id,memory.scope_id,'source-document-version',root.current_version,'{}',root.expiry_ceiling,0,1,0);
  INSERT INTO evidence_payloads VALUES(version,canonical,encode(sha256(convert_to(canonical,'UTF8')),'hex'));
  INSERT INTO evidence_state(version_id) VALUES(version);
  INSERT INTO evidence_closure VALUES(version,root.id,root.generation);
  UPDATE evidence_roots SET current_version=version WHERE id=root.id;
  RETURN version;
END;
$$;
CREATE FUNCTION continuum_evidence_source(actor UUID,memory_id UUID) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE memory memories%ROWTYPE; root evidence_roots%ROWTYPE; version UUID;
BEGIN
  SELECT * INTO memory FROM memories WHERE id=memory_id FOR UPDATE;
  IF memory.id IS NULL OR memory.state<>'live' OR NOT continuum_evidence_can_access(actor,memory.scope_id,FALSE)
    OR (memory.expires_at IS NOT NULL AND memory.expires_at<=clock_timestamp()) THEN
    RAISE check_violation USING MESSAGE='evidence unavailable';
  END IF;
  INSERT INTO evidence_roots(id,source_memory_id,scope_id,expiry_ceiling) VALUES(memory.id,memory.id,memory.scope_id,memory.expires_at) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT root FROM evidence_roots WHERE id=memory.id FOR UPDATE;
  IF root.source_memory_id IS DISTINCT FROM memory.id OR root.revoked THEN RAISE check_violation USING MESSAGE='evidence unavailable'; END IF;
  version:=root.current_version;
  IF version IS NULL THEN version:=continuum_evidence_snapshot(memory); END IF;
  IF version IS NULL THEN RAISE check_violation USING MESSAGE='evidence unavailable'; END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',memory.scope_id,jsonb_build_object('operation','evidence_source_registered'));
  RETURN version;
END;
$$;
CREATE FUNCTION continuum_evidence_source_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE root evidence_roots%ROWTYPE; erased BOOLEAN;
BEGIN
  SELECT * INTO root FROM evidence_roots WHERE source_memory_id=OLD.id FOR UPDATE;
  IF root.id IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='UPDATE' AND continuum_evidence_canonical(OLD)=continuum_evidence_canonical(NEW)
    AND (OLD.state,OLD.expires_at,OLD.promoted_to_id,OLD.supersedes_id) IS NOT DISTINCT FROM
        (NEW.state,NEW.expires_at,NEW.promoted_to_id,NEW.supersedes_id) THEN RETURN NEW; END IF;
  erased:=TG_OP='DELETE';
  IF TG_OP='UPDATE' THEN erased:=NEW.state='archived' AND NEW.title='[erased]' AND NEW.body='[erased]'; END IF;
  UPDATE evidence_roots SET generation=generation+1,revoked=revoked OR erased,
    expiry_ceiling=CASE WHEN TG_OP='DELETE' THEN expiry_ceiling ELSE least(expiry_ceiling,NEW.expires_at) END,
    scope_id=CASE WHEN TG_OP='DELETE' THEN scope_id ELSE NEW.scope_id END
    WHERE id=root.id RETURNING * INTO root;
  INSERT INTO evidence_dirty_roots(root_id,generation,erase) VALUES(root.id,root.generation,erased);
  IF TG_OP='UPDATE' AND NOT root.revoked AND NEW.state='live' THEN
    PERFORM continuum_evidence_snapshot(NEW);
  END IF;
  -- Trusted older/direct writers cannot omit the committed fence and guard audit.
  INSERT INTO audit_log(principal_id,action,scope_id,metadata)
    VALUES('00000000-0000-4000-8000-000000000011','archive',OLD.scope_id,jsonb_build_object('operation','evidence_source_fenced'));
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER evidence_source_fence AFTER UPDATE OR DELETE ON memories FOR EACH ROW EXECUTE FUNCTION continuum_evidence_source_fence();

CREATE FUNCTION continuum_evidence_eligible(actor UUID,version UUID,locality TEXT) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE v evidence_versions%ROWTYPE; at TIMESTAMPTZ:=clock_timestamp();
BEGIN
  SELECT * INTO v FROM evidence_versions WHERE id=version;
  IF v.id IS NULL OR (v.expires_at IS NOT NULL AND v.expires_at<=at)
    OR NOT continuum_evidence_can_access(actor,v.scope_id,FALSE)
    OR NOT EXISTS(SELECT 1 FROM evidence_state WHERE version_id=version AND state='active')
    OR NOT EXISTS(SELECT 1 FROM evidence_payloads WHERE version_id=version)
    OR (SELECT count(*) FROM evidence_closure WHERE version_id=version)<>v.root_count
    OR (SELECT count(*) FROM evidence_edges WHERE version_id=version)<>v.parent_count
    OR NOT EXISTS(SELECT 1 FROM evidence_closure WHERE version_id=version AND root_id=v.root_id)
    OR (locality IS NOT NULL AND locality NOT IN ('local','hosted')) THEN RETURN FALSE; END IF;
  IF EXISTS(SELECT 1 FROM evidence_closure c JOIN evidence_roots r ON r.id=c.root_id
    LEFT JOIN memories m ON m.id=r.source_memory_id
    WHERE c.version_id=version AND (r.generation<>c.generation OR r.revoked
      OR (r.expiry_ceiling IS NOT NULL AND r.expiry_ceiling<=at)
      OR NOT continuum_evidence_can_access(actor,r.scope_id,FALSE)
      OR (r.source_memory_id IS NOT NULL AND (m.id IS NULL OR m.state<>'live' OR (m.expires_at IS NOT NULL AND m.expires_at<=at)))
      OR (locality='hosted' AND r.residency='local-only')
      OR r.external_state IN ('deny','unknown')
      OR (r.external_state='allow' AND NOT(r.checked_at<=at AND at<r.valid_until)))) THEN RETURN FALSE; END IF;
  RETURN TRUE;
END;
$$;
-- Stable locking order mirrors the source writer: source rows before roots.
-- Authority rows are locked too, but time is always sampled after those locks.
CREATE FUNCTION continuum_evidence_lock(actor UUID,versions UUID[]) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF cardinality(versions) NOT BETWEEN 1 AND 64 THEN RAISE check_violation USING MESSAGE='evidence admission bounds exceeded'; END IF;
  PERFORM m.id FROM memories m WHERE m.id IN (SELECT r.source_memory_id FROM evidence_roots r JOIN evidence_closure c ON c.root_id=r.id
    WHERE c.version_id=ANY(versions)) ORDER BY m.id FOR SHARE;
  PERFORM r.id FROM evidence_roots r WHERE r.id IN (SELECT root_id FROM evidence_closure WHERE version_id=ANY(versions)) ORDER BY r.id FOR SHARE;
  PERFORM id FROM principals WHERE id=actor FOR SHARE;
  PERFORM principal_id FROM scope_memberships WHERE principal_id=actor ORDER BY scope_id,source_kind,source_id FOR SHARE;
  PERFORM singleton FROM entra_sync_state WHERE singleton FOR SHARE;
END;
$$;
CREATE FUNCTION continuum_evidence_register(actor UUID,node UUID,expected UUID,target_scope UUID,artifact_kind TEXT,parents JSONB,identity JSONB,content TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE root evidence_roots%ROWTYPE; version UUID:=gen_random_uuid(); parent_ids UUID[]; roots UUID[]; edge RECORD;
  depth_value INTEGER; ceiling TIMESTAMPTZ; parent_total INTEGER; policy_snapshots JSONB;
BEGIN
  IF artifact_kind IS NULL OR artifact_kind NOT IN ('extracted-assertion','derived-observation','brief-section-version','history','cache','trace','managed-export','queued-payload')
    OR jsonb_typeof(parents) IS DISTINCT FROM 'array' OR jsonb_array_length(parents) NOT BETWEEN 1 AND 64
    OR content IS NULL OR octet_length(content)>1048576 OR node IS NULL
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object' OR NOT(identity ?& ARRAY['transform','model','prompt','schema'])
    OR EXISTS(SELECT 1 FROM jsonb_each(identity) WHERE key NOT IN ('transform','model','prompt','schema') OR jsonb_typeof(value)<>'string'
      OR (value#>>'{}')!~'^[a-zA-Z0-9_.:/-]{1,128}$') THEN
    RAISE check_violation USING MESSAGE='evidence admission bounds or kind invalid'; END IF;
  SELECT array_agg((p->>'versionId')::uuid ORDER BY p->>'versionId'),count(*) INTO parent_ids,parent_total FROM jsonb_array_elements(parents) p;
  IF (SELECT count(DISTINCT p) FROM unnest(parent_ids) p)<>parent_total THEN RAISE check_violation USING MESSAGE='duplicate evidence parent'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(parents) p WHERE (p->>'kind') IS NULL OR (p->>'kind') NOT IN ('source','assertion','derivation','copy')
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('versionId','kind'))) THEN RAISE check_violation USING MESSAGE='invalid evidence edge'; END IF;
  -- A prospective current node in its parent closure is an explicit cycle.
  IF EXISTS(SELECT 1 FROM evidence_closure WHERE version_id=ANY(parent_ids) AND root_id=node) THEN RAISE check_violation USING MESSAGE='evidence cycle'; END IF;
  SELECT array_agg(DISTINCT root_id ORDER BY root_id) INTO roots FROM evidence_closure WHERE version_id=ANY(parent_ids);
  IF roots IS NULL OR cardinality(roots)>=256 THEN RAISE check_violation USING MESSAGE='evidence admission bounds exceeded'; END IF;
  PERFORM continuum_evidence_lock(actor,parent_ids);
  IF NOT continuum_evidence_can_access(actor,target_scope,TRUE) THEN RAISE insufficient_privilege USING MESSAGE='evidence unavailable'; END IF;
  FOREACH version IN ARRAY parent_ids LOOP
    IF NOT continuum_evidence_eligible(actor,version,NULL) THEN RAISE check_violation USING MESSAGE='evidence unavailable'; END IF;
  END LOOP;
  FOR edge IN SELECT (p->>'versionId')::uuid id,p->>'kind' kind FROM jsonb_array_elements(parents) p LOOP
    IF edge.kind='source' AND NOT EXISTS(SELECT 1 FROM evidence_versions WHERE id=edge.id AND kind='source-document-version')
      OR edge.kind='assertion' AND NOT EXISTS(SELECT 1 FROM evidence_versions WHERE id=edge.id AND kind='extracted-assertion') THEN
      RAISE check_violation USING MESSAGE='invalid evidence edge'; END IF;
  END LOOP;
  SELECT max(depth)+1,min(expires_at) INTO depth_value,ceiling FROM evidence_versions WHERE id=ANY(parent_ids);
  IF depth_value>16 THEN RAISE check_violation USING MESSAGE='evidence admission bounds exceeded'; END IF;
  INSERT INTO evidence_roots(id,scope_id,expiry_ceiling) VALUES(node,target_scope,ceiling) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT root FROM evidence_roots WHERE id=node FOR UPDATE;
  IF root.current_version IS DISTINCT FROM expected OR root.source_memory_id IS NOT NULL OR root.revoked OR root.scope_id<>target_scope
    OR (expected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM evidence_versions WHERE id=expected AND kind=artifact_kind)) THEN
    RAISE check_violation USING MESSAGE='evidence current pointer conflict'; END IF;
  -- The node's original ceiling remains a bound across repair.
  ceiling:=least(ceiling,root.expiry_ceiling);
  UPDATE evidence_roots SET generation=generation+1,expiry_ceiling=ceiling WHERE id=node RETURNING * INTO root;
  INSERT INTO evidence_dirty_roots(root_id,generation) VALUES(node,root.generation);
  version:=gen_random_uuid();
  SELECT jsonb_agg(jsonb_build_object('root',r.id,'generation',r.generation,'residency',r.residency,'external',r.external_state,
    'checkedAt',r.checked_at,'validUntil',r.valid_until) ORDER BY r.id) INTO policy_snapshots FROM evidence_roots r WHERE id=ANY(roots);
  INSERT INTO evidence_versions(id,root_id,scope_id,kind,previous_version,provenance,expires_at,depth,root_count,parent_count)
    VALUES(version,node,target_scope,artifact_kind,expected,jsonb_build_object('identity',identity,'policies',policy_snapshots),ceiling,depth_value,cardinality(roots)+1,parent_total);
  INSERT INTO evidence_edges SELECT version,(p->>'versionId')::uuid,p->>'kind' FROM jsonb_array_elements(parents) p;
  INSERT INTO evidence_closure SELECT version,r.id,r.generation FROM evidence_roots r WHERE id=ANY(roots) OR id=node;
  INSERT INTO evidence_state(version_id) VALUES(version);
  INSERT INTO evidence_payloads VALUES(version,content,encode(sha256(convert_to(content,'UTF8')),'hex'));
  UPDATE evidence_roots SET current_version=version WHERE id=node;
  -- Recheck database time and all current authority immediately before commit.
  IF NOT continuum_evidence_eligible(actor,version,NULL) THEN RAISE check_violation USING MESSAGE='evidence unavailable'; END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'write',target_scope,jsonb_build_object('operation','evidence_registered','artifact_kind',artifact_kind));
  RETURN version;
END;
$$;

CREATE FUNCTION continuum_evidence_envelope(actor UUID,version UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v evidence_versions%ROWTYPE; policies JSONB; at TIMESTAMPTZ;
BEGIN
  PERFORM continuum_evidence_lock(actor,ARRAY[version]);
  IF NOT continuum_evidence_eligible(actor,version,NULL) THEN RETURN NULL; END IF;
  SELECT * INTO STRICT v FROM evidence_versions WHERE id=version;
  at:=clock_timestamp();
  SELECT jsonb_agg(jsonb_build_object('version',c.generation::text,'currentVersion',r.generation::text,'scopeIds',jsonb_build_array(r.scope_id),
    'state','active','expiresAt',extract(epoch FROM r.expiry_ceiling)*1000,'residency',r.residency,
    'connector',CASE WHEN r.external_state='not-required' THEN '"not-required"'::jsonb ELSE jsonb_build_object('decision',r.external_state,
      'checkedAt',extract(epoch FROM r.checked_at)*1000,'validUntil',extract(epoch FROM r.valid_until)*1000) END,'repository','not-required') ORDER BY r.id)
    INTO policies FROM evidence_closure c JOIN evidence_roots r ON r.id=c.root_id WHERE c.version_id=version;
  RETURN jsonb_build_object('now',extract(epoch FROM at)*1000,'kind',v.kind,'scopeId',v.scope_id,
    'expiresAt',extract(epoch FROM v.expires_at)*1000,'policies',policies,'bytes',(SELECT octet_length(payload) FROM evidence_payloads WHERE version_id=version));
END;
$$;
CREATE FUNCTION continuum_evidence_payload(actor UUID,version UUID,locality TEXT) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result TEXT; scope UUID;
BEGIN
  PERFORM continuum_evidence_lock(actor,ARRAY[version]);
  IF NOT continuum_evidence_eligible(actor,version,locality) THEN RETURN NULL; END IF;
  SELECT payload INTO result FROM evidence_payloads WHERE version_id=version;
  SELECT scope_id INTO scope FROM evidence_versions WHERE id=version;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'read',scope,
    jsonb_build_object('operation',CASE WHEN locality IS NULL THEN 'evidence_read' ELSE 'evidence_dispatch' END));
  IF NOT continuum_evidence_eligible(actor,version,locality) THEN RETURN NULL; END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION continuum_operator_evidence_policy(actor UUID,root_id UUID,residency TEXT,external_state TEXT,checked_at TIMESTAMPTZ,valid_until TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE root evidence_roots%ROWTYPE;
BEGIN
  PERFORM continuum_require_standup_operator(actor);
  PERFORM m.id FROM memories m JOIN evidence_roots r ON r.source_memory_id=m.id WHERE r.id=root_id FOR UPDATE OF m;
  UPDATE evidence_roots r SET generation=r.generation+1,residency=$3,external_state=$4,checked_at=$5,valid_until=$6 WHERE r.id=$2 RETURNING * INTO STRICT root;
  INSERT INTO evidence_dirty_roots(root_id,generation) VALUES(root.id,root.generation);
  -- A policy change cannot renew an old immutable snapshot. A new source
  -- version can be admitted under current authority, retaining the old ceiling.
  IF root.source_memory_id IS NOT NULL AND NOT root.revoked THEN
    PERFORM continuum_evidence_snapshot(m) FROM memories m WHERE id=root.source_memory_id;
  END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor,'archive',root.scope_id,jsonb_build_object('operation','evidence_policy_fenced'));
END;
$$;

CREATE FUNCTION continuum_evidence_is_ready() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='memories'::regclass AND tgname='evidence_source_fence' AND tgenabled='O')
    AND to_regprocedure('continuum_evidence_register(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text)') IS NOT NULL
    AND to_regclass('evidence_dirty_roots') IS NOT NULL AND to_regclass('evidence_repair_jobs') IS NOT NULL;
$$;

DO $$
DECLARE schema_name TEXT:=current_schema(); f RECORD; signature TEXT; definition TEXT; revised TEXT; candidate RECORD;
  app_signatures TEXT[]:=ARRAY['continuum_evidence_source(uuid,uuid)','continuum_evidence_register(uuid,uuid,uuid,uuid,text,jsonb,jsonb,text)',
    'continuum_evidence_envelope(uuid,uuid)','continuum_evidence_payload(uuid,uuid,text)','continuum_evidence_eligible(uuid,uuid,text)','continuum_evidence_is_ready()'];
  op_signatures TEXT[]:=ARRAY['continuum_operator_evidence_policy(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone)'];
BEGIN
  FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=quote_ident(schema_name)::regnamespace
    AND (proname LIKE 'continuum_evidence_%' OR proname LIKE 'continuum_operator_evidence_%') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',f.signature,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['continuum_assert_application_role_allowlist(name,boolean)','continuum_assert_standup_application_role_allowlist(name,boolean)'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'(''continuum_standup_is_ready()'')','(''continuum_standup_is_ready()''),('''||array_to_string(app_signatures,'''),(''')||''')');
    revised:=replace(revised,'(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'')',
      '(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)''),('''||array_to_string(op_signatures,'''),(''')||''')');
    IF revised=definition THEN RAISE EXCEPTION 'unable to extend evidence allowlist'; END IF;
    EXECUTE revised;
  END LOOP;
  FOR candidate IN SELECT * FROM continuum_evidence_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    FOREACH signature IN ARRAY app_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name); END LOOP;
    IF candidate.operator THEN
      FOREACH signature IN ARRAY op_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name); END LOOP;
    END IF;
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END;
$$;

