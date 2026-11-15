import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { captureOne } from '../services/capture.js';
import { processIngestDelivery } from './ingest-deliveries.js';

it.each([{ statementMs: 0, code: '55P03' }, { statementMs: 500, code: '57014' }])(
  'bounds ordinary ingest admission with $code, rolls back, and reuses its delivery identity',
  async ({ statementMs, code }) => {
    await embeddingQueueFixture(async f => {
      const app = new pg.Pool({ connectionString: f.app.options.connectionString, max: 1,
        connectionTimeoutMillis: 5000,
        options: `${f.app.options.options} -c statement_timeout=${statementMs} -c lock_timeout=0` });
      const delivery = `ordinary-lock-${randomUUID()}`, marker = randomUUID();
      const input = { scope: { kind: f.scope.kind, name: f.scope.name }, type: 'fact' as const,
        title: 'Ordinary ingest admission', body: 'Committed only with its queued work.',
        source: 'terminal-summary', sourceRef: marker };
      let identify!: (pid: number) => void;
      const pidReady = new Promise<number>(resolve => { identify = resolve; });
      const run = () => processIngestDelivery(app, 'terminal-summary', delivery, 'a'.repeat(64), async client => {
        identify((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        return [await captureOne(client, f.router, f.principal, input, { fixture: marker })];
      }); // Default boundProducer=false is the regression.
      let pending: Promise<{ result?: Awaited<ReturnType<typeof run>>; error?: unknown }> | undefined;
      let pid: number | undefined;
      try {
        const blocker = await f.owner.connect();
        try {
          await blocker.query('BEGIN');
          await blocker.query('SELECT singleton FROM embedding_admission WHERE singleton FOR UPDATE');
          const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          pending = run().then(result => ({ result }), error => ({ error }));
          const entered = await Promise.race([pidReady.then(pid => ({ pid })),
            pending.then(outcome => ({ outcome }))]);
          if ('outcome' in entered) throw entered.outcome.error ?? new Error('Delivery finished before capture callback');
          pid = entered.pid;
          let observed = false;
          const observeBy = Date.now() + 5000;
          while (Date.now() < observeBy) {
            observed = (await blocker.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked', [pid, blockerPid])).rows[0].blocked;
            if (observed) break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(observed).toBe(true);
          // Cleanup watchdog only, not a new public request SLA. The old unbounded
          // path is canceled and explicitly fails instead of hanging the suite.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([pending,
            new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 6000); })]);
          clearTimeout(timer);
          if (!result) {
            await blocker.query('SELECT pg_cancel_backend($1)', [pid]);
            await pending;
            throw new Error('Ordinary ingest did not apply the existing SQL/lock ceilings');
          }
          expect(result.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503, cause: { code } });
        } finally {
          // Covers an assertion failure after the real wait was established.
          try {
            if (pid !== undefined) await blocker.query('SELECT pg_cancel_backend($1)', [pid]);
            await pending;
          } finally {
            try { await blocker.query('ROLLBACK'); } finally { blocker.release(); }
          }
        }
        expect((await app.query(`SELECT current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock`)).rows)
          .toEqual([{ statement: statementMs === 0 ? '0' : '500ms', lock: '0' }]);
        expect((await f.owner.query('SELECT 1 FROM ingest_deliveries WHERE delivery_id=$1', [delivery])).rowCount).toBe(0);
        expect((await f.owner.query('SELECT 1 FROM memories WHERE source_ref=$1', [marker])).rowCount).toBe(0);
        expect((await f.owner.query("SELECT 1 FROM audit_log WHERE metadata->>'fixture'=$1", [marker])).rowCount).toBe(0);
        expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_jobs')).rows[0].n).toBe(0);
        expect((await f.owner.query('SELECT active FROM embedding_admission WHERE singleton')).rows[0].active).toBe(0);
        expect(f.provider.embed).not.toHaveBeenCalled(); expect(f.adapter.invoke).not.toHaveBeenCalled();
        const recovered = await run();
        const replay = await run();
        expect(recovered.replayed).toBe(false); expect(recovered.captures[0].embeddingStatus).toBe('queued');
        expect(replay.replayed).toBe(true); expect(replay.memoryIds).toEqual(recovered.memoryIds);
        expect((await f.owner.query('SELECT count(*)::int AS n FROM embedding_jobs')).rows[0].n).toBe(1);
        expect((await f.owner.query('SELECT active FROM embedding_admission WHERE singleton')).rows[0].active).toBe(1);
      } finally { await app.end(); }
    });
  }, 120000,
);
