import { describe, expect, it, vi } from 'vitest';
import { runTagVocabularyCli } from './tag-vocabularies.js';

function response(status = 200, body = '{}'): Response {
  return new Response(body, { status });
}

describe('continuum-tags CLI', () => {
  it.each([
    [['list', 'project'], 'GET', '/api/v0/tag-vocabularies?scopeKind=project', undefined],
    [['add', 'project', 'release-ready', 'Ready'], 'POST', '/api/v0/tag-vocabularies', {
      scopeKind: 'project', tag: 'release-ready', description: 'Ready',
    }],
    [['update', 'team', 'incident', 'Active incident'], 'PATCH', '/api/v0/tag-vocabularies/team/incident', {
      description: 'Active incident',
    }],
    [['remove', 'user', 'scratch'], 'DELETE', '/api/v0/tag-vocabularies/user/scratch', undefined],
  ] as const)('maps %j to the REST API', async (args, method, path, body) => {
    const fetchMock = vi.fn(async () => response(200, '{"ok":true}'));
    const output = vi.fn();
    await runTagVocabularyCli(args, {
      fetch: fetchMock as typeof fetch,
      apiUrl: 'https://continuum.example/', token: 'private-token', stdout: output,
    });

    expect(fetchMock).toHaveBeenCalledWith(`https://continuum.example${path}`, expect.objectContaining({
      method,
      headers: expect.objectContaining({ Authorization: 'Bearer private-token' }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    expect(output).toHaveBeenCalledWith('{"ok":true}\n');
  });

  it('requires valid arguments and credentials before network access', async () => {
    const fetchMock = vi.fn();
    await expect(runTagVocabularyCli(['remove', 'invalid', 'tag'], {
      fetch: fetchMock, token: 'token',
    })).rejects.toThrow('Usage:');
    await expect(runTagVocabularyCli(['list', 'project'], {
      fetch: fetchMock, token: '',
    })).rejects.toThrow('CONTINUUM_BEARER is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose response bodies from non-JSON upstream failures', async () => {
    await expect(runTagVocabularyCli(['list', 'project'], {
      fetch: vi.fn(async () => response(502, 'private upstream detail')) as typeof fetch,
      token: 'private-token',
    })).rejects.toThrow('Continuum API returned HTTP 502');
  });
});
