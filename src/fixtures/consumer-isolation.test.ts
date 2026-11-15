import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { standupConsumerFixture, quoteStandupIdentifier } from '../standup/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { requireEvidenceReady } from '../storage/provider-lifecycle.js';
import { consumerTemplateEnabled } from './test-helpers.js';
import * as templateFixtures from './test-helpers.js';

it('isolates consumer data and LOGINs and cleans a failed case without relabelling migration lineage', async () => {
  const failure = new Error('Intentional consumer failure');
  let previous: { database: string; schema: string; role: string; actor: string; lineage: string } | undefined;
  await expect(standupConsumerFixture(async f => {
    const identity = (await f.owner.query(`SELECT current_database() AS database,current_schema() AS schema,
      md5((SELECT jsonb_agg(to_jsonb(e) ORDER BY attempt_id) FROM _continuum_migration_execution e)::text) AS lineage`)).rows[0];
    expect(identity.database).toBe(decodeURIComponent(new URL(f.connectionString).pathname.slice(1)));
    const role = (await f.producer.query('SELECT session_user AS role')).rows[0].role;
    previous = { ...identity, role, actor: f.actorId };
    await requireEvidenceReady(f.app, { expectedSchema: identity.schema });
    await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: 'Isolated consumer', body: 'Never enter the next fixture.', source: 'manual' });
    throw failure;
  })).rejects.toBe(failure);
  expect(previous).toBeDefined();
  await standupConsumerFixture(async f => {
    const identity = (await f.owner.query(`SELECT current_database() AS database,current_schema() AS schema,
      md5((SELECT jsonb_agg(to_jsonb(e) ORDER BY attempt_id) FROM _continuum_migration_execution e)::text) AS lineage`)).rows[0];
    expect((await f.owner.query('SELECT count(*)::int AS n FROM memories')).rows[0].n).toBe(0);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM principals WHERE id=$1', [previous!.actor])).rows[0].n).toBe(0);
    expect((await f.owner.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1', [previous!.role])).rows[0].n).toBe(0);
    expect(f.actorId).not.toBe(previous!.actor);
    await requireEvidenceReady(f.app, { expectedSchema: identity.schema });
    if (consumerTemplateEnabled()) {
      expect(identity.database).not.toBe(previous!.database);
      expect(identity.schema).toBe(previous!.schema);
      expect(identity.lineage).toBe(previous!.lineage);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [previous!.database])).rows[0].n).toBe(0);
    } else {
      expect(identity.database).toBe(previous!.database);
      expect(identity.schema).not.toBe(previous!.schema);
    }
  });
}, 120000);

it('erases a newly created LOGIN after registration failure and preserves the default fresh cleanup path', async () => {
  const fault = new Error('Synthetic role registration unavailable');
  const state: { role?: { name: string; oid: number }; injected: boolean; callback: boolean } = {
    injected: false, callback: false,
  };
  const observer = new pg.Pool({
    connectionString: process.env.CONTINUUM_TEST_DATABASE_URL ?? 'postgres://continuum:continuum@localhost:5433/continuum',
    max: 1, connectionTimeoutMillis: 5000, options: '-c statement_timeout=5000 -c lock_timeout=1000',
  });
  const capture = async (name: string, client?: pg.PoolClient) => {
    // The creating transaction sees its uncommitted OID. The historical
    // autocommit path has no client and its actual role is already visible.
    const role = (await (client ?? observer).query<{ oid: number }>(
      'SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1', [name])).rows[0];
    expect(role).toBeDefined(); state.role = { name, oid: role.oid };
  };
  const clone = templateFixtures.cloneConsumerDatabase;
  const spy = vi.spyOn(templateFixtures, 'cloneConsumerDatabase').mockImplementation(async template => {
    const allocation = await clone(template);
    const register = allocation.registerRole as (name: string, client?: pg.PoolClient) => Promise<void>;
    return { ...allocation, registerRole: async (name: string, client?: pg.PoolClient) => {
      if (!state.injected) {
        await capture(name, client); state.injected = true;
        throw fault; // Actual CREATE already succeeded; no role registry write or COMMIT yet.
      }
      await register(name, client);
    } };
  });
  const failures: unknown[] = [];
  try {
    await expect(standupConsumerFixture(async f => {
      state.callback = true;
      // In default mode the unchanged fresh path must still run and clean up.
      await capture(f.producerRole);
      throw fault;
    })).rejects.toBe(fault);
    expect(state.injected).toBe(consumerTemplateEnabled());
    expect(state.callback).toBe(!consumerTemplateEnabled());
    if (!consumerTemplateEnabled()) expect(spy).not.toHaveBeenCalled();
    expect(state.role).toBeDefined();
    expect((await observer.query('SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1',
      [state.role!.name])).rows).toEqual([]);
  } catch (error) { failures.push(error); }
  finally {
    spy.mockRestore();
    try {
      // Leave the historical RED run clean, without hiding its assertion.
      // Only the exact role/OID observed after this fixture's actual CREATE
      // can be removed. Never sweep or snapshot every cluster role.
      if (state.role) {
        const current = (await observer.query<{ oid: number }>('SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1',
          [state.role.name])).rows[0];
        if (current) {
          if (current.oid !== state.role.oid) throw new Error('Fault-injection role identity changed; retained for recovery');
          await observer.query(`DROP ROLE ${quoteStandupIdentifier(state.role.name)}`);
        }
      }
    } catch (error) { failures.push(error); }
    try { await observer.end(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Registration regression and exact-identity cleanup failed');
}, 120000);
