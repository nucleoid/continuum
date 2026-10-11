import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg, { type PoolConfig } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrincipal } from '../storage/principals.js';
import { createScope, getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { mapOwnedUserScope, offboardPrincipal } from './offboarding.js';

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
describe('offboarding builtin resolution review', () => {
  let owner: pg.Pool;
  beforeEach(async () => { owner ??= await makeTestPool(); await resetData(owner); }, 30_000);
  afterAll(async () => owner?.end());

  it('does not bypass a held sync lock through a later-schema builtin with a bound operator LOGIN', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const role = `offboard_builtin_${suffix}`;
    const hostile = `offboard_later_${suffix}`;
    const password = randomUUID();
    const admin = await createPrincipal(owner, { externalId: `admin:${suffix}`, kind: 'user', displayName: 'Admin' });
    const target = await createPrincipal(owner, { externalId: `target:${suffix}`, kind: 'user', displayName: 'Target' });
    const org = (await getScopeByRef(owner, { kind: 'org', name: '' }))!;
    const owned = await createScope(owner, { kind: 'user', name: `owned:${suffix}` });
    await addMembership(owner, admin.id, org.id, 'admin');
    await addMembership(owner, target.id, owned.id, 'writer');
    await mapOwnedUserScope(owner, admin, target.id, owned.id);
    let operator: pg.Pool | undefined;
    const blocker = await owner.connect();
    let lockHeld = false;
    try {
      await owner.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'`);
      const grantSource = await readFile(path.join(process.cwd(), 'scripts/grant-operator-role.sql'), 'utf8');
      const grantSql = grantSource.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('\\')).join('\n')
        .replaceAll(':"continuum_schema"', '"public"').replaceAll(":'continuum_schema'", "'public'")
        .replaceAll(':"continuum_operator_role"', quote(role)).replaceAll(":'continuum_operator_role'", `'${role}'`)
        .replaceAll(":'continuum_principal_id'", `'${admin.id}'`);
      const grant = await owner.connect();
      let discardGrant = false;
      try { await grant.query(grantSql); }
      catch (error) { try { await grant.query('ROLLBACK'); } catch { discardGrant = true; } throw error; }
      finally { grant.release(discardGrant); }
      await owner.query(`CREATE SCHEMA ${quote(hostile)};
        CREATE SEQUENCE ${quote(hostile)}.called;
        CREATE FUNCTION ${quote(hostile)}.pg_try_advisory_xact_lock(bigint)
          RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
            PERFORM pg_catalog.nextval('${hostile}.called'::pg_catalog.regclass); RETURN TRUE;
          END $$;
        GRANT USAGE ON SCHEMA ${quote(hostile)} TO ${quote(role)};
        GRANT USAGE ON SEQUENCE ${quote(hostile)}.called TO ${quote(role)};
        GRANT EXECUTE ON FUNCTION ${quote(hostile)}.pg_try_advisory_xact_lock(bigint) TO ${quote(role)};
      `);
      const base = (owner as unknown as { options: PoolConfig }).options;
      const url = new URL(base.connectionString!);
      url.username = role; url.password = password;
      operator = new pg.Pool({ connectionString: url.toString(), ssl: base.ssl, max: 1,
        options: `-c search_path=public,${hostile},pg_catalog -c statement_timeout=10000 -c lock_timeout=1000` });
      // Exercise standalone approved operator service, without a new runtime
      // startup/provider dependency or an assumed implicit catalog position.
      expect((await operator.query('SELECT current_user AS role')).rows[0].role).toBe(role);
      await blocker.query('SELECT pg_catalog.pg_advisory_lock(834641726154302119::bigint)');
      lockHeld = true;
      await offboardPrincipal(operator, admin, target.id, { confirmationScopeId: owned.id });
      expect((await owner.query(`SELECT is_called FROM ${quote(hostile)}.called`)).rows[0].is_called).toBe(false);
      expect((await owner.query('SELECT disabled_at FROM principals WHERE id=$1', [target.id])).rows[0].disabled_at)
        .toBeNull();
    } finally {
      if (lockHeld) await blocker.query('SELECT pg_catalog.pg_advisory_unlock(834641726154302119::bigint)');
      blocker.release();
      await operator?.end();
      await owner.query(`DROP SCHEMA IF EXISTS ${quote(hostile)} CASCADE`);
      await owner.query('DELETE FROM continuum_pgvector_role_profiles WHERE database_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)', [role]);
      await owner.query('DELETE FROM continuum_trusted_database_identities WHERE database_role=$1::name', [role]);
      await owner.query(`DROP OWNED BY ${quote(role)}; DROP ROLE ${quote(role)}`);
    }
  }, 30_000);
});
