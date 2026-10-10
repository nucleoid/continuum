import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { acquireLease } from '../services/coordination.js';
import { lockCoordinationAuthorization, preparePrincipalReceipts, withCoordinationTransaction } from './coordination.js';

function transactionClient(query: ReturnType<typeof vi.fn>) {
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient;
  return { client, pool: { connect: async () => client } as unknown as pg.Pool };
}

describe('coordination handoff unit regressions', () => {
  it('returns the committed result when cancellation arrives in the COMMIT response', async () => {
    const controller = new AbortController();
    const query = vi.fn(async (sql: string) => {
      if (sql === 'COMMIT') controller.abort();
      return { rows: [], rowCount: 0 };
    });
    const { pool } = transactionClient(query);
    await expect(withCoordinationTransaction(pool, controller.signal, async () => 'committed'))
      .resolves.toBe('committed');
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain('ROLLBACK');
  });

  it('keeps an explicit manual writer authorized when an additional Entra grant is stale', async () => {
    const principalId = randomUUID();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('caller_enabled')) return { rows: [{ id: principalId, caller_enabled: true }], rowCount: 1 };
      if (sql.includes('SELECT m.source_kind')) return { rows: [{ source_kind: 'manual' }, { source_kind: 'entra' }], rowCount: 2 };
      if (sql.includes('lock_entra_freshness')) return { rows: [{ fresh: false }], rowCount: 1 };
      return { rows: [{ authorized: true }], rowCount: 1 };
    });
    const { client } = transactionClient(query);
    await expect(lockCoordinationAuthorization(client, principalId, randomUUID())).resolves.toBe(true);
  });

  it.each(['42883', '42703'])('maps missing schema dependency %s to a sanitized 503 code', async (code) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM scopes')) throw Object.assign(new Error('private database details'), { code });
      return { rows: [], rowCount: 0 };
    });
    const { pool } = transactionClient(query);
    await expect(acquireLease(pool, {
      id: randomUUID(), externalId: 'test', kind: 'service', displayName: 'Test', createdAt: new Date(),
    }, { scope: 'project:test', resource: 'r', runId: randomUUID(), requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', message: expect.not.stringContaining('private') });
  });

  it('locks only available expired receipt candidates so concurrent cleanup skips held rows', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    const { client } = transactionClient(query);
    await preparePrincipalReceipts(client, randomUUID());
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
  });
});
