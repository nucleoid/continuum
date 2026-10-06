import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { LIFECYCLE_PRINCIPAL_ID } from '../lifecycle/principal.js';
import { addMembership } from '../storage/memberships.js';
import { createPrincipal } from '../storage/principals.js';
import { getScopeByRef } from '../storage/scopes.js';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { reactivatePrincipal } from './principal-admin.js';

async function fixture(pool: pg.Pool) {
  const admin = await createPrincipal(pool, {
    externalId: 'reactivation-security-admin', kind: 'user', displayName: 'Admin',
  });
  const target = await createPrincipal(pool, {
    externalId: 'reactivation-security-target', kind: 'user', displayName: 'Target',
  });
  const org = await getScopeByRef(pool, { kind: 'org', name: '' });
  await addMembership(pool, admin.id, org!.id, 'admin');
  await pool.query(
    'UPDATE principals SET disabled_at = now(), offboarded_at = now() WHERE id = $1',
    [target.id],
  );
  return { admin, target };
}

describe('principal reactivation database trust boundary', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });

  it('revokes the security-definer capability from PUBLIC', async () => {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_proc proc
           CROSS JOIN LATERAL aclexplode(
             COALESCE(proc.proacl, acldefault('f', proc.proowner))
           ) privilege
          WHERE proc.oid = 'continuum_reactivate_principal(uuid,uuid)'::regprocedure
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
       ) AS public_execute`,
    );
    expect(result.rows[0].public_execute).toBe(false);
  });

  it('attributes direct capability use to the lifecycle guard, not the presented administrator', async () => {
    const { admin, target } = await fixture(pool);
    await expect(pool.query(
      'SELECT continuum_reactivate_principal($1::uuid, $2::uuid)',
      [target.id, admin.id],
    )).resolves.toBeDefined();

    expect((await pool.query(
      `SELECT disabled_at, offboarded_at, reactivated_at IS NOT NULL AS reactivated
         FROM principals WHERE id = $1`,
      [target.id],
    )).rows[0]).toEqual({ disabled_at: null, offboarded_at: null, reactivated: true });
    expect((await pool.query(
      `SELECT principal_id, metadata->>'operation' AS operation,
              metadata->>'authorization_principal_id' AS authorization_principal_id,
              metadata->>'previously_offboarded' AS previously_offboarded
         FROM audit_log
        WHERE metadata->>'operation' IN
          ('principal_reactivation_guarded', 'principal_reactivated')
        ORDER BY id`,
    )).rows).toEqual([{
      principal_id: LIFECYCLE_PRINCIPAL_ID,
      operation: 'principal_reactivation_guarded',
      authorization_principal_id: admin.id,
      previously_offboarded: 'true',
    }]);
  });

  it('rolls back direct capability use when its mandatory guard audit fails', async () => {
    const { admin, target } = await fixture(pool);
    await pool.query(`
      CREATE FUNCTION issue4_reject_reactivation_guard_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'operation' = 'principal_reactivation_guarded' THEN
          RAISE EXCEPTION 'forced guarded reactivation audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER issue4_reject_reactivation_guard_audit
      BEFORE INSERT ON audit_log FOR EACH ROW
      EXECUTE FUNCTION issue4_reject_reactivation_guard_audit();
    `);
    try {
      await expect(pool.query(
        'SELECT continuum_reactivate_principal($1::uuid, $2::uuid)',
        [target.id, admin.id],
      )).rejects.toThrow(/forced guarded reactivation audit failure/i);
    } finally {
      await pool.query(`
        DROP TRIGGER issue4_reject_reactivation_guard_audit ON audit_log;
        DROP FUNCTION issue4_reject_reactivation_guard_audit();
      `);
    }

    expect((await pool.query(
      `SELECT disabled_at IS NOT NULL AS disabled,
              offboarded_at IS NOT NULL AS offboarded, reactivated_at
         FROM principals WHERE id = $1`,
      [target.id],
    )).rows[0]).toEqual({ disabled: true, offboarded: true, reactivated_at: null });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM audit_log
        WHERE metadata->>'operation' = 'principal_reactivation_guarded'`,
    )).rows[0].count).toBe(0);
  });

  it('keeps authenticated service actor truth in a separate same-transaction audit', async () => {
    const { admin, target } = await fixture(pool);
    await reactivatePrincipal(pool, admin, target.id);

    expect((await pool.query(
      `SELECT principal_id, metadata->>'operation' AS operation,
              metadata->>'authorization_principal_id' AS authorization_principal_id,
              metadata->>'previously_offboarded' AS previously_offboarded
         FROM audit_log
        WHERE metadata->>'operation' IN
          ('principal_reactivation_guarded', 'principal_reactivated')
        ORDER BY id`,
    )).rows).toEqual([
      {
        principal_id: LIFECYCLE_PRINCIPAL_ID,
        operation: 'principal_reactivation_guarded',
        authorization_principal_id: admin.id,
        previously_offboarded: 'true',
      },
      {
        principal_id: admin.id,
        operation: 'principal_reactivated',
        authorization_principal_id: null,
        previously_offboarded: 'true',
      },
    ]);
  });

  it('keeps direct updates and non-admin capability calls prohibited', async () => {
    const { target } = await fixture(pool);
    const outsider = await createPrincipal(pool, {
      externalId: 'reactivation-security-outsider', kind: 'user', displayName: 'Outsider',
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('continuum.reactivation_principal_id', $1, true)`,
        [target.id],
      );
      await expect(client.query(
        `UPDATE principals SET disabled_at = NULL, offboarded_at = NULL,
                reactivated_at = now() WHERE id = $1`,
        [target.id],
      )).rejects.toThrow(/guarded database function/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await expect(pool.query(
      'SELECT continuum_reactivate_principal($1::uuid, $2::uuid)',
      [target.id, outsider.id],
    )).rejects.toThrow(/effective org administrator/i);
  });
});
