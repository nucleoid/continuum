import pg from 'pg';
import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { captureMemory } from '../services/capture.js';
import { getMemoryForPrincipal } from '../services/memories.js';

it.each([
  { statement: 0, lock: 0, watchdog: 1500, code: '55P03' },
  { statement: 500, lock: 250, watchdog: 750, code: '55P03' },
  { statement: 250, lock: 2000, watchdog: 750, code: '57014' },
])('bounds GET membership waits while preserving stricter session limits $statement/$lock', async limits => {
  await embeddingQueueFixture(async f => {
    const captured = await captureMemory(f.app, f.router, f.principal, {
      scope: { kind: f.scope.kind, name: f.scope.name }, type: 'fact', title: 'GET admission deadline',
      body: 'Bounded status read without a provider call.', source: 'manual',
    });
    // The ordinary fixture already sets 5s/1s. This real independent APP LOGIN
    // models production defaults and stricter caller-owned session settings.
    const app = new pg.Pool({ connectionString: f.app.options.connectionString, max: 1,
      connectionTimeoutMillis: 5000, options: `${f.app.options.options} -c statement_timeout=${limits.statement} -c lock_timeout=${limits.lock}` });
    const blocker = await f.owner.connect();
    let open = false, watchdogFired = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let reading: Promise<{ error?: unknown }> | undefined;
    try {
      const pid = (await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const before = (await f.app.query(`SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='get_memory'`)).rows[0].n;
      await blocker.query('BEGIN'); open = true;
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      expect((await blocker.query('SELECT principal_id FROM scope_memberships WHERE principal_id=$1 AND scope_id=$2 FOR UPDATE',
        [f.actorId, f.scopeId])).rowCount).toBe(1);
      reading = getMemoryForPrincipal(app, f.principal, captured.memory.id).then(() => ({}), error => ({ error }));
      let blocked = false;
      const observeBy = Date.now() + 750;
      while (Date.now() < observeBy) {
        blocked = (await f.app.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked', [pid, blockerPid])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (!blocked) throw new Error('Actual GET did not wait on its exact membership row');
      // Cleanup-only watchdog starts after the real backend wait is witnessed.
      watchdog = setTimeout(() => { watchdogFired = true; open = false; void blocker.query('ROLLBACK'); }, limits.watchdog);
      const outcome = await reading;
      expect(outcome.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503, cause: { code: limits.code } });
      expect(watchdogFired).toBe(false);
      expect((await f.app.query(`SELECT count(*)::int AS n FROM audit_log WHERE metadata->>'operation'='get_memory'`)).rows[0].n).toBe(before);
      clearTimeout(watchdog); await blocker.query('ROLLBACK'); open = false;
      expect((await getMemoryForPrincipal(app, f.principal, captured.memory.id)).memory.id).toBe(captured.memory.id);
      expect((await app.query(`SELECT (SELECT setting::int FROM pg_settings WHERE name='statement_timeout') AS statement,
        (SELECT setting::int FROM pg_settings WHERE name='lock_timeout') AS lock`)).rows[0]).toEqual({ statement: limits.statement, lock: limits.lock });
      expect(f.adapter.invoke).not.toHaveBeenCalled();
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (open) await blocker.query('ROLLBACK');
      await reading; blocker.release(); await app.end();
    }
  });
}, 60000);
