import type { EntraGroupSnapshot } from '../services/membership-sync.js';
import { MAX_GROUP_MEMBERS, MAX_SYNC_GROUPS, MAX_SYNC_MEMBERSHIPS } from '../services/membership-sync.js';

interface GraphPage { value?: unknown; '@odata.nextLink'?: unknown }
type Fetch = typeof globalThis.fetch;

function safeGraphUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com'
    || !url.pathname.startsWith('/v1.0/')) {
    throw new Error('Graph pagination returned an untrusted URL');
  }
  return url;
}

async function page(fetcher: Fetch, url: URL, token: string): Promise<GraphPage> {
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${token}`, consistencyLevel: 'eventual' },
  });
  if (!response.ok) throw new Error(`Microsoft Graph request failed with status ${response.status}`);
  const body = await response.json() as GraphPage;
  if (!Array.isArray(body.value)) throw new Error('Microsoft Graph returned an invalid page');
  return body;
}

export async function fetchMembershipSnapshot(
  token: string,
  fetcher: Fetch = globalThis.fetch,
): Promise<EntraGroupSnapshot[]> {
  if (token.length < 32 || token.length > 16_384) throw new Error('Graph access token is invalid');
  const groups: EntraGroupSnapshot[] = [];
  let next: URL | undefined = new URL(
    "https://graph.microsoft.com/v1.0/groups?$filter=startsWith(displayName,'continuum-')&$select=id,displayName&$top=100",
  );
  while (next) {
    const current = await page(fetcher, next, token);
    for (const raw of current.value as unknown[]) {
      const item = raw as { id?: unknown; displayName?: unknown };
      if (typeof item.id !== 'string' || typeof item.displayName !== 'string') {
        throw new Error('Microsoft Graph returned an invalid group');
      }
      groups.push({ id: item.id, displayName: item.displayName, memberObjectIds: [] });
      if (groups.length > MAX_SYNC_GROUPS) throw new Error('Microsoft Graph group result exceeds sync limit');
    }
    next = typeof current['@odata.nextLink'] === 'string'
      ? safeGraphUrl(current['@odata.nextLink']) : undefined;
  }
  let total = 0;
  for (const group of groups) {
    next = new URL(`https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(group.id)}/members?$select=id&$top=999`);
    while (next) {
      const current = await page(fetcher, next, token);
      for (const raw of current.value as unknown[]) {
        const id = (raw as { id?: unknown }).id;
        if (typeof id !== 'string') throw new Error('Microsoft Graph returned an invalid member');
        group.memberObjectIds.push(id);
        total += 1;
        if (group.memberObjectIds.length > MAX_GROUP_MEMBERS || total > MAX_SYNC_MEMBERSHIPS) {
          throw new Error('Microsoft Graph membership result exceeds sync limit');
        }
      }
      next = typeof current['@odata.nextLink'] === 'string'
        ? safeGraphUrl(current['@odata.nextLink']) : undefined;
    }
  }
  return groups;
}
