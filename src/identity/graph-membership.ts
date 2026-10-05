import type { EntraGroupSnapshot } from '../services/membership-sync.js';
import { MAX_GROUP_MEMBERS, MAX_SYNC_GROUPS, MAX_SYNC_MEMBERSHIPS } from '../services/membership-sync.js';
import { ServiceError } from '../services/errors.js';

interface GraphPage { value?: unknown; '@odata.nextLink'?: unknown }
type Fetch = typeof globalThis.fetch;
const DEFAULT_TIMEOUT_MS = 10_000;
const GRAPH_PAGE_SIZE = 999;
// Graph can return fewer rows than requested. Permit the one-member-per-page
// worst case plus a terminating empty page, while retaining a hard request cap.
const MAX_MEMBER_PAGES = MAX_GROUP_MEMBERS + 1;

class MembershipSnapshotTooLargeError extends Error {}

export class GraphSnapshotUnavailableError extends ServiceError {
  constructor(message: string, options?: ErrorOptions) {
    super('DEPENDENCY_UNAVAILABLE', 'Microsoft Graph membership snapshot is unavailable', {
      cause: options?.cause ?? new Error(message),
    });
    this.name = 'GraphSnapshotUnavailableError';
  }
}

function safeGraphUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com'
      || !url.pathname.startsWith('/v1.0/')) {
      throw new Error('Graph pagination returned an untrusted URL');
    }
    return url;
  } catch (error) {
    throw new GraphSnapshotUnavailableError('Microsoft Graph pagination URL was invalid', {
      cause: error,
    });
  }
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new GraphSnapshotUnavailableError(
      'Microsoft Graph response body was unavailable',
      { cause: error },
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
  const body = await readJson(response) as GraphPage;
  if (body === null || typeof body !== 'object' || !Array.isArray(body.value)) {
    throw new GraphSnapshotUnavailableError('Microsoft Graph returned an invalid page');
  }
  return body;
}

function nextPage(current: GraphPage): URL | undefined {
  if (!Object.hasOwn(current, '@odata.nextLink')) return undefined;
  const value = current['@odata.nextLink'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new GraphSnapshotUnavailableError('Microsoft Graph returned an invalid next link');
  }
  return safeGraphUrl(value);
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
  for (const rawId of boundGroupIds) {
    const id = rawId.toLowerCase();
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
      const group = await readJson(groupResponse) as { id?: unknown; displayName?: unknown };
      if (typeof group.id !== 'string' || group.id.toLowerCase() !== id
        || typeof group.displayName !== 'string' || group.displayName.length > 256) {
        throw new Error('MALFORMED_GROUP');
      }
      const members: string[] = [];
      let next: URL | undefined = new URL(
        `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(id)}/members/microsoft.graph.user?$select=id&$top=${GRAPH_PAGE_SIZE}`,
      );
      const visited = new Set<string>();
      let pages = 0;
      while (next) {
        if (visited.has(next.href)) {
          throw new GraphSnapshotUnavailableError('Microsoft Graph pagination cycle detected');
        }
        if (++pages > MAX_MEMBER_PAGES) {
          throw new GraphSnapshotUnavailableError('Microsoft Graph pagination limit exceeded');
        }
        visited.add(next.href);
        const current = await page(fetcher, next, token, timeoutMs);
        for (const raw of current.value as unknown[]) {
          const memberId = (raw as { id?: unknown }).id;
          if (typeof memberId !== 'string') throw new Error('MALFORMED_MEMBERS');
          members.push(memberId.toLowerCase());
          if (members.length > MAX_GROUP_MEMBERS) throw new Error('GROUP_TOO_LARGE');
          if (total + members.length > MAX_SYNC_MEMBERSHIPS) {
            throw new MembershipSnapshotTooLargeError('membership snapshot exceeds sync limit');
          }
        }
        next = nextPage(current);
      }
      snapshots.push({ id, status: 'present', displayName: group.displayName, memberObjectIds: members });
      total += members.length;
    } catch (error) {
      if (error instanceof GraphSnapshotUnavailableError
        || error instanceof MembershipSnapshotTooLargeError) throw error;
      const raw = error instanceof Error ? error.message : 'GRAPH_FAILURE';
      const errorCode = /^[A-Z0-9_]+$/.test(raw) ? raw : 'GRAPH_FAILURE';
      snapshots.push({ id, status: 'invalid', errorCode });
    }
  }
  return snapshots;
}
