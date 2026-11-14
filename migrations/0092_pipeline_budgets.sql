SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Snapshot only already-valid profiles. Invalid roles require explicit regrant.
CREATE TEMP TABLE continuum_pipeline_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $$
DECLARE candidate RECORD;
BEGIN
  FOR candidate IN SELECT p.database_role_oid,r.rolname,p.profile_kind
    FROM continuum_pgvector_role_profiles p JOIN pg_catalog.pg_roles r ON r.oid=p.database_role_oid
    WHERE p.profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_pipeline_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Continuum skipped pipeline grants for role OID % (SQLSTATE %); explicit regrant and startup validation required',candidate.database_role_oid,SQLSTATE;
    END;
  END LOOP;
END;
$$;

CREATE FUNCTION continuum_pipeline_valid_amounts(value JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE entry RECORD; keys TEXT[]:=ARRAY['candidates','hydratedBytes','inputBytes','contextTokens','outputBytes','outputTokens',
  'reasoningTokens','completionTokens','calls','retries','artifactBytes','storageBytes','spendMicros'];
BEGIN
  IF value IS NULL OR jsonb_typeof(value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>13 THEN RETURN FALSE; END IF;
  FOR entry IN SELECT * FROM jsonb_each(value) LOOP
    IF NOT entry.key=ANY(keys) OR jsonb_typeof(entry.value)<>'number' OR entry.value::text !~ '^(0|[1-9][0-9]*)$'
      OR (entry.value::text)::numeric>9007199254740991 THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;
CREATE FUNCTION continuum_pipeline_valid_profile(value JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key TEXT; bound NUMERIC;
BEGIN
  IF value IS NULL OR jsonb_typeof(value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>10
    OR jsonb_typeof(value->'version') IS DISTINCT FROM 'number'
    OR jsonb_typeof(value->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'currency') IS DISTINCT FROM 'string'
    OR jsonb_typeof(value->'rateSchedule') IS DISTINCT FROM 'string'
    OR value->>'version' IS DISTINCT FROM '1' OR COALESCE(value->>'id','') !~ '^[a-z][a-z0-9.-]{0,63}$'
    OR COALESCE(value->>'currency','') !~ '^[A-Z]{3}$' OR COALESCE(value->>'rateSchedule','') !~ '^[a-z][a-z0-9.-]{0,63}$'
    OR NOT continuum_pipeline_valid_amounts(value->'limits') THEN RETURN FALSE; END IF;
  FOREACH key IN ARRAY ARRAY['maxItemHydratedBytes','maxConcurrency','maxRetainedBytes','overallMs','stageMs'] LOOP
    IF jsonb_typeof(value->key) IS DISTINCT FROM 'number' OR (value->>key) !~ '^[1-9][0-9]*$' THEN RETURN FALSE; END IF;
    bound:=(value->>key)::numeric;
    IF bound>9007199254740991 THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN (value->>'maxItemHydratedBytes')::numeric<=(value->'limits'->>'hydratedBytes')::numeric
    AND (value->>'stageMs')::numeric<=(value->>'overallMs')::numeric
    AND (value->>'overallMs')::numeric<=86400000 AND (value->>'stageMs')::numeric<=300000
    AND (value->>'maxConcurrency')::numeric<=1024 AND (value->'limits'->>'calls')::numeric<=1024
    AND (value->'limits'->>'candidates')::numeric<=10000 AND (value->'limits'->>'outputBytes')::numeric>=512
    AND (value->'limits'->>'outputTokens')::numeric+(value->'limits'->>'reasoningTokens')::numeric<=(value->'limits'->>'completionTokens')::numeric;
END;
$$;

-- Policy/accounting only. No subjects, source identifiers, payloads, credentials,
-- arbitrary receipt text or content-bearing jobs are stored in these tables.
CREATE TABLE pipeline_budget_workflows(
  id UUID PRIMARY KEY,
  owner UUID NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991),
  profile JSONB NOT NULL CHECK(continuum_pipeline_valid_profile(profile)),
  used JSONB NOT NULL CHECK(continuum_pipeline_valid_amounts(used)),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active BETWEEN 0 AND 1024),
  retained_bytes BIGINT NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deadline_at TIMESTAMPTZ NOT NULL CHECK(isfinite(deadline_at)),
  cancelled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE pipeline_budget_attempts(
  workflow_id UUID NOT NULL REFERENCES pipeline_budget_workflows(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL,
  owner UUID NOT NULL,
  generation BIGINT NOT NULL,
  reserved JSONB NOT NULL CHECK(continuum_pipeline_valid_amounts(reserved)),
  retained_bytes BIGINT NOT NULL CHECK(retained_bytes BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatched','settled')),
  settlement JSONB,
  PRIMARY KEY(workflow_id,attempt_id)
);
REVOKE ALL ON pipeline_budget_workflows,pipeline_budget_attempts FROM PUBLIC;

CREATE FUNCTION continuum_pipeline_create(workflow UUID,worker UUID,policy JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE current_state pipeline_budget_workflows%ROWTYPE; initial JSONB;
BEGIN
  IF NOT continuum_pipeline_valid_profile(policy) OR worker IS NULL OR workflow IS NULL THEN RAISE EXCEPTION 'invalid pipeline profile'; END IF;
  SELECT jsonb_object_agg(key,CASE WHEN key='outputBytes' THEN least(4096,(policy->'limits'->>'outputBytes')::bigint) ELSE 0 END)
    INTO initial FROM jsonb_object_keys(policy->'limits') key;
  INSERT INTO pipeline_budget_workflows(id,owner,profile,used,deadline_at)
    VALUES(workflow,worker,policy,initial,clock_timestamp()+((policy->>'overallMs')::bigint * interval '1 millisecond')) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT current_state FROM pipeline_budget_workflows WHERE id=workflow FOR UPDATE;
  IF current_state.profile<>policy OR current_state.owner<>worker THEN RAISE EXCEPTION 'conflicting pipeline workflow'; END IF;
  RETURN to_jsonb(current_state);
END;
$$;
CREATE FUNCTION continuum_pipeline_read(workflow UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT to_jsonb(w) FROM pipeline_budget_workflows w WHERE id=workflow $$;

CREATE FUNCTION continuum_pipeline_reserve(workflow UUID,attempt UUID,worker UUID,epoch BIGINT,requested JSONB,retained BIGINT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE w pipeline_budget_workflows%ROWTYPE; entry RECORD; next_used JSONB;
BEGIN
  IF NOT continuum_pipeline_valid_amounts(requested) OR requested->>'calls'<>'1' OR retained IS NULL OR retained<0 OR retained>9007199254740991
    OR attempt IS NULL OR worker IS NULL OR epoch IS NULL THEN RAISE EXCEPTION 'invalid pipeline reservation'; END IF;
  IF (requested->>'inputBytes')::bigint+(requested->>'outputBytes')::bigint>retained THEN RAISE EXCEPTION 'invalid retained pipeline bytes'; END IF;
  SELECT * INTO STRICT w FROM pipeline_budget_workflows WHERE id=workflow FOR UPDATE;
  IF w.owner<>worker OR w.generation<>epoch OR w.cancelled OR w.deadline_at<=clock_timestamp()
    OR w.active>=(w.profile->>'maxConcurrency')::integer OR retained>(w.profile->>'maxRetainedBytes')::bigint-w.retained_bytes
    OR EXISTS(SELECT 1 FROM pipeline_budget_attempts WHERE workflow_id=workflow AND attempt_id=attempt) THEN RETURN FALSE; END IF;
  next_used:=w.used;
  FOR entry IN SELECT * FROM jsonb_each_text(requested) LOOP
    IF entry.value::bigint>(w.profile->'limits'->>entry.key)::bigint-(w.used->>entry.key)::bigint THEN RETURN FALSE; END IF;
    next_used:=jsonb_set(next_used,ARRAY[entry.key],to_jsonb((w.used->>entry.key)::bigint+entry.value::bigint));
  END LOOP;
  INSERT INTO pipeline_budget_attempts(workflow_id,attempt_id,owner,generation,reserved,retained_bytes)
    VALUES(workflow,attempt,worker,epoch,requested,retained);
  UPDATE pipeline_budget_workflows SET used=next_used,active=active+1,retained_bytes=retained_bytes+retained WHERE id=workflow;
  RETURN TRUE;
END;
$$;
CREATE FUNCTION continuum_pipeline_dispatch(workflow UUID,attempt UUID,worker UUID,epoch BIGINT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE w pipeline_budget_workflows%ROWTYPE;
BEGIN
  SELECT * INTO STRICT w FROM pipeline_budget_workflows WHERE id=workflow FOR UPDATE;
  IF worker IS NULL OR epoch IS NULL OR w.owner<>worker OR w.generation<>epoch OR w.cancelled OR w.deadline_at<=clock_timestamp() THEN RETURN FALSE; END IF;
  UPDATE pipeline_budget_attempts SET state='dispatched' WHERE workflow_id=workflow AND attempt_id=attempt
    AND owner=worker AND generation=epoch AND state='reserved';
  RETURN FOUND;
END;
$$;
CREATE FUNCTION continuum_pipeline_settle(workflow UUID,attempt UUID,worker UUID,epoch BIGINT,actual JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE w pipeline_budget_workflows%ROWTYPE; a pipeline_budget_attempts%ROWTYPE; entry RECORD; next_used JSONB; publish BOOLEAN;
BEGIN
  IF actual IS NULL OR jsonb_typeof(actual)<>'object' THEN RAISE EXCEPTION 'invalid pipeline settlement'; END IF;
  SELECT * INTO STRICT w FROM pipeline_budget_workflows WHERE id=workflow FOR UPDATE;
  SELECT * INTO STRICT a FROM pipeline_budget_attempts WHERE workflow_id=workflow AND attempt_id=attempt FOR UPDATE;
  IF worker IS NULL OR epoch IS NULL OR a.owner<>worker OR a.generation<>epoch THEN RAISE EXCEPTION 'pipeline attempt owner mismatch'; END IF;
  IF a.state='settled' THEN
    IF a.settlement<>actual THEN RAISE EXCEPTION 'conflicting pipeline settlement'; END IF;
    RETURN FALSE;
  END IF;
  next_used:=w.used;
  FOR entry IN SELECT * FROM jsonb_each(actual) LOOP
    IF entry.key='provenance' THEN
      IF jsonb_typeof(entry.value)<>'string' OR NOT actual->>'provenance'=ANY(ARRAY['measured','provider-reported','estimated','unknown']) THEN
        RAISE EXCEPTION 'invalid pipeline usage provenance'; END IF;
      CONTINUE;
    END IF;
    IF NOT entry.key=ANY(ARRAY['spendMicros','outputBytes','outputTokens','reasoningTokens','completionTokens'])
      OR jsonb_typeof(entry.value)<>'number' OR entry.value::text !~ '^(0|[1-9][0-9]*)$'
      OR entry.value::text::numeric>(a.reserved->>entry.key)::numeric THEN RAISE EXCEPTION 'invalid pipeline settlement'; END IF;
    next_used:=jsonb_set(next_used,ARRAY[entry.key],to_jsonb((w.used->>entry.key)::bigint-(a.reserved->>entry.key)::bigint+entry.value::text::bigint));
  END LOOP;
  publish:=a.state='dispatched' AND NOT w.cancelled AND w.owner=worker AND w.generation=epoch AND w.deadline_at>clock_timestamp();
  UPDATE pipeline_budget_attempts SET state='settled',settlement=actual WHERE workflow_id=workflow AND attempt_id=attempt;
  UPDATE pipeline_budget_workflows SET used=next_used,active=active-1,retained_bytes=retained_bytes-a.retained_bytes WHERE id=workflow;
  RETURN publish;
END;
$$;
CREATE FUNCTION continuum_pipeline_fence(workflow UUID,worker UUID,epoch BIGINT,replacement UUID,cancel BOOLEAN) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE w pipeline_budget_workflows%ROWTYPE;
BEGIN
  SELECT * INTO STRICT w FROM pipeline_budget_workflows WHERE id=workflow FOR UPDATE;
  IF worker IS NULL OR epoch IS NULL OR replacement IS NULL OR cancel IS NULL OR w.owner<>worker OR w.generation<>epoch THEN RAISE EXCEPTION 'stale pipeline owner'; END IF;
  UPDATE pipeline_budget_workflows SET owner=replacement,generation=generation+1,cancelled=cancelled OR cancel WHERE id=workflow RETURNING * INTO w;
  -- Never change deadline, limits, accounting or unsettled attempts on requeue.
  RETURN to_jsonb(w);
END;
$$;
CREATE FUNCTION continuum_pipeline_budgets_is_ready() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT to_regclass('pipeline_budget_workflows') IS NOT NULL AND to_regclass('pipeline_budget_attempts') IS NOT NULL
    AND to_regprocedure('continuum_pipeline_reserve(uuid,uuid,uuid,bigint,jsonb,bigint)') IS NOT NULL
    AND to_regprocedure('continuum_pipeline_settle(uuid,uuid,uuid,bigint,jsonb)') IS NOT NULL;
$$;

DO $$
DECLARE schema_name TEXT:=current_schema(); function_record RECORD; definition TEXT; revised TEXT; signature TEXT; candidate RECORD;
  signatures TEXT[]:=ARRAY['continuum_pipeline_create(uuid,uuid,jsonb)','continuum_pipeline_read(uuid)',
    'continuum_pipeline_reserve(uuid,uuid,uuid,bigint,jsonb,bigint)','continuum_pipeline_dispatch(uuid,uuid,uuid,bigint)',
    'continuum_pipeline_settle(uuid,uuid,uuid,bigint,jsonb)','continuum_pipeline_fence(uuid,uuid,bigint,uuid,boolean)',
    'continuum_pipeline_budgets_is_ready()'];
BEGIN
  FOR function_record IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p
    WHERE p.pronamespace=quote_ident(schema_name)::regnamespace AND p.proname LIKE 'continuum_pipeline_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',function_record.signature,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',function_record.signature);
  END LOOP;
  -- Extend only the existing APP capability list. Preserve unrelated 0091's OP extension.
  FOREACH signature IN ARRAY ARRAY['continuum_assert_application_role_allowlist(name,boolean)',
    'continuum_assert_standup_application_role_allowlist(name,boolean)'] LOOP
    definition:=pg_catalog.pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'(''continuum_standup_is_ready()'')',
      '(''continuum_standup_is_ready()''),('''||array_to_string(signatures,'''),(''')||''')');
    IF revised=definition THEN RAISE EXCEPTION 'unable to extend pipeline capability allowlist'; END IF;
    EXECUTE revised;
  END LOOP;
  FOR candidate IN SELECT * FROM continuum_pipeline_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    FOREACH signature IN ARRAY signatures LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name);
    END LOOP;
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END;
$$;
