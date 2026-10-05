import { getPool, closePool } from '../storage/pool.js';
import { getPrincipalByExternalId } from '../storage/principals.js';
import { fetchMembershipSnapshot } from './graph-membership.js';
import { syncEntraMemberships } from '../services/membership-sync.js';

async function main(): Promise<void> {
  if (process.env.CONTINUUM_ENTRA_MEMBERSHIP_SYNC !== 'true') {
    throw new Error('CONTINUUM_ENTRA_MEMBERSHIP_SYNC=true is required');
  }
  const token = process.env.CONTINUUM_GRAPH_ACCESS_TOKEN ?? '';
  const actorExternalId = process.env.CONTINUUM_MEMBERSHIP_SYNC_ACTOR ?? '';
  if (!token || !actorExternalId) throw new Error('Graph token and sync actor are required');
  const pool = getPool();
  try {
    const actor = await getPrincipalByExternalId(pool, actorExternalId);
    if (!actor) throw new Error('membership sync actor is unknown');
    const snapshots = await fetchMembershipSnapshot(token);
    const result = await syncEntraMemberships(pool, actor, snapshots);
    process.stdout.write(`${JSON.stringify({ event: 'entra_membership_sync_complete', ...result })}\n`);
  } finally {
    await closePool();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: 'entra_membership_sync_failed', message: 'sync failed' })}\n`);
  process.exitCode = 1;
});
