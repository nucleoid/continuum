import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';

describe('connector durable admission', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = await makeTestPool(); }, 30_000);
  beforeEach(async () => { await resetData(pool); });
  afterAll(async () => { await pool?.end(); });
  it('denies an unapproved repository mapping without disclosing its existence', async () => {
    const actor = await createPrincipal(pool, { externalId: randomUUID(), kind: 'user', displayName: 'Synthetic' });
    const scope = await createScope(pool, { kind: 'project', name: randomUUID() });
    await addMembership(pool, actor.id, scope.id, 'writer');
    const result = await pool.query('SELECT continuum_connector_mapping($1,$2) AS value', [actor.id, randomUUID()]);
    expect(result.rows[0].value).toBeNull();
    expect((await pool.query('SELECT continuum_connector_is_ready() AS ready')).rows[0].ready).toBe(true);
  });
});
