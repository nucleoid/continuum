import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { acquireLease } from './coordination.js';
import type { Principal } from '../types.js';

const principal: Principal = {
  id: '00000000-0000-4000-8000-000000000101',
  externalId: 'service:coordination-unit',
  kind: 'service',
  displayName: 'Coordination unit',
  createdAt: new Date(0),
};

const valid = {
  scope: 'project:unit',
  resource: 'resource',
  runId: '00000000-0000-4000-8000-000000000102',
  requestId: '00000000-0000-4000-8000-000000000103',
};

describe('coordination service boundaries', () => {
  it('validates exact resource input before touching PostgreSQL', async () => {
    const connect = vi.fn();
    await expect(acquireLease({ connect } as unknown as pg.Pool, principal, {
      ...valid,
      resource: ' edge',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('sanitizes pool and authentication failures as dependency unavailable', async () => {
    const privateMessage = 'postgres://user:secret@example.invalid/private';
    const connect = vi.fn().mockRejectedValue(
      Object.assign(new Error(privateMessage), { code: '28P01' }),
    );
    const error = await acquireLease(
      { connect } as unknown as pg.Pool,
      principal,
      valid,
    ).catch((caught) => caught);
    expect(error).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
      publicMessage: 'A required dependency is unavailable',
    });
    expect(error.publicMessage).not.toContain(privateMessage);
  });

  it('honors cancellation before pool acquisition', async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = vi.fn();
    await expect(acquireLease(
      { connect } as unknown as pg.Pool,
      principal,
      valid,
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: 'COORDINATION_TIMEOUT', status: 503 });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(['40P01', '40001'])('maps retryable PostgreSQL %s to coordination timeout', async (code) => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.startsWith('BEGIN')) {
        throw Object.assign(new Error('retry transaction'), { code });
      }
      return { rows: [], rowCount: 0 };
    });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    await expect(acquireLease(
      { connect } as unknown as pg.Pool,
      principal,
      valid,
    )).rejects.toMatchObject({ code: 'COORDINATION_TIMEOUT', status: 503 });
    expect(release).toHaveBeenCalled();
  });
});
