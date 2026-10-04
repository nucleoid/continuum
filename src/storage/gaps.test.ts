import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { recordRead } from '../audit/log.js';
import { selectGapCandidates } from './gaps.js';

describe('selectGapCandidates', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => { await pool?.end(); });

  it('selects only bounded zero-hit request summaries and aggregates normalized duplicates', async () => {
    const a = await createPrincipal(pool, { externalId: 'a', kind: 'user', displayName: 'A' });
    const b = await createPrincipal(pool, { externalId: 'b', kind: 'user', displayName: 'B' });
    await recordRead(pool, { principalId: a.id, query: '  Rollback\u00a0 PROCEDURE  ', metadata: { hits: 0 }, memories: [] });
    await recordRead(pool, { principalId: b.id, query: 'rollback procedure', metadata: { hits: 0 }, memories: [] });
    await recordRead(pool, { principalId: b.id, query: 'not a gap', metadata: { hits: 1 }, memories: [] });
    await recordRead(pool, { principalId: b.id, query: 'internal secret', metadata: { hits: 0, view: 'insights-gaps' }, memories: [] });
    await pool.query(
      `INSERT INTO audit_log (principal_id, action, query, metadata)
       VALUES ($1, 'read', 'string zero', '{"hits":"0"}'),
              ($1, 'read', 'result detail', '{"hits":0,"record_kind":"result"}'),
              ($1, 'read', '   ', '{"hits":0}')`,
      [a.id],
    );

    const result = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 10, maxQueryChars: 2_000,
    });

    expect(result.scannedCount).toBeGreaterThanOrEqual(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      normalized: 'rollback procedure', frequency: 2, distinctPrincipals: 2,
    });
    expect(result.candidates[0].variants).toEqual(expect.arrayContaining([
      'Rollback PROCEDURE', 'rollback procedure',
    ]));
    expect(JSON.stringify(result)).not.toContain(a.id);
    expect(JSON.stringify(result)).not.toContain(b.id);
  });

  it('caps candidates before embedding and reports truncation with stable ordering', async () => {
    const principal = await createPrincipal(pool, { externalId: 'c', kind: 'user', displayName: 'C' });
    for (const query of ['zeta gap', 'alpha gap', 'middle gap']) {
      await recordRead(pool, { principalId: principal.id, query, metadata: { hits: 0 }, memories: [] });
    }
    await pool.query(`UPDATE audit_log SET at = '2026-10-04T00:00:00Z'`);
    const result = await selectGapCandidates(pool, {
      since: new Date(Date.now() - 86_400_000), scanLimit: 50,
      candidateLimit: 2, maxQueryChars: 2_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((item) => item.normalized)).toEqual([
      'alpha gap', 'middle gap',
    ]);
  });
});
