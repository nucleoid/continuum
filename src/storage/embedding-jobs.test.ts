import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { SqlEmbeddingJobStore } from './embedding-jobs.js';
import type { EmbeddingJobClaim } from './embedding-jobs-model.js';
import { embeddingTarget, MEMORY_EMBEDDING_INPUT_TRANSFORM } from '../embeddings/target.js';
import { starterProfile } from '../pipeline/budget.js';

/** SQL-port tests only. This is not a PostgreSQL authority/integration fixture. */
function connection(result: unknown = true) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const client = { query: vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    return { rows: [{ result }] };
  }), release: vi.fn() };
  const pool = { options: { max: 2, connectionTimeoutMillis: 5000 }, connect: vi.fn(async () => client) };
  return { store: new SqlEmbeddingJobStore(pool as unknown as pg.Pool), client, pool, statements };
}
const claim: EmbeddingJobClaim = { id: 'claim', owner: 'current-owner', generation: '9', target: 'target',
  policyGeneration: '2', policyDigest: 'a'.repeat(64), workflowId: 'original-workflow', attemptId: 'original-attempt',
  attemptOwner: 'original-owner', attemptGeneration: 3, retry: true, remainingMs: 30_000,
  jobs: [{ id: 'job', memoryId: 'memory', sourceGeneration: '5', leaseGeneration: '6' }] };

describe('planned embedding SQL adapter', () => {
  it('owns and releases each bounded transaction before returning', async () => {
    const f = connection();
    await f.store.authorize(claim);
    expect(f.statements[0].sql).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(f.statements[1].sql).toContain("BETWEEN 1 AND 5000");
    expect(f.statements[2].sql).toContain("BETWEEN 1 AND 1000");
    expect(f.statements[3]).toEqual({ sql: 'SELECT continuum_embedding_authorize($1,$2,$3) AS result', values: ['claim', 'current-owner', '9'] });
    expect(f.statements[4].sql).toBe('COMMIT');
    expect(f.client.release).toHaveBeenCalledWith(false);
  });
  it('rolls back a failed capability and discards on failed cleanup', async () => {
    const f = connection();
    f.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('continuum_embedding_') || sql === 'ROLLBACK') throw new Error('synthetic SQL failure');
      return { rows: [{ result: true }] };
    });
    await expect(f.store.authorize(claim)).rejects.toThrow('synthetic SQL failure');
    expect(f.client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(f.client.release).toHaveBeenCalledWith(true);
  });
  it('binds settlement to original accounting identities even after claim mutation', async () => {
    const f = connection();
    const selected = { ...claim };
    const attempt = f.store.attempt(selected);
    selected.attemptId = 'replacement'; selected.attemptOwner = 'replacement'; selected.generation = '10';
    await attempt.settle({}, 'unknown');
    const request = f.statements.find(row => row.sql.includes('continuum_embedding_attempt'))!;
    expect(request.values).toEqual(['claim', 'current-owner', '9', 'original-workflow', 'original-attempt',
      'original-owner', 3, 'settle', { provenance: 'unknown' }, 0]);
  });
  it('failure/release never ask for bodies or accept raw provider error fields', async () => {
    const f = connection();
    await f.store.fail(claim, Object.assign({ code: 'EMBEDDING_SERVER' as const, action: 'retry' as const }, { message: 'secret', rawHeader: 'secret' }));
    await f.store.release(claim);
    const sql = f.statements.map(row => row.sql).join('\n');
    expect(sql).not.toMatch(/hydrate|title|body|SELECT.*memories/);
    expect(JSON.stringify(f.statements)).not.toContain('secret');
  });
  it('rejects oversized hydration and unbounded/shared-style pools before SQL', async () => {
    const f = connection();
    expect(() => f.store.hydrate(claim, 4 * 1024 * 1024 + 1)).toThrow('hydration');
    expect(() => new SqlEmbeddingJobStore({ options: { max: 10, connectionTimeoutMillis: 5000 } } as pg.Pool)).toThrow('dedicated');
    expect(() => new SqlEmbeddingJobStore({ options: { max: 2, connectionTimeoutMillis: 0 } } as pg.Pool)).toThrow('dedicated');
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it('retries a transient settlement using its original identity before another claim', async () => {
    const target = embeddingTarget({ space: { provider: 'synthetic:debt', model: 'fixture', profile: 'fixture', dim: 768,
      inputTransform: MEMORY_EMBEDDING_INPUT_TRANSFORM }, endpoint: 'http://fixture.invalid/debt', local: true });
    const selected = { ...claim, target: target.fingerprint };
    const f = connection(null);
    let broken = true;
    f.client.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      f.statements.push({ sql, values });
      if (sql.includes('continuum_embedding_attempt') && broken) throw Object.assign(new Error('Synthetic network interruption'), { code: '08006' });
      return { rows: [{ result: null }] };
    });
    const attempt = f.store.attempt(selected);
    await expect(attempt.settle({ outputBytes: 123 }, 'unknown')).rejects.toMatchObject({ code: '08006' });
    expect(f.store.unsettledAccounting()).toBe(true);
    selected.workflowId='replacement';selected.attemptId='replacement';selected.generation='10';
    broken=false;
    expect(await f.store.claim(target, { generation: '2', digest: 'a'.repeat(64) }, 'another-worker', 1, starterProfile)).toBeNull();
    expect(f.store.unsettledAccounting()).toBe(false);
    const requests = f.statements.filter(row => row.sql.includes('continuum_embedding_'));
    expect(requests[1].values).toEqual(['claim','current-owner','9','original-workflow','original-attempt','original-owner',3,
      'settle',{ outputBytes: 123, provenance: 'unknown' },0]);
    expect(requests[2].sql).toContain('continuum_embedding_claim');
    expect(JSON.stringify(requests)).not.toMatch(/Synthetic network|replacement/);
  });
  it('rejects non-accounting settlement payload before SQL or metadata retention', async () => {
    const f = connection();
    await expect(f.store.attempt(claim).settle({ body: 'private content' } as never)).rejects.toThrow('Invalid embedding settlement');
    expect(f.pool.connect).not.toHaveBeenCalled();expect(f.store.unsettledAccounting()).toBe(false);
  });
});
