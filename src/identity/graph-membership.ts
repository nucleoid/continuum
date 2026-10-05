import type { EntraGroupSnapshot } from '../services/membership-sync.js';
import { MAX_GROUP_MEMBERS, MAX_SYNC_GROUPS, MAX_SYNC_MEMBERSHIPS } from '../services/membership-sync.js';

interface GraphPage { value?: unknown; '@odata.nextLink'?: unknown }
type Fetch = typeof globalThis.fetch;
const DEFAULT_TIMEOUT_MS = 10_000;

export class GraphSnapshotUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GraphSnapshotUnavailableError';
  }
}

function safeGraphUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com'
    || !url.pathname.startsWith('/v1.0/')) {
    throw new Error('Graph pagination returned an untrusted URL');
  }
  return url;
}

async function request(
  fetcher: Fetch,
  url: URL,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetcher(url, {
      headers: { authorization: `Bearer ${token}`, consistencyLevel: 'eventual' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new GraphSnapshotUnavailableError('Microsoft Graph request was unavailable', {
      cause: error,
    });
  }
}

function requireSuccessfulResponse(response: Response): void {
  if (!response.ok) {
    throw new GraphSnapshotUnavailableError(
      `Microsoft Graph request failed with status ${response.status}`,
    );
  }
}

async function page(
  fetcher: Fetch,
  url: URL,
  token: string,
  timeoutMs: number,
): Promise<GraphPage> {
  const response = await request(fetcher, url, token, timeoutMs);
  requireSuccessfulResponse(response);
  const body = await response.json() as GraphPage;
  if (!Array.isArray(body.value)) throw new Error('Microsoft Graph returned an invalid page');
  return body;
}

/** Fetches only administrator-approved immutable group IDs. */
export async function fetchMembershipSnapshot(
  boundGroupIds: readonly string[],
  token: string,
  fetcher: Fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<EntraGroupSnapshot[]> {
  if (token.length < 32 || token.length > 16_384) throw new Error('Graph access token is invalid');
  if (boundGroupIds.length > MAX_SYNC_GROUPS) throw new Error('bound group count exceeds sync limit');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Graph timeout is invalid');
  }
  const snapshots: EntraGroupSnapshot[] = [];
  let total = 0;
  for (const id of boundGroupIds) {
    try {
      const groupResponse = await request(
        fetcher,
        new URL(`https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(id)}?$select=id,displayName`),
        token,
        timeoutMs,
      );
      if (groupResponse.status === 404) {
        snapshots.push({ id, status: 'missing' });
        continue;
      }
      requireSuccessfulResponse(groupResponse);
      const group = await groupResponse.json() as { id?: unknown; displayName?: unknown };
      if (group.id !== id || typeof group.displayName !== 'string' || group.displayName.length > 256) {
        throw new Error('MALFORMED_GROUP');
      }
      const members: string[] = [];
      let next: URL | undefined = new URL(
        `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(id)}/members/microsoft.graph.user?$select=id&$top=999`,
      );
      while (next) {
        const current = await page(fetcher, next, token, timeoutMs);
        for (const raw of current.value as unknown[]) {
          const memberId = (raw as { id?: unknown }).id;
          if (typeof memberId !== 'string') throw new Error('MALFORMED_MEMBERS');
          members.push(memberId);
          if (members.length > MAX_GROUP_MEMBERS || total + members.length > MAX_SYNC_MEMBERSHIPS) {
            throw new Error('GROUP_TOO_LARGE');
          }
        }
        next = typeof current['@odata.nextLink'] === 'string'
          ? safeGraphUrl(current['@odata.nextLink']) : undefined;
      }
      snapshots.push({ id, status: 'present', displayName: group.displayName, memberObjectIds: members });
      total += members.length;
    } catch (error) {
      if (error instanceof GraphSnapshotUnavailableError) throw error;
      const raw = error instanceof Error ? error.message : 'GRAPH_FAILURE';
      const errorCode = /^[A-Z0-9_]+$/.test(raw) ? raw : 'GRAPH_FAILURE';
      snapshots.push({ id, status: 'invalid', errorCode });
    }
  }
  return snapshots;
}
