import { describe, expect, it, vi } from 'vitest';
import { fetchMembershipSnapshot, GraphSnapshotUnavailableError } from './graph-membership.js';

describe('Microsoft Graph membership snapshot', () => {
  const groupId = '22222222-2222-4222-8222-222222222222';
  const userId = '11111111-1111-4111-8111-111111111111';

  it('fetches every approved group by immutable ID and accepts arbitrary renames', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: groupId, displayName: 'renamed-outside-continuum' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ id: userId }] }), { status: 200 }));
    expect(await fetchMembershipSnapshot([groupId], 'x'.repeat(32), fetcher)).toEqual([{
      id: groupId, status: 'present', displayName: 'renamed-outside-continuum', memberObjectIds: [userId],
    }]);
    expect(String(fetcher.mock.calls[0][0])).toContain(`/groups/${groupId}?`);
    expect(String(fetcher.mock.calls[1][0])).toContain('/members/microsoft.graph.user');
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe(`Bearer ${'x'.repeat(32)}`);
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('represents 404 as definitive disappearance but contains malformed group failures', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'wrong', displayName: 'bad' }), { status: 200 }));
    expect(await fetchMembershipSnapshot([groupId, other], 'x'.repeat(32), fetcher)).toEqual([
      { id: groupId, status: 'missing' },
      { id: other, status: 'invalid', errorCode: 'MALFORMED_GROUP' },
    ]);
  });

  it('rejects pagination links outside Microsoft Graph for only that group', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: groupId, displayName: 'renamed' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [], '@odata.nextLink': 'https://evil.example/steal',
      }), { status: 200 }));
    expect(await fetchMembershipSnapshot([groupId], 'x'.repeat(32), fetcher)).toEqual([
      { id: groupId, status: 'invalid', errorCode: 'GRAPH_FAILURE' },
    ]);
  });

  it.each([401, 403, 429, 500, 503])(
    'aborts the whole snapshot on operational Graph status %s',
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(new Response('', { status }));
      await expect(fetchMembershipSnapshot([groupId], 'x'.repeat(32), fetcher))
        .rejects.toBeInstanceOf(GraphSnapshotUnavailableError);
    },
  );

  it('aborts the whole snapshot on a transport failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('socket reset'));
    await expect(fetchMembershipSnapshot([groupId], 'x'.repeat(32), fetcher))
      .rejects.toBeInstanceOf(GraphSnapshotUnavailableError);
  });

  it.each([
    ['body timeout', new DOMException('timed out', 'TimeoutError')],
    ['connection drop', new TypeError('terminated')],
    ['truncated or non-JSON body', new SyntaxError('Unexpected end of JSON input')],
  ])('aborts the whole snapshot on %s while reading a successful response', async (_name, failure) => {
    const response = {
      ok: true, status: 200, json: vi.fn().mockRejectedValue(failure),
    } as unknown as Response;
    const fetcher = vi.fn().mockResolvedValue(response);
    await expect(fetchMembershipSnapshot([groupId], 'x'.repeat(32), fetcher))
      .rejects.toBeInstanceOf(GraphSnapshotUnavailableError);
  });

  it('aborts when a member-page body is truncated instead of quarantining the group', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: groupId, displayName: 'group' })))
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected end of JSON input')),
      } as unknown as Response);
    await expect(fetchMembershipSnapshot([groupId], 'x'.repeat(32), fetcher))
      .rejects.toBeInstanceOf(GraphSnapshotUnavailableError);
  });

  it('bounds member pagination and rejects a repeating next link', async () => {
    const next = `https://graph.microsoft.com/v1.0/groups/${groupId}/members/microsoft.graph.user?$skiptoken=repeat`;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: groupId, displayName: 'group' })))
      .mockImplementation(async () => new Response(JSON.stringify({ value: [], '@odata.nextLink': next })));

    expect(await fetchMembershipSnapshot([groupId], 'x'.repeat(32), fetcher)).toEqual([{
      id: groupId, status: 'invalid', errorCode: 'PAGINATION_CYCLE',
    }]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
