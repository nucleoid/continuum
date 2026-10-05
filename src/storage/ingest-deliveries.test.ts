import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { makeTestPool, resetData } from './test-helpers.js';
import { createPrincipal } from './principals.js';
import { createScope } from './scopes.js';
import { addMembership } from './memberships.js';
import { captureOne } from '../services/capture.js';
import { processIngestDelivery } from './ingest-deliveries.js';

describe('ingest delivery transaction', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool ??= await makeTestPool();
    await resetData(pool);
  });

  afterAll(async () => { await pool?.end(); });

  it('rolls back the delivery, every memory, and every audit when one capture fails', async () => {
    const principal = await createPrincipal(pool, {
      externalId: 'service:atomic', kind: 'service', displayName: 'Atomic hook',
    });
    const allowed = await createScope(pool, { kind: 'project', name: 'allowed' });
    await createScope(pool, { kind: 'project', name: 'forbidden' });
    await addMembership(pool, principal.id, allowed.id, 'writer');

    await expect(processIngestDelivery(
      pool, 'terminal-summary', 'atomic-1', 'a'.repeat(64), async (client) => {
      const first = await captureOne(client, null, principal, {
        scope: { kind: 'project', name: 'allowed' }, type: 'context',
        title: 'First', body: 'Would otherwise persist.', source: 'terminal-summary',
      });
      const second = await captureOne(client, null, principal, {
        scope: { kind: 'project', name: 'forbidden' }, type: 'context',
        title: 'Second', body: 'Must fail.', source: 'terminal-summary',
      });
      return [first, second];
      },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect((await pool.query('SELECT plugin_id FROM ingest_deliveries')).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM memories')).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM audit_log')).rows).toEqual([]);
  });
});
