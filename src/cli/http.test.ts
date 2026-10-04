import { describe, expect, it, vi } from 'vitest';
import { ApiClient, CliError } from './http.js';

describe('CLI HTTP client', () => {
  it('sends an opaque bearer token and never exposes it in errors', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer very-secret');
      throw new Error('failed with very-secret');
    });
    const client = new ApiClient({
      apiUrl: 'https://example.test', token: 'very-secret', timeoutMs: 100,
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.json('GET', '/scopes')).rejects.toMatchObject({
      exitCode: 5, message: expect.not.stringContaining('very-secret'),
    });
  });

  it('bounds response bodies and maps authentication failures', async () => {
    const auth = new ApiClient({
      apiUrl: 'https://example.test', token: 'x', timeoutMs: 100,
      fetch: async () => new Response('{"error":"no"}', { status: 401 }),
    });
    await expect(auth.json('GET', '/scopes')).rejects.toMatchObject({ exitCode: 3 });

    const hostile = new ApiClient({
      apiUrl: 'https://example.test', token: 'server-secret', timeoutMs: 100,
      fetch: async () => Response.json(
        { error: 'server echoed server-secret' }, { status: 500 },
      ),
    });
    await expect(hostile.json('GET', '/scopes')).rejects.toMatchObject({
      message: 'server echoed [REDACTED]',
    });

    const huge = new ApiClient({
      apiUrl: 'https://example.test', token: 'x', timeoutMs: 100, maxResponseBytes: 4,
      fetch: async () => new Response('12345'),
    });
    await expect(huge.text('GET', '/agents-md')).rejects.toBeInstanceOf(CliError);
  });
});
