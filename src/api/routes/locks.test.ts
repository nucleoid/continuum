import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type CompletionLog } from '../server.js';
import { makeTestPool, resetData } from '../../storage/test-helpers.js';
import { createPrincipal } from '../../storage/principals.js';
import { createScope } from '../../storage/scopes.js';
import { addMembership } from '../../storage/memberships.js';
import { acquireLease } from '../../services/coordination.js';

describe('REST coordination lock routes', () => {
  let pool: pg.Pool;
  let owner: Awaited<ReturnType<typeof createPrincipal>>;
  let observer: Awaited<ReturnType<typeof createPrincipal>>;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
    owner = await createPrincipal(pool, {
      externalId: 'service:route-owner',
      kind: 'service',
      displayName: 'Route owner',
    });
    observer = await createPrincipal(pool, {
      externalId: 'service:route-observer',
      kind: 'service',
      displayName: 'Route observer',
    });
    const scope = await createScope(pool, { kind: 'project', name: 'routes' });
    await addMembership(pool, owner.id, scope.id, 'writer');
    await addMembership(pool, observer.id, scope.id, 'admin');
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('omits all other-holder identity fields', async () => {
    await acquireLease(pool, owner, {
      scope: 'project:routes',
      resource: 'private-holder',
      runId: randomUUID(),
      requestId: randomUUID(),
    });
    const response = await request(createApp(pool))
      .get('/api/v0/locks')
      .query({ scope: 'project:routes', resource: 'private-holder' })
      .set('Authorization', 'Bearer service:route-observer');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      held: true,
      scope: 'project:routes',
      resource: 'private-holder',
      serverTime: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it('logs the normalized path without resource query text', async () => {
    const events: CompletionLog[] = [];
    const logger = {
      info: vi.fn((event: CompletionLog) => events.push(event)),
      error: vi.fn(),
    };
    const secretResource = 'resource-that-must-not-enter-logs';
    await request(createApp(pool, { logger }))
      .get('/api/v0/locks')
      .query({ scope: 'project:routes', resource: secretResource })
      .set('Authorization', 'Bearer service:route-owner')
      .expect(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.path).toBe('/api/v0/locks');
    expect(JSON.stringify(events)).not.toContain(secretResource);
  });
});
