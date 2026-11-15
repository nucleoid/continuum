import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { standupProducerFixture, quoteStandupIdentifier } from '../standup/test-helpers.js';
import { syntheticBrief } from '../briefs/test-helpers.js';
import { BriefRegistry, briefDescriptor } from '../briefs/provider.js';
import { createScope } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { briefForPrincipal, refreshBrief } from '../services/briefs.js';
import { processBrief } from './briefs.js';

type Outcome<T> = { value: T; error?: never } | { value?: never; error: { code?: string; message: string } };
async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try { return { value: await promise }; }
  catch (error) { return { error: { code: (error as { code?: string }).code, message: (error as Error).message } }; }
}

it('first enrollment cannot drain a source transaction whose writes predate its epoch rows', async () => {
  await standupProducerFixture(async f => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16), workerRole = `brief_first_${suffix}`, password = randomUUID();
    const project = await createScope(f.owner, { kind: 'project', name: `first-${suffix}` });
    await addMembership(f.owner, f.actorId, project.id, 'admin');
    await addMembership(f.owner, f.producerId, project.id, 'writer');
    const actor = (await getPrincipal(f.app, f.actorId))!;
    const schema = (await f.owner.query('SELECT current_schema() AS name')).rows[0].name as string;
    const registry = new BriefRegistry(); registry.register(syntheticBrief());
    const profile = registry.get('synthetic-brief-v1')!;
    const writerPool = new pg.Pool({ ...f.app.options, max: 1 });
    let workerPool: pg.Pool | undefined, writer: pg.PoolClient | undefined, observer: pg.PoolClient | undefined;
    let roleCreated = false, writerCommitted = false, configureDone = false;
    let configuring: Promise<Outcome<pg.QueryResult>> | undefined;
    let pending: ReturnType<typeof processBrief> | undefined;
    let outcome: Awaited<ReturnType<typeof processBrief>> | undefined;
    const gate = Math.floor(Math.random() * 1_000_000_000) + 1, marker = gate + 1;
    try {
      await f.owner.query(`CREATE ROLE ${quoteStandupIdentifier(workerRole)} LOGIN PASSWORD '${password}'`); roleCreated = true;
      execFileSync('psql', [process.env.CONTINUUM_TEST_DATABASE_URL!, '-X', '-v', 'ON_ERROR_STOP=1',
        '-v', `continuum_schema=${schema}`, '-v', `continuum_brief_worker_role=${workerRole}`,
        '-f', join(process.cwd(), 'scripts/grant-brief-worker-role.sql')], { timeout: 30000, stdio: 'pipe' });
      await f.operator.query('SELECT continuum_operator_install_brief_profile($1,$2,TRUE)', [f.adminId, briefDescriptor(profile)]);
      await f.operator.query('SELECT continuum_operator_bind_brief_worker($1,$2,$3,$4,$5,TRUE)',
        [f.adminId, workerRole, f.producerId, project.id, profile.id]);
      const url = new URL(process.env.CONTINUUM_TEST_DATABASE_URL!); url.username = workerRole; url.password = password;
      workerPool = new pg.Pool({ connectionString: url.toString(), max: 1,
        options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
      const workerSession = (await workerPool.query('SELECT pg_backend_pid() AS pid,session_user AS login')).rows[0];
      expect(workerSession.login).toBe(workerRole);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM brief_scope_epochs')).rows[0].n).toBe(0);
      const visible = await createMemory(f.app, { scopeId: project.id, scopeKind: 'project', authorId: actor.id,
        type: 'decision', title: 'Visible before enrollment', body: 'VISIBLE-BEFORE-ENROLLMENT', source: 'manual' });
      await f.app.query('SELECT continuum_evidence_source($1,$2)', [actor.id, visible.id]);
      writer = await writerPool.connect();
      const writerSession = (await writer.query('SELECT pg_backend_pid() AS pid,session_user AS login')).rows[0];
      const configureSession = (await f.app.query('SELECT pg_backend_pid() AS pid,session_user AS login')).rows[0];
      expect(writerSession.login).toBe(configureSession.login);
      expect(writerSession.pid).not.toBe(configureSession.pid);
      await writer.query('BEGIN');
      const delayed = await createMemory(writer, { scopeId: project.id, scopeKind: 'project', authorId: actor.id,
        type: 'decision', title: 'Already rooted before enrollment', body: 'DELAYED-PREENROLLMENT-SOURCE', source: 'manual' });
      await writer.query('SELECT continuum_evidence_source($1,$2)', [actor.id, delayed.id]);
      expect((await writer.query('SELECT count(*)::int AS n FROM evidence_roots WHERE source_memory_id=$1', [delayed.id])).rows[0].n).toBe(1);
      expect((await writer.query('SELECT count(*)::int AS n FROM brief_scope_epochs')).rows[0].n).toBe(0);
      configuring = settle(f.app.query('SELECT continuum_brief_configure($1,$2,$3,TRUE) AS result',
        [actor.id, project.id, profile.id]));
      void configuring.then(() => { configureDone = true; });
      observer = await f.owner.connect();
      let configurationBlocked = false;
      const configureDeadline = performance.now() + 500;
      while (!configureDone && performance.now() < configureDeadline) {
        configurationBlocked = (await observer.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS value',
          [writerSession.pid, configureSession.pid])).rows[0].value;
        if (configurationBlocked) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(configureDone || configurationBlocked, 'configuration must finish or visibly serialize behind the real older writer').toBe(true);
      if (configurationBlocked) {
        // A correct first-enrollment drain may serialize before configuration
        // completes. Release the actual writer well within its row-wait limit.
        await writer.query('COMMIT'); writerCommitted = true;
      }
      const configured = await configuring;
      expect(configured.error).toBeUndefined();
      observer.release(); observer = undefined;
      const queued = await refreshBrief(f.app, actor,
        { project: project.name, mode: 'full', dryRun: false, idempotencyKey: randomUUID() });
      if (!writerCommitted) {
        await f.owner.query(`CREATE FUNCTION parent_first_enrollment_gate() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.run_id='${queued.runId}'::uuid AND NEW.root_id='${visible.id}'::uuid THEN
              PERFORM pg_advisory_xact_lock_shared(${marker}::bigint);
              WHILE NOT pg_try_advisory_xact_lock(${gate}::bigint) LOOP PERFORM pg_sleep(0.005); END LOOP;
            END IF;
            RETURN NEW;
          END $$;
          REVOKE ALL ON FUNCTION parent_first_enrollment_gate() FROM PUBLIC;
          CREATE TRIGGER parent_first_enrollment_gate AFTER INSERT ON brief_run_inputs
            FOR EACH ROW EXECUTE FUNCTION parent_first_enrollment_gate()`);
        observer = await f.owner.connect();
        await observer.query('SELECT pg_advisory_lock($1::bigint)', [gate]);
        pending = processBrief(workerPool, randomUUID(), profile);
        let entered = false;
        const inventoryDeadline = performance.now() + 1000;
        while (performance.now() < inventoryDeadline) {
          entered = (await observer.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
            AND granted AND classid=0 AND objid=$1::oid AND objsubid=1 AND pid=$2
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS value`, [marker, workerSession.pid])).rows[0].value;
          if (entered) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(entered, 'claim must open its inventory without the still-uncommitted rooted source').toBe(true);
        await writer.query('COMMIT'); writerCommitted = true;
        await observer.query('SELECT pg_advisory_unlock($1::bigint)', [gate]);
        outcome = await pending; pending = undefined;
        observer.release(); observer = undefined;
      } else outcome = await processBrief(workerPool, randomUUID(), profile);
      expect(writerCommitted).toBe(true);
      expect(['progress', 'processed']).toContain(outcome);
      if (outcome === 'progress') {
        const accounting = async () => (await f.owner.query(`SELECT r.workflow_id,r.budget_owner,r.attempt_id,r.deadline_at,w.used
          FROM brief_runs r JOIN pipeline_budget_workflows w ON w.id=r.workflow_id WHERE r.id=$1`, [queued.runId])).rows[0];
        const before = await accounting();
        expect(await processBrief(workerPool, randomUUID(), profile)).toBe('processed');
        const after = await accounting();
        for (const field of ['workflow_id', 'budget_owner', 'attempt_id', 'deadline_at']) expect(after[field]).toEqual(before[field]);
        for (const field of Object.keys(before.used)) expect(Number(after.used[field])).toBeGreaterThanOrEqual(Number(before.used[field]));
      }
      const current = await briefForPrincipal(f.app, actor, project.name);
      expect(current).toMatchObject({ fresh: true, coverage: 'complete' });
      expect(JSON.stringify(current.blocks)).toContain('VISIBLE-BEFORE-ENROLLMENT');
      expect(JSON.stringify(current.blocks), 'a source committed before the recorded cutoff cannot vanish behind first enrollment').toContain('DELAYED-PREENROLLMENT-SOURCE');
    } finally {
      if (observer) await observer.query('SELECT pg_advisory_unlock($1::bigint)', [gate]);
      if (pending) await pending;
      observer?.release();
      if (writer && !writerCommitted) await writer.query('ROLLBACK');
      writer?.release();
      if (configuring) await configuring;
      await Promise.all([workerPool?.end(), writerPool.end()]);
      if (roleCreated) {
        await f.owner.query(`DROP OWNED BY ${quoteStandupIdentifier(workerRole)}`);
        await f.owner.query(`DROP ROLE IF EXISTS ${quoteStandupIdentifier(workerRole)}`);
      }
    }
  });
}, 120_000);
