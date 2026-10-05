import type pg from 'pg';
import { getPrincipalByExternalId } from '../storage/principals.js';
import {
  DEFAULT_MAX_STALENESS_HOURS, listBoundEntraGroupIds, MAX_STALENESS_HOURS,
  MAX_SYNC_GROUPS, rejectEntraMembershipSync, syncEntraMemberships,
  type EntraGroupSnapshot, type MembershipSyncResult,
} from '../services/membership-sync.js';
import {
  fetchMembershipSnapshot, GraphSnapshotUnavailableError, MembershipSnapshotTooLargeError,
} from './graph-membership.js';

type SnapshotFetcher = (
  groupIds: readonly string[],
  token: string,
) => Promise<EntraGroupSnapshot[]>;

export async function runMembershipSync(
  pool: pg.Pool,
  env: NodeJS.ProcessEnv = process.env,
  fetchSnapshot: SnapshotFetcher = fetchMembershipSnapshot,
): Promise<MembershipSyncResult> {
  if (env.CONTINUUM_ENTRA_MEMBERSHIP_SYNC !== 'true') {
    throw new Error('CONTINUUM_ENTRA_MEMBERSHIP_SYNC=true is required');
  }
  const token = env.CONTINUUM_GRAPH_ACCESS_TOKEN ?? '';
  const actorExternalId = env.CONTINUUM_MEMBERSHIP_SYNC_ACTOR ?? '';
  if (!token || !actorExternalId) throw new Error('Graph token and sync actor are required');
  const rawStaleness = env.CONTINUUM_ENTRA_MAX_STALENESS_HOURS;
  const maxStalenessHours = rawStaleness === undefined
    ? DEFAULT_MAX_STALENESS_HOURS : Number(rawStaleness);
  if (!Number.isSafeInteger(maxStalenessHours)
    || maxStalenessHours < 1 || maxStalenessHours > MAX_STALENESS_HOURS) {
    throw new Error(`CONTINUUM_ENTRA_MAX_STALENESS_HOURS must be an integer from 1 to ${MAX_STALENESS_HOURS}`);
  }
  const actor = await getPrincipalByExternalId(pool, actorExternalId);
  if (!actor) throw new Error('membership sync actor is unknown');
  try {
    const boundGroupIds = await listBoundEntraGroupIds(pool);
    const snapshots = boundGroupIds.length > MAX_SYNC_GROUPS
      ? boundGroupIds.map((id) => ({ id, status: 'invalid' as const, errorCode: 'SNAPSHOT_TOO_LARGE' }))
      : await fetchSnapshot(boundGroupIds, token);
    return await syncEntraMemberships(pool, actor, snapshots, {
      allowMassDeactivation: env.CONTINUUM_MEMBERSHIP_SYNC_ALLOW_MASS_DEACTIVATION === 'true',
      maxStalenessHours,
    });
  } catch (error) {
    if (error instanceof GraphSnapshotUnavailableError
      || error instanceof MembershipSnapshotTooLargeError) {
      await rejectEntraMembershipSync(pool, actor, error, { maxStalenessHours });
    }
    throw error;
  }
}
