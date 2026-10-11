import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { applicationSchemaFromEnv, reconcilePgvectorProviderGrants, requireCoordinationContractReady } from './provider-lifecycle.js';

const databaseUrl = process.env.CONTINUUM_TEST_DATABASE_URL
  ?? 'postgres://continuum:continuum@localhost:5433/continuum';

async function fixture(run: (pool: pg.Pool, admin: pg.Pool, schema: string, shadow: string) => Promise<void>) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const schema = `gate_${suffix}`;
  const shadow = `shadow_${suffix}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE SCHEMA "${shadow}";
      CREATE TABLE "${schema}".memories(id integer);
      CREATE TABLE "${schema}"._continuum_migrations(name text PRIMARY KEY);`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1,
      options: `-c search_path=${shadow},${schema}` });
    await run(pool, admin, schema, shadow);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${shadow}" CASCADE; DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

describe('qualified provider startup gate', () => {
  it('uses an explicit schema anchor and validates PostgreSQL identifier byte limits', () => {
    expect(applicationSchemaFromEnv({})).toBe('public');
    expect(applicationSchemaFromEnv({ CONTINUUM_APPLICATION_SCHEMA: 'Tenant-Schema' })).toBe('Tenant-Schema');
    expect(applicationSchemaFromEnv({ CONTINUUM_APPLICATION_SCHEMA: 'é'.repeat(31) })).toBe('é'.repeat(31));
    for (const schema of ['', 'nul\0schema', 'a'.repeat(64), 'é'.repeat(32)]) {
      expect(() => applicationSchemaFromEnv({ CONTINUUM_APPLICATION_SCHEMA: schema }))
        .toThrow('CONTINUUM_APPLICATION_SCHEMA must be a valid PostgreSQL schema name');
    }
  });

  it('refuses caller-owned planted memories and hardened no-op startup helpers before the tenant', async () => {
    await fixture(async (pool, admin, schema, shadow) => {
      const role = `shadow_runtime_${randomUUID().replaceAll('-', '').slice(0,12)}`;
      try {
        await admin.query(`CREATE ROLE "${role}" NOLOGIN;
          ALTER SCHEMA "${shadow}" OWNER TO "${role}";
          GRANT USAGE ON SCHEMA "${schema}" TO "${role}";
          GRANT SELECT ON "${schema}".memories TO "${role}";`);
        await pool.query(`SET ROLE "${role}"`);
        await pool.query(`CREATE TABLE "${shadow}".memories(id integer);
          CREATE TABLE "${shadow}"._continuum_migrations(name text PRIMARY KEY);
          INSERT INTO "${shadow}"._continuum_migrations VALUES('0080_pgvector_provider_grants.sql');
          CREATE FUNCTION "${shadow}".continuum_assert_current_pgvector_profile() RETURNS void
          LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"${shadow}",pg_temp
          AS $$ BEGIN RETURN; END $$;
          REVOKE ALL ON FUNCTION "${shadow}".continuum_assert_current_pgvector_profile() FROM PUBLIC;
          CREATE FUNCTION "${shadow}".continuum_coordination_contract_is_ready() RETURNS BOOLEAN
          LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,"${shadow}",pg_temp AS 'SELECT TRUE';
          REVOKE ALL ON FUNCTION "${shadow}".continuum_coordination_contract_is_ready() FROM PUBLIC;`);
        await expect(reconcilePgvectorProviderGrants(pool, { expectedSchema: schema })).rejects.toThrow(/runtime application schema.*trust/i);
        await expect(requireCoordinationContractReady(pool, { expectedSchema: schema })).rejects.toThrow(/runtime application schema.*trust/i);
      } finally {
        await pool.query('RESET ROLE');
        await admin.query(`DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`);
      }
    });
  });

  it('refuses an empty leading schema before the configured tenant', async () => {
    await fixture(async (pool, _admin, schema) => {
      await expect(reconcilePgvectorProviderGrants(pool, { expectedSchema: schema }))
        .rejects.toThrow(/runtime application schema.*trust/i);
      await expect(requireCoordinationContractReady(pool, { expectedSchema: schema }))
        .rejects.toThrow(/runtime application schema.*trust/i);
      await pool.query(`SET search_path="${schema}"`);
      await expect(reconcilePgvectorProviderGrants(pool, { expectedSchema: schema })).resolves.toBeUndefined();
    });
  });

  it('resolves contract readiness in the actual memories namespace and rejects untrusted helpers', async () => {
    await fixture(async (pool, admin, schema, shadow) => {
      await admin.query(`CREATE FUNCTION "${schema}".continuum_coordination_contract_is_ready()
        RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path=pg_catalog,"${schema}",pg_temp AS 'SELECT FALSE';
        REVOKE ALL ON FUNCTION "${schema}".continuum_coordination_contract_is_ready() FROM PUBLIC;
        CREATE FUNCTION "${shadow}".continuum_coordination_contract_is_ready()
        RETURNS BOOLEAN LANGUAGE sql AS 'SELECT TRUE';`);
      await expect(requireCoordinationContractReady(pool)).rejects.toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE', message: expect.stringContaining('repair is incomplete'),
      });
      await admin.query(`CREATE OR REPLACE FUNCTION "${schema}".continuum_coordination_contract_is_ready()
        RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path=pg_catalog,"${schema}",pg_temp AS 'SELECT TRUE'`);
      await expect(requireCoordinationContractReady(pool)).resolves.toBeUndefined();
      await admin.query(`GRANT EXECUTE ON FUNCTION "${schema}".continuum_coordination_contract_is_ready() TO PUBLIC`);
      await expect(requireCoordinationContractReady(pool)).rejects.toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE', message: expect.stringContaining('readiness is unavailable'),
      });
      await admin.query(`REVOKE ALL ON FUNCTION "${schema}".continuum_coordination_contract_is_ready() FROM PUBLIC;
        ALTER FUNCTION "${schema}".continuum_coordination_contract_is_ready() SECURITY INVOKER`);
      await expect(requireCoordinationContractReady(pool)).rejects.toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE', message: expect.stringContaining('readiness is unavailable'),
      });
    });
  });

  it('reports a missing tenant readiness helper with the sanitized migration cause', async () => {
    await fixture(async (pool, admin, schema, shadow) => {
      await admin.query(`CREATE FUNCTION "${shadow}".continuum_coordination_contract_is_ready()
        RETURNS BOOLEAN LANGUAGE sql AS 'SELECT TRUE'`);
      await expect(requireCoordinationContractReady(pool)).rejects.toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Coordination contract readiness is unavailable; finish migrations before starting runtimes',
      });
    });
  });

  it.each([true, false])('verifies direct quoted LOGIN startup with helper present=%s', async (helperPresent) => {
    await fixture(async (_pool, admin, schema, shadow) => {
      const role = `startup-role-${randomUUID().slice(0, 8)}`;
      const password = randomUUID();
      let runtime: pg.Pool | undefined;
      try {
        await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}';
          GRANT USAGE ON SCHEMA "${schema}" TO "${role}";
          GRANT SELECT ON "${schema}".memories TO "${role}";
          CREATE FUNCTION "${schema}".continuum_assert_current_pgvector_profile() RETURNS void
          LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"${schema}",pg_temp
          AS $$ BEGIN RETURN; END $$;
          REVOKE ALL ON FUNCTION "${schema}".continuum_assert_current_pgvector_profile() FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION "${schema}".continuum_assert_current_pgvector_profile() TO "${role}";`);
        const url = new URL(databaseUrl); url.username = role; url.password = password;
        runtime = new pg.Pool({ connectionString: url.toString(), max: 1,
          options: `-c search_path=${shadow},${schema}` });
        expect((await runtime.query('SELECT current_user AS role')).rows).toEqual([{ role }]);
        if (helperPresent) {
          await expect(reconcilePgvectorProviderGrants(runtime)).resolves.toBeUndefined();
        } else {
          await admin.query(`DROP FUNCTION "${schema}".continuum_assert_current_pgvector_profile()`);
          await expect(reconcilePgvectorProviderGrants(runtime)).rejects.toThrow(
            'Pgvector startup verifier is missing',
          );
        }
      } finally {
        await runtime?.end();
        await admin.query(`DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`);
      }
    });
  });

  it('runs the verifier in the actual memories namespace despite an earlier no-op', async () => {
    await fixture(async (pool, admin, schema, shadow) => {
      await admin.query(`INSERT INTO "${schema}"._continuum_migrations VALUES('0080_pgvector_provider_grants.sql');
        CREATE FUNCTION "${schema}".continuum_assert_current_pgvector_profile() RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,"${schema}",pg_temp AS $$ BEGIN
          RAISE EXCEPTION 'real tenant gate refuses'; END $$;
        REVOKE ALL ON FUNCTION "${schema}".continuum_assert_current_pgvector_profile() FROM PUBLIC;
        CREATE FUNCTION "${shadow}".continuum_assert_current_pgvector_profile() RETURNS void
        LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;`);
      await expect(reconcilePgvectorProviderGrants(pool)).rejects.toThrow(/real tenant gate refuses/);
    });
  });

  it('fails closed when an owner has ledgered0080 but the tenant helper is missing', async () => {
    await fixture(async (pool, admin, schema) => {
      await admin.query(`INSERT INTO "${schema}"._continuum_migrations VALUES('0080_pgvector_provider_grants.sql')`);
      await expect(reconcilePgvectorProviderGrants(pool)).rejects.toThrow(/pgvector.*missing|missing.*pgvector/i);
    });
  });

  it('allows only an owner to establish the pre0080 compatibility skip', async () => {
    await fixture(async (pool) => {
      await expect(reconcilePgvectorProviderGrants(pool)).resolves.toBeUndefined();
    });
  });

  it('refuses a nonowner missing helper without giving it ledger read access', async () => {
    await fixture(async (pool, admin, schema) => {
      const role = `runtime_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      try {
        await admin.query(`CREATE ROLE "${role}" NOLOGIN;
          GRANT USAGE ON SCHEMA "${schema}" TO "${role}";
          GRANT SELECT ON "${schema}".memories TO "${role}";`);
        await pool.query(`SET ROLE "${role}"`);
        await expect(reconcilePgvectorProviderGrants(pool)).rejects.toThrow(/pgvector.*missing|missing.*pgvector/i);
      } finally {
        await pool.query('RESET ROLE');
        await admin.query(`REVOKE ALL ON SCHEMA "${schema}" FROM "${role}";
          REVOKE ALL ON "${schema}".memories FROM "${role}"; DROP ROLE IF EXISTS "${role}";`);
      }
    });
  });
});
