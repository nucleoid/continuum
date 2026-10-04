import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';

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
const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';

describe('ensure-scope operator client', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
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
      },
    }).catch((error: unknown) => error as { code: number; stderr: string });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('FORBIDDEN');

    const invalid = await execFileAsync(process.execPath, [script, 'bad', 'name'])
      .catch((error: unknown) => error as { code: number });
    expect(invalid.code).toBe(2);
  }, 20_000);

  it('lists admins without bearer values and safely demotes or removes by UUID', async () => {
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    const writer = await createPrincipal(pool, {
      externalId: 'secret-writer-bearer', kind: 'service', displayName: 'Writer',
    });
    const removed = await createPrincipal(pool, {
      externalId: 'secret-removed-bearer', kind: 'service', displayName: 'Removed',
    });
    await addMembership(pool, writer.id, org.id, 'admin');
    await addMembership(pool, removed.id, org.id, 'admin');

    const inventory = await execFileAsync('psql', [
      databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', listAdminsScript,
    ]);
    expect(inventory.stdout).toContain(writer.id);
    expect(inventory.stdout).toContain(removed.id);
    expect(inventory.stdout).not.toContain(writer.externalId);
    expect(inventory.stdout).not.toContain(removed.externalId);

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
      [[writer.id, removed.id]],
    );
    expect(rows).toEqual([{ principal_id: writer.id, role: 'writer' }]);
  }, 20_000);
});
