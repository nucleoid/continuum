import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { runAuditRetention } from '../maintenance/audit-retention.js';
import { revokeEntraGroupBinding } from './membership-sync.js';
import { mapOwnedUserScope } from './offboarding.js';
import { disablePrincipal, reactivatePrincipal } from './principal-admin.js';

const ACTOR_ID = '10000000-0000-4000-8000-000000000001';
const TARGET_ID = '20000000-0000-4000-8000-000000000001';
const SCOPE_ID = '30000000-0000-4000-8000-000000000001';
const GROUP_ID = '40000000-0000-4000-8000-000000000001';

const actor: Principal = {
  id: ACTOR_ID,
  externalId: 'operator-boundary-admin',
  kind: 'user',
  displayName: 'Operator boundary admin',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function poolRejectingWith(message: string): { pool: pg.Pool; release: ReturnType<typeof vi.fn> } {
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      if (/^BEGIN|^ROLLBACK/.test(sql)) return { rowCount: 0, rows: [] };
      throw new Error(message);
    }),
    release,
  };
  return {
    pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool,
    release,
  };
}

const paths: Array<{
  name: string;
  invoke: (pool: pg.Pool) => Promise<unknown>;
}> = [
  {
    name: 'owned-scope offboarding administration',
    invoke: (pool) => mapOwnedUserScope(pool, actor, TARGET_ID, SCOPE_ID),
  },
  {
    name: 'protected principal disable',
    invoke: (pool) => disablePrincipal(pool, actor, TARGET_ID),
  },
  {
    name: 'principal reactivation',
    invoke: (pool) => reactivatePrincipal(pool, actor, TARGET_ID),
  },
  {
    name: 'audit retention',
    invoke: (pool) => runAuditRetention(pool, {
      retentionDays: 30,
      principalExternalId: actor.externalId,
    }),
  },
  {
    name: 'Entra binding revocation',
    invoke: (pool) => revokeEntraGroupBinding(pool, actor, GROUP_ID),
  },
];

describe('operator boundary database errors', () => {
  it.each([
    'operation requires a DB-bound trusted approve identity',
    'operation requires a role-name/OID-bound trusted approve identity',
  ])('maps %s to FORBIDDEN across affected service paths', async (message) => {
    for (const path of paths) {
      const { pool, release } = poolRejectingWith(message);
      await expect(path.invoke(pool), path.name).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
      expect(release, path.name).toHaveBeenCalledOnce();
    }
  });
});
