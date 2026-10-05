import { describe, expect, it, vi } from 'vitest';
import { fetchMembershipSnapshot } from './graph-membership.js';

describe('Microsoft Graph membership snapshot', () => {
  it('paginates groups and members without sending the token elsewhere', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ id: 'g1', displayName: 'continuum-team-a-reader' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ id: 'u1' }] }), { status: 200 }));
    expect(await fetchMembershipSnapshot('x'.repeat(32), fetcher)).toEqual([
      { id: 'g1', displayName: 'continuum-team-a-reader', memberObjectIds: ['u1'] },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects pagination links outside Microsoft Graph', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      value: [], '@odata.nextLink': 'https://evil.example/steal',
    }), { status: 200 }));
    await expect(fetchMembershipSnapshot('x'.repeat(32), fetcher)).rejects.toThrow(/untrusted URL/);
  });
});
