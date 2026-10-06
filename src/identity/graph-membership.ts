import type { EntraGroupSnapshot } from '../services/membership-sync.js';
import { MAX_GROUP_MEMBERS, MAX_SYNC_GROUPS, MAX_SYNC_MEMBERSHIPS } from '../services/membership-sync.js';
import { ServiceError } from '../services/errors.js';

interface GraphPage { value?: unknown; '@odata.nextLink'?: unknown }
type Fetch = typeof globalThis.fetch;
const DEFAULT_TIMEOUT_MS = 10_000;
const GRAPH_PAGE_SIZE = 999;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
// Graph can return fewer rows than requested. Permit the one-member-per-page
// worst case plus a terminating empty page, while retaining a hard request cap.
const MAX_MEMBER_PAGES = MAX_GROUP_MEMBERS + 1;

export class MembershipSnapshotTooLargeError extends ServiceError {
  constructor() {
    super('PAYLOAD_TOO_LARGE', 'Entra snapshot exceeds the whole-run limit');
    this.name = 'MembershipSnapshotTooLargeError';
  }
}

export interface GraphFetchOptions {
  maxRetries?: number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

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
  options: Required<GraphFetchOptions>,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { authorization: `Bearer ${token}`, consistencyLevel: 'eventual' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GraphSnapshotUnavailableError('Microsoft Graph request was unavailable', {
        cause: error,
      });
    }
    const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
    if (!retryable || attempt >= options.maxRetries) return response;
    const retryAfter = response.headers.get('retry-after');
    let delayMs = 250 * (2 ** attempt);
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) delayMs = seconds * 1_000;
      else {
        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) delayMs = Math.max(0, retryAt - options.now());
      }
    }
    delayMs = Math.min(delayMs, MAX_RETRY_DELAY_MS);
    try { await response.body?.cancel(); } catch { /* response cleanup is best-effort */ }
    await options.sleep(delayMs);
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
  options: Required<GraphFetchOptions>,
): Promise<GraphPage> {
  const response = await request(fetcher, url, token, timeoutMs, options);
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
  fetchOptions: GraphFetchOptions = {},
): Promise<EntraGroupSnapshot[]> {
  if (token.length < 32 || token.length > 16_384) throw new Error('Graph access token is invalid');
  if (boundGroupIds.length > MAX_SYNC_GROUPS) throw new Error('bound group count exceeds sync limit');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Graph timeout is invalid');
  }
  const maxRetries = fetchOptions.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    throw new Error('Graph retry count is invalid');
  }
  const options: Required<GraphFetchOptions> = {
    maxRetries,
    sleep: fetchOptions.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
    now: fetchOptions.now ?? Date.now,
  };
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
        options,
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
        const current = await page(fetcher, next, token, timeoutMs, options);
        for (const raw of current.value as unknown[]) {
          const memberId = (raw as { id?: unknown }).id;
          if (typeof memberId !== 'string') throw new Error('MALFORMED_MEMBERS');
          members.push(memberId.toLowerCase());
          if (members.length > MAX_GROUP_MEMBERS) throw new Error('GROUP_TOO_LARGE');
          if (total + members.length > MAX_SYNC_MEMBERSHIPS) {
            throw new MembershipSnapshotTooLargeError();
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
