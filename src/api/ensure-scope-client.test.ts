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
});
