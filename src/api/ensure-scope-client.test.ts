import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { provisionEntraGroupBinding, syncEntraMemberships } from '../services/membership-sync.js';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/ensure-scope.mjs', import.meta.url));
const listAdminsScript = fileURLToPath(
  new URL('../../scripts/list-org-admins.sql', import.meta.url),
);
const demoteAdminScript = fileURLToPath(
  new URL('../../scripts/demote-org-admin.sql', import.meta.url),
);
const removeAdminScript = fileURLToPath(
  new URL('../../scripts/remove-org-admin.sql', import.meta.url),
);
const restoreAdminScript = fileURLToPath(
  new URL('../../scripts/restore-org-admin.sql', import.meta.url),
);
const hasPsql = spawnSync('psql', ['--version'], { stdio: 'ignore' }).status === 0;
const fallbackDatabaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';

describe('ensure-scope operator client', () => {
  let pool: pg.Pool;
  let databaseUrl: string;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    databaseUrl = pool.options.connectionString ?? fallbackDatabaseUrl;
    await resetData(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('returns success for an admin, exit 1 for a non-admin, and exit 2 for bad input', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const admin = await createPrincipal(pool, {
      externalId: 'a'.repeat(64), kind: 'service', displayName: 'Scope Admin',
    });
    const nonAdmin = await createPrincipal(pool, {
      externalId: 'b'.repeat(64), kind: 'service', displayName: 'Not Admin',
    });
    await addMembership(pool, admin.id, org.id, 'admin');

    const success = await execFileAsync(process.execPath, [
      script, 'project', 'client-smoke',
    ], {
      cwd: '/tmp',
      env: {
        ...process.env,
        CONTINUUM_DATABASE_URL: databaseUrl,
        CONTINUUM_PRINCIPAL_EXTERNAL_ID: admin.externalId,
        CONTINUUM_AUTH_MODE: 'dev',
      },
    });
    expect(JSON.parse(success.stdout)).toMatchObject({
      scope: 'project:client-smoke', created: true,
    });

    const denied = await execFileAsync(process.execPath, [
      script, 'project', 'client-smoke',
    ], {
      cwd: '/tmp',
      env: {
        ...process.env,
        CONTINUUM_DATABASE_URL: databaseUrl,
        CONTINUUM_PRINCIPAL_EXTERNAL_ID: nonAdmin.externalId,
        CONTINUUM_AUTH_MODE: 'dev',
      },
    }).catch((error: unknown) => error as { code: number; stderr: string });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('FORBIDDEN');

    const invalid = await execFileAsync(process.execPath, [script, 'bad', 'name'])
      .catch((error: unknown) => error as { code: number });
    expect(invalid.code).toBe(2);

    const unknownCredential = 'c'.repeat(64);
    const startupFailure = await execFileAsync(process.execPath, [
      script, 'project', 'client-smoke',
    ], {
      cwd: '/tmp',
      env: {
        ...process.env,
        CONTINUUM_DATABASE_URL: databaseUrl,
        CONTINUUM_PRINCIPAL_EXTERNAL_ID: unknownCredential,
        CONTINUUM_AUTH_MODE: 'dev',
      },
    }).catch((error: unknown) => error as { code: number; stderr: string });
    expect(startupFailure.code).toBe(3);
    expect(startupFailure.stderr).toContain('transport or startup failure');
    expect(startupFailure.stderr).not.toContain(unknownCredential);
    expect(startupFailure.stderr).not.toContain('Error:');
  }, 20_000);

  it.skipIf(!hasPsql)('lists admins without bearer values and safely changes roles by UUID', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const writer = await createPrincipal(pool, {
      externalId: 'secret-writer-bearer', kind: 'service', displayName: 'Writer',
    });
    const removed = await createPrincipal(pool, {
      externalId: 'secret-removed-bearer', kind: 'service', displayName: 'Removed',
    });
    const keeper = await createPrincipal(pool, {
      externalId: 'secret-keeper-bearer', kind: 'service', displayName: 'Keeper',
    });
    await addMembership(pool, writer.id, org.id, 'admin');
    await addMembership(pool, removed.id, org.id, 'admin');
    await addMembership(pool, keeper.id, org.id, 'admin');

    const inventory = await execFileAsync('psql', [
      databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', listAdminsScript,
    ]);
    expect(inventory.stdout).toContain(writer.id);
    expect(inventory.stdout).toContain(removed.id);
    expect(inventory.stdout).toContain(keeper.id);
    expect(inventory.stdout).not.toContain(writer.externalId);
    expect(inventory.stdout).not.toContain(removed.externalId);
    expect(inventory.stdout).not.toContain(keeper.externalId);

    await execFileAsync('psql', [
      databaseUrl, '-v', 'ON_ERROR_STOP=1', '-v', `principal_id=${writer.id}`,
      '-v', 'replacement_role=writer', '-f', demoteAdminScript,
    ]);
    await execFileAsync('psql', [
      databaseUrl, '-v', 'ON_ERROR_STOP=1', '-v', `principal_id=${removed.id}`,
      '-f', removeAdminScript,
    ]);

    const { rows } = await pool.query(
      `SELECT principal_id, role FROM scope_memberships
        WHERE principal_id = ANY($1::uuid[]) ORDER BY principal_id`,
      [[writer.id, removed.id, keeper.id]],
    );
    expect(rows).toEqual([
      { principal_id: writer.id, role: 'writer' },
      { principal_id: keeper.id, role: 'admin' },
    ].sort((a, b) => a.principal_id.localeCompare(b.principal_id)));

    await execFileAsync('psql', [
      databaseUrl, '-v', 'ON_ERROR_STOP=1', '-v', `principal_id=${writer.id}`,
      '-f', restoreAdminScript,
    ]);
    const restored = await pool.query(
      `SELECT role FROM scope_memberships WHERE principal_id = $1 AND scope_id = $2`,
      [writer.id, org.id],
    );
    expect(restored.rows).toEqual([{ role: 'admin' }]);

    await execFileAsync('psql', [
      databaseUrl, '-v', 'ON_ERROR_STOP=1', '-v', `principal_id=${writer.id}`,
      '-v', 'replacement_role=writer', '-f', demoteAdminScript,
    ]);
    const lastAdminAttempt = await execFileAsync('psql', [
      databaseUrl, '-v', 'ON_ERROR_STOP=1', '-v', `principal_id=${keeper.id}`,
      '-f', removeAdminScript,
    ]).catch((error: unknown) => error as { code: number });
    expect(lastAdminAttempt.code).not.toBe(0);
  }, 20_000);

  it.skipIf(!hasPsql)('does not count an Entra admin as manual break-glass coverage', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const manual = await createPrincipal(pool, {
      externalId: 'manual-break-glass', kind: 'user', displayName: 'Manual break glass',
    });
    const entra = await createPrincipal(pool, {
      externalId: '11111111-1111-4111-8111-111111111111', kind: 'user', displayName: 'Entra admin',
    });
    await addMembership(pool, manual.id, org.id, 'admin');
    const groupId = '22222222-2222-4222-8222-222222222222';
    await provisionEntraGroupBinding(pool, manual, {
      externalId: groupId, scopeId: org.id, role: 'admin',
    });
    await syncEntraMemberships(pool, manual, [{
      id: groupId, status: 'present', displayName: 'Entra admins',
      memberObjectIds: [entra.externalId],
    }]);

    for (const [scriptPath, extra] of [
      [demoteAdminScript, ['-v', 'replacement_role=writer']],
      [removeAdminScript, []],
    ] as const) {
      const result = await execFileAsync('psql', [
        databaseUrl, '-v', 'ON_ERROR_STOP=1', '-v', `principal_id=${manual.id}`,
        ...extra, '-f', scriptPath,
      ]).then(() => ({ code: 0 })).catch((error: unknown) => error as { code: number });
      expect(result.code).not.toBe(0);
      expect((await pool.query(
        `SELECT role, active FROM scope_memberships
          WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'`,
        [manual.id, org.id],
      )).rows).toEqual([{ role: 'admin', active: true }]);
    }
  }, 20_000);
});
