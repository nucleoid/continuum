import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { listCoordinationPrivacyRepairs, repairCoordinationPrivacy } from './offboarding.js';

const principalId = '11111111-1111-4111-8111-111111111111';
const scopeId = '22222222-2222-4222-8222-222222222222';
const actor: Principal = {
  id: principalId, externalId: 'operator', kind: 'user',
  displayName: 'Operator', createdAt: new Date(0),
};

describe('offboarding connection hygiene', () => {
  it.each([
    ['list', (pool: pg.Pool) => listCoordinationPrivacyRepairs(pool, actor)],
    ['repair', (pool: pg.Pool) => repairCoordinationPrivacy(pool, actor, principalId, {
      confirmationScopeId: scopeId,
    })],
  ] as const)('preserves the %s failure and destroys a connection whose rollback fails', async (_operation, run) => {
    const failure = Object.assign(new Error('connection lost during transaction'), { code: 'ECONNRESET' });
    const rollbackFailure = new Error('connection lost during rollback');
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'ROLLBACK') throw rollbackFailure;
        if (sql.includes('statement_timeout')) throw failure;
        return { rows: [], rowCount: 0 };
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    await expect(run(pool)).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });
});
