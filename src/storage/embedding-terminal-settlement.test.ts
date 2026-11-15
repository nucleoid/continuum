import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { amounts } from '../pipeline/budget.js';
import { captureMemory } from '../services/capture.js';
import { SqlEmbeddingJobStore } from './embedding-jobs.js';

const reservation = amounts({ calls: 1, inputBytes: 1000, contextTokens: 1000, outputBytes: 4096 });

it('resumes the original process after another worker conservatively settles its lost reserve acknowledgement', async () => {
  await embeddingQueueFixture(async f => {
    const capture = (title: string) => captureMemory(f.app, f.router, f.principal, {
      scope: { kind: f.scope.kind, name: f.scope.name }, type: 'fact', title,
      body: 'Actual reserved accounting with no provider dispatch.', source: 'manual',
    });
    await capture('Lost reserve acknowledgement');
    const pool = new pg.Pool({ connectionString: f.worker.options.connectionString,
      options: f.worker.options.options, max: 1, connectionTimeoutMillis: 5000 });
    let loseAcknowledgement = true, lost = false;
    // Forward actual SQL and COMMIT. Only its successful acknowledgement is
    // faulted, after PostgreSQL has durably reserved the original attempt.
    pool.on('connect', client => {
      const query = client.query.bind(client) as (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
      let reserveCommitted = false;
      client.query = (async (sql: string, values?: unknown[]) => {
        const result = await query(sql, values);
        if (sql.includes('continuum_embedding_attempt') && values?.[7] === 'reserve') reserveCommitted = true;
        if (sql === 'COMMIT' && reserveCommitted && loseAcknowledgement) {
          reserveCommitted = false; loseAcknowledgement = false; lost = true;
          throw Object.assign(new Error('Synthetic lost actual reserve COMMIT acknowledgement'), { code: '08006' });
        }
        return result;
      }) as typeof client.query;
    });
    try {
      const original = new SqlEmbeddingJobStore(pool), replacement = new SqlEmbeddingJobStore(f.worker);
      const claim = (await original.claim(f.target, f.policy, randomUUID(), 1, f.profile))!;
      await original.hydrate(claim, 4194304);
      await expect(original.attempt(claim).reserve(reservation, 5096)).rejects.toMatchObject({ code: '08006' });
      expect(lost).toBe(true); expect(original.unsettledAccounting()).toBe(true);
      expect((await f.owner.query('SELECT state FROM pipeline_budget_attempts WHERE workflow_id=$1 AND attempt_id=$2',
        [claim.workflowId, claim.attemptId])).rows).toEqual([{ state: 'reserved' }]);
      const before = (await f.owner.query('SELECT used FROM pipeline_budget_workflows WHERE id=$1', [claim.workflowId])).rows[0].used;
      const windows = (await f.owner.query('SELECT * FROM embedding_dispatch_windows')).rows;
      // Existing owner-only lease-clock fault, not an attempt/settlement/ledger
      // edit or evidence that any dispatched process exited. SQL proves RESERVED.
      await f.owner.query(`UPDATE embedding_cohorts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [claim.id]);
      await f.owner.query(`UPDATE embedding_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE cohort_id=$1`, [claim.id]);
      expect(await replacement.claim(f.target, f.policy, randomUUID(), 1, f.profile)).toBeNull();
      const attempt = (await f.owner.query('SELECT * FROM pipeline_budget_attempts WHERE workflow_id=$1 AND attempt_id=$2',
        [claim.workflowId, claim.attemptId])).rows[0];
      expect(attempt).toMatchObject({ state: 'settled', settlement: { provenance: 'unknown' } });
      await capture('Fresh accepted work after conservative recovery');
      const next = await original.claim(f.target, f.policy, randomUUID(), 1, f.profile);
      expect(original.unsettledAccounting()).toBe(false);
      expect(next).not.toBeNull();
      expect((await f.owner.query('SELECT * FROM pipeline_budget_attempts WHERE workflow_id=$1 AND attempt_id=$2',
        [claim.workflowId, claim.attemptId])).rows[0]).toEqual(attempt);
      expect((await f.owner.query('SELECT used FROM pipeline_budget_workflows WHERE id=$1', [claim.workflowId])).rows[0].used).toEqual(before);
      expect((await f.owner.query('SELECT * FROM embedding_dispatch_windows')).rows).toEqual(windows);
      if (next) expect(await original.release(next)).toBe(true);
      expect(f.adapter.invoke).not.toHaveBeenCalled();
    } finally { await pool.end(); }
  }, { windowSeconds: 86400 });
}, 60000);

it('still rejects conflicting known settlement without changing the original ledger', async () => {
  await embeddingQueueFixture(async f => {
    await captureMemory(f.app, f.router, f.principal, { scope: { kind: f.scope.kind, name: f.scope.name },
      type: 'fact', title: 'Known settlement conflict', body: 'No conservative unknown recovery.', source: 'manual' });
    const store = new SqlEmbeddingJobStore(f.worker);
    const claim = (await store.claim(f.target, f.policy, randomUUID(), 1, f.profile))!;
    await store.hydrate(claim, 4194304);
    expect(await store.attempt(claim).reserve(reservation, 5096)).toBe(true);
    // A never-dispatched reservation can settle without publication authority.
    expect(await store.attempt(claim).settle({ spendMicros: 0 }, 'measured')).toBe(false);
    const before = (await f.owner.query('SELECT * FROM pipeline_budget_attempts WHERE workflow_id=$1', [claim.workflowId])).rows;
    expect(before[0]).toMatchObject({ state: 'settled', settlement: { spendMicros: 0, provenance: 'measured' } });
    await expect(store.attempt(claim).settle({ spendMicros: 1 }, 'measured'))
      .rejects.toMatchObject({ code: '23514', message: 'Conflicting embedding settlement' });
    expect((await f.owner.query('SELECT * FROM pipeline_budget_attempts WHERE workflow_id=$1', [claim.workflowId])).rows).toEqual(before);
    expect(await store.release(claim)).toBe(true);
  });
}, 60000);
