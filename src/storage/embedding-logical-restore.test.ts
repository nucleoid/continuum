import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { captureMemory } from '../services/capture.js';
import { getMemoryForPrincipal } from '../services/memories.js';
import { SqlEmbeddingJobStore, readEmbeddingStatus } from './embedding-jobs.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';
import { getMemory } from './memories.js';
import { requireEmbeddingQueueReady } from './provider-lifecycle.js';
import { dropIsolatedTestDatabase } from './test-helpers.js';

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
interface OwnedDatabase { name: string; oid: number; owner: number }

it('keeps a logically restored queue ready across changed vector type OIDs while still refusing a disabled required guard', async () => {
  await embeddingQueueFixture(async f => {
    const run = randomUUID().replaceAll('-', ''), database = `continuum_queue_restore_${run}`;
    // Absolute paths on every host, private and ignored; never OS/MSYS /tmp.
    const directory = resolve(process.cwd(), '.fire-off', 'logical-queue-restore', run);
    await mkdir(directory, { recursive: true });
    const record = async (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n');
    const source = new URL(f.connectionString);
    const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: source.hostname.replace(/^\[|\]$/g, ''), PGPORT: source.port || '5432',
      PGUSER: decodeURIComponent(source.username), PGPASSWORD: decodeURIComponent(source.password),
      PGDATABASE: decodeURIComponent(source.pathname.slice(1)), PGCONNECT_TIMEOUT: '5',
      PGOPTIONS: '-c statement_timeout=60000 -c lock_timeout=5000' };
    if (source.searchParams.has('sslmode')) env.PGSSLMODE = source.searchParams.get('sslmode')!;
    let command = 0;
    const cli = async (tool: string, args: string[], targetDatabase = env.PGDATABASE!) => {
      const ordinal = String(++command).padStart(2, '0');
      try {
        const stdout = execFileSync(tool, args, { env: { ...env, PGDATABASE: targetDatabase }, timeout: 30000,
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        await writeFile(join(directory, `${ordinal}-${tool}.log`), stdout);
        return stdout;
      } catch (error) {
        // Tool args contain database names/files/role IDs only; never URLs/passwords.
        const failed = error as { stdout?: string; stderr?: string; status?: number; code?: string; signal?: string };
        await writeFile(join(directory, `${ordinal}-${tool}.log`), `${failed.stdout ?? ''}${failed.stderr ?? ''}`);
        await record(`${ordinal}-${tool}-failed.json`, { tool, prerequisiteOrCommandFailed: true, status: failed.status, code: failed.code, signal: failed.signal });
        throw new Error(`Required cached ${tool} command failed; see private restore fixture evidence`);
      }
    };
    // No skip, install, download or unsupported success branch.
    for (const tool of ['pg_dump', 'pg_restore', 'psql']) expect(await cli(tool, ['--version'])).toMatch(/PostgreSQL\) 16(?:\.| )/);
    const sourceState = (await f.owner.query(`SELECT current_database() AS database,current_schema() AS schema,
      (SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner,current_user=session_user AS direct,
      (SELECT datdba FROM pg_database WHERE datname=current_database()) AS db_owner,
      (SELECT relowner FROM pg_class WHERE oid='memories'::regclass) AS schema_owner,
      (SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname=current_user) AS can_create,
      e.extversion AS version,n.nspname AS provider_schema,n.nspowner AS provider_owner,e.extowner AS extension_owner,t.oid AS vector_oid
      FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
      JOIN pg_type t ON t.typnamespace=n.oid AND t.typname='vector' WHERE e.extname='vector'`)).rows[0];
    expect(sourceState).toBeDefined();
    expect(sourceState).toMatchObject({ direct: true, can_create: true });
    expect(sourceState.db_owner).toBe(sourceState.owner); expect(sourceState.schema_owner).toBe(sourceState.owner);
    expect(sourceState.provider_owner).toBe(sourceState.owner); expect(sourceState.extension_owner).toBe(sourceState.owner);
    // Actual queue fixture/migrator has a separate reviewed provider schema.
    // A different topology needs its reviewed fixture; never silently infer it.
    expect(sourceState.provider_schema).not.toBe(sourceState.schema);
    const schema = sourceState.schema as string;
    const appRole = (await f.app.query('SELECT session_user AS role')).rows[0].role as string;
    const operatorRole = (await f.operator.query('SELECT session_user AS role')).rows[0].role as string;
    await f.app.query('SELECT continuum_assert_current_pgvector_profile()');
    await requireEmbeddingQueueReady(f.app, { expectedSchema: schema });
    const capture = await captureMemory(f.app, f.router, f.principal, { scope: { kind: f.scope.kind, name: f.scope.name },
      type: 'fact', title: 'Logical restore fixture', body: 'SYNTHETIC-RESTORE-SOURCE', source: 'manual' }, {},
    { idempotencyKey: 'logical-restore-capture' });
    expect(capture.embeddingStatus).toBe('queued'); expect(f.adapter.invoke).not.toHaveBeenCalled();
    const sourceLedger = (await f.owner.query(`SELECT jsonb_agg(to_jsonb(m) ORDER BY name) AS migrations FROM _continuum_migrations m`)).rows[0].migrations;
    await record('source.json', { ...sourceState, sourceId: capture.memory.id });
    const dump = join(directory, 'application.dump');
    // Export ONLY this task-owned app schema, not unrelated schemas in default mode.
    // Keep ownership, ACLs, function bodies, provenance, ledgers and runtime rows.
    await cli('pg_dump', ['--format=custom', `--schema=${quote(schema)}`, '--file', dump]);
    const maintenance = new pg.Pool({ connectionString: f.connectionString, max: 1, connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=5000 -c lock_timeout=1000' });
    let owned: OwnedDatabase | undefined, acknowledged = false;
    let restoredWorker: pg.Pool | undefined;
    let restored: pg.Pool | undefined, restoredApp: pg.Pool | undefined;
    const failures: unknown[] = [];
    try {
      expect((await maintenance.query('SELECT oid FROM pg_database WHERE datname=$1', [database])).rows).toEqual([]);
      await maintenance.query(`CREATE DATABASE ${quote(database)} TEMPLATE template0`);
      acknowledged = true;
      await record('create-ack.json', { name: database, acknowledged: true, expectedOwner: sourceState.owner });
      const identity = (await maintenance.query('SELECT oid,datdba AS owner FROM pg_database WHERE datname=$1', [database])).rows[0];
      expect(identity?.owner).toBe(sourceState.owner); expect(identity?.oid).toBeTypeOf('number');
      owned = { name: database, oid: identity.oid, owner: identity.owner };
      await record('owned-database.json', owned); // Persist identity BEFORE use.
      const url = new URL(f.connectionString); url.pathname = `/${database}`;
      restored = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000,
        options: `-c search_path=${schema} -c statement_timeout=60000 -c lock_timeout=5000` });
      expect((await restored.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1", [schema])).rows[0].n).toBe(0);
      expect((await restored.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname='vector'")).rows[0].n).toBe(0);
      // Exact cached extension/version, same owner/schema. No migration rerun,
      // contract-table rewrite or guessed descriptor to make readiness succeed.
      await restored.query(`CREATE SCHEMA ${quote(sourceState.provider_schema)}`);
      await restored.query(`CREATE EXTENSION vector WITH SCHEMA ${quote(sourceState.provider_schema)} VERSION ${literal(sourceState.version)}`);
      await cli('pg_restore', ['--exit-on-error', '--single-transaction', '--dbname', database, dump], database);
      const destination = (await restored.query(`SELECT current_schema() AS schema,
        (SELECT relowner FROM pg_class WHERE oid='memories'::regclass) AS owner,
        t.oid AS vector_oid,e.extversion AS version,n.nspname AS provider_schema
        FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace JOIN pg_type t ON t.typnamespace=n.oid AND t.typname='vector'
        WHERE e.extname='vector'`)).rows[0];
      expect(destination).toMatchObject({ schema, owner: sourceState.owner, version: sourceState.version, provider_schema: sourceState.provider_schema });
      expect(destination.vector_oid, 'the real restore must actually allocate a different pgvector type OID').not.toBe(sourceState.vector_oid);
      expect((await restored.query('SELECT jsonb_agg(to_jsonb(m) ORDER BY name) AS migrations FROM _continuum_migrations m')).rows[0].migrations).toEqual(sourceLedger);
      const drift = (await restored.query(`SELECT name FROM embedding_contract_relations
        WHERE fingerprint IS DISTINCT FROM continuum_embedding_relation_fingerprint(to_regclass(name)) ORDER BY name`)).rows;
      await record('restore-comparison.json', { sourceVectorOid: sourceState.vector_oid, destinationVectorOid: destination.vector_oid, drift });
      expect((await restored.query('SELECT continuum_brief_is_ready() AS ready')).rows[0].ready).toBe(true);
      // This is the intended RED at 9ba raw-atttypid fingerprints, then GREEN
      // after the portable98 repair. Never rewrite expected hashes after restore.
      expect((await restored.query('SELECT continuum_embedding_is_ready() AS ready')).rows[0].ready,
        'logical restore must preserve queue readiness across changed local type OIDs').toBe(true);
      // Existing0080 provider schemaOID profiles intentionally need exact regrant.
      // Use the real checked scripts, without registry edits/privilege broadening.
      for (const role of [appRole, f.producerRole, operatorRole]) await cli('psql', ['-X', '-v', 'ON_ERROR_STOP=1',
        '-v', `continuum_schema=${schema}`, '-v', `continuum_app_role=${role}`, '-f', join(process.cwd(), 'scripts/grant-application-role.sql')], database);
      await cli('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-v', `continuum_schema=${schema}`, '-v', `continuum_operator_role=${operatorRole}`,
        '-v', `continuum_principal_id=${f.adminId}`, '-f', join(process.cwd(), 'scripts/grant-operator-role.sql')], database);
      await cli('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-v', `continuum_schema=${schema}`, '-v', `continuum_embedding_worker_role=${f.workerRole}`,
        '-f', join(process.cwd(), 'scripts/grant-embedding-worker-role.sql')], database);
      const appUrl = new URL(f.app.options.connectionString!); appUrl.pathname = `/${database}`;
      restoredApp = new pg.Pool({ connectionString: appUrl.toString(), max: 1, connectionTimeoutMillis: 5000, options: f.app.options.options });
      await restoredApp.query('SELECT continuum_assert_current_pgvector_profile()');
      await requireEmbeddingQueueReady(restoredApp, { expectedSchema: schema });
      expect((await getMemoryForPrincipal(restoredApp, f.principal, capture.memory.id)).memory.body).toBe('SYNTHETIC-RESTORE-SOURCE');
      expect(await readEmbeddingStatus(restoredApp, f.actorId, capture.memory.id)).toMatchObject({ embeddingStatus: 'queued', embedded: false });
      const client = await restored.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE memory_embeddings DISABLE TRIGGER embedding_vector_guard');
        expect((await client.query('SELECT continuum_embedding_is_ready() AS ready')).rows[0].ready).toBe(false);
      } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
      await requireEmbeddingQueueReady(restoredApp, { expectedSchema: schema });
      expect(f.adapter.invoke).not.toHaveBeenCalled(); expect(f.provider.embed).not.toHaveBeenCalled();
      const workerUrl = new URL(f.worker.options.connectionString!); workerUrl.pathname = `/${database}`;
      restoredWorker = new pg.Pool({ connectionString: workerUrl.toString(), max: 1, connectionTimeoutMillis: 5000, options: f.worker.options.options });
      const runRestoredWorker = () => processEmbeddingJobs(new SqlEmbeddingJobStore(restoredWorker!), f.target,
        f.policy, f.provider, f.profile, randomUUID());
      expect(await runRestoredWorker()).toBe('processed');
      const second = await captureMemory(restoredApp, f.router, f.principal, { scope: { kind: f.scope.kind, name: f.scope.name },
        type: 'fact', title: 'Native optional restore source', body: 'SYNTHETIC-NATIVE-RESTORE', source: 'manual' });
      expect(f.adapter.invoke).toHaveBeenCalledTimes(1); // The new ACK did no provider I/O.
      expect(await runRestoredWorker()).toBe('processed');
      expect(((await getMemory(restoredApp, second.memory.id))!.metadata.related as unknown[]).length).toBeGreaterThan(0);
      await restoredApp.query(`UPDATE memories SET body=body||' Edited current source.',
        metadata=jsonb_set(metadata,ARRAY['restoreNote'],to_jsonb('PRESERVE-CURRENT-NOTE'::text)),updated_at=clock_timestamp() WHERE id=$1`, [second.memory.id]);
      const beforeNativeDecline = (await getMemory(restoredApp, second.memory.id))!;
      // The restored DB has an acknowledged exact identity. Catalog mutation
      // is confined to this database, with no external clients or CASCADE.
      const databaseIdentity = (await restored.query(`SELECT current_database() AS name,oid,datdba AS owner
        FROM pg_database WHERE datname=current_database()`)).rows[0];
      expect(databaseIdentity).toEqual(owned);
      const ownPids = [(await restored.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        (await restoredApp.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        (await restoredWorker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid];
      expect((await restored.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND NOT(pid=ANY($1::int[]))', [ownPids])).rows).toEqual([]);
      const collations = (await restored.query(`SELECT coll.oid,n.nspname,coll.collname,coll.collowner,coll.collversion
        FROM pg_collation coll JOIN pg_namespace n ON n.oid=coll.collnamespace
        WHERE n.nspname='pg_catalog' AND coll.collprovider='i' AND coll.colliculocale='en-US' ORDER BY coll.oid`)).rows;
      expect(collations.length).toBeGreaterThan(0);
      for (const collation of collations) expect(collation.collowner).toBe(owned!.owner);
      await record('owned-native-collations.json', { databaseIdentity, ownPids, collations });
      for (const collation of collations) {
        const identity = (await restored.query('SELECT collname,collowner FROM pg_collation WHERE oid=$1', [collation.oid])).rows[0];
        expect(identity).toEqual({ collname: collation.collname, collowner: owned!.owner });
        await restored.query(`DROP COLLATION ${quote(collation.nspname)}.${quote(collation.collname)} RESTRICT`);
      }
      expect((await restored.query("SELECT oid FROM pg_collation WHERE collprovider='i' AND colliculocale='en-US'")).rows).toEqual([]);
      await requireEmbeddingQueueReady(restoredApp, { expectedSchema: schema });
      expect(await runRestoredWorker()).toBe('processed');
      const afterNativeDecline = (await getMemory(restoredApp, second.memory.id))!;
      expect(afterNativeDecline.metadata).toEqual(beforeNativeDecline.metadata);
      expect(afterNativeDecline.updatedAt).toEqual(beforeNativeDecline.updatedAt);
      expect(await readEmbeddingStatus(restoredApp, f.actorId, second.memory.id)).toMatchObject({ embedded: true, embeddingStatus: 'ready' });
      expect((await restored.query(`SELECT metadata->>'relationsStatus' AS status FROM audit_log WHERE memory_id=$1
        AND metadata->>'operation'='embedding_completed' ORDER BY id DESC LIMIT 1`, [second.memory.id])).rows[0].status).toBe('native_unavailable');
      expect(f.adapter.invoke).toHaveBeenCalledTimes(3); expect(f.provider.embed).not.toHaveBeenCalled();
    } catch (error) { failures.push(error); }
    finally {
      for (const pool of [restoredWorker, restoredApp, restored]) if (pool) try { await pool.end(); } catch (error) { failures.push(error); }
      try {
        if (owned) {
          const current = (await maintenance.query('SELECT oid,datdba AS owner FROM pg_database WHERE datname=$1', [owned.name])).rows[0];
          if (!current || current.oid !== owned.oid || current.owner !== owned.owner) throw new Error('Restore fixture database identity drift; retained for recovery');
          await dropIsolatedTestDatabase(maintenance, owned.name, { cleanupTimeoutMs: 30000 });
          const residual = { databases: (await maintenance.query('SELECT oid FROM pg_database WHERE datname=$1', [owned.name])).rows,
            clients: (await maintenance.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [owned.name])).rows };
          await record('settlement.json', { owned, ...residual });
          expect(residual).toEqual({ databases: [], clients: [] });
        } else if (acknowledged) {
          await record('incomplete-identity.json', { name: database, acknowledged, retainedForRecovery: true });
          throw new Error('Acknowledged restore database identity unavailable; retained, never dropped by name alone');
        }
      } catch (error) { failures.push(error); }
      try { await maintenance.end(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Logical restore regression and owned cleanup failed');
  });
}, 120000);
