import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { createMemory } from '../../storage/memories.js';
import { createApp } from '../server.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await makeTestPool(); });
afterAll(async () => { await pool?.end(); });
it('does not infer event time for historical memories or ignore explicit hard filters', async () => {
  await resetData(pool);
  const actor = await createPrincipal(pool, { externalId: 'temporal-reader', kind: 'user', displayName: 'Reader' });
  const scope = await createScope(pool, { kind: 'project', name: 'event-time' });
  await addMembership(pool, actor.id, scope.id, 'writer');
  await createMemory(pool, { scopeId: scope.id, scopeKind: scope.kind, type: 'decision', authorId: actor.id, title: 'Time signal', body: 'Signal recorded yesterday mentions 2026-01-01.', source: 'manual' });
  const app = createApp(pool);
  const recall = (body: unknown) => request(app).post('/api/v0/recall').set('Authorization', 'Bearer temporal-reader').send(body);
  expect((await recall({ query: 'signal' })).body.results).toHaveLength(1);
  expect((await recall({ query: 'signal', eventFilter: { at: '2026-01-01T00:00:00Z' } })).body.results).toHaveLength(0);
  expect((await recall({ query: 'signal', eventFilter: { at: '2026-01-01T00:00:00Z', includeUnknown: true } })).body.results).toHaveLength(1);
  expect((await recall({ query: 'signal', eventFilter: { at: '2026-01-01' } })).status).toBe(400);
});
