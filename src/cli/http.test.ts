import { createServer } from 'node:http';
import { once } from 'node:events';
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

  it('treats rate limiting as a transient server failure', async () => {
    const client = new ApiClient({
      apiUrl: 'https://example.test', token: 'x', timeoutMs: 100,
      fetch: async () => Response.json({ error: 'try later' }, { status: 429 }),
    });
    await expect(client.json('GET', '/scopes')).rejects.toMatchObject({ exitCode: 5 });
  });

  it('fails closed on redirects without sending the request body to the target', async () => {
    let targetRequests = 0;
    const sourceBodies: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === '/api/v0/capture') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          sourceBodies.push(body);
          response.writeHead(307, { location: '/redirect-target' });
          response.end();
        });
        return;
      }
      targetRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      const client = new ApiClient({
        apiUrl: `http://127.0.0.1:${address.port}`, token: 'x', timeoutMs: 1_000,
      });
      await expect(client.json('POST', '/capture', { body: 'secret body' })).rejects.toMatchObject({
        exitCode: 5,
      });
      expect(sourceBodies).toEqual(['{"body":"secret body"}']);
      expect(targetRequests).toBe(0);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('times out while waiting for headers and while streaming the body', async () => {
    const headers = new ApiClient({
      apiUrl: 'https://example.test', token: 'x', timeoutMs: 10,
      fetch: async () => new Promise<Response>(() => undefined),
    });
    await expect(headers.text('GET', '/agents-md')).rejects.toMatchObject({
      exitCode: 5, message: 'Request timed out',
    });

    const bodyCancelled = vi.fn();
    const body = new ApiClient({
      apiUrl: 'https://example.test', token: 'x', timeoutMs: 10,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
        cancel: bodyCancelled,
      })),
    });
    await expect(body.text('GET', '/agents-md')).rejects.toMatchObject({
      exitCode: 5, message: 'Request timed out',
    });
    expect(bodyCancelled).toHaveBeenCalledOnce();
  });

  it('aborts an oversized streaming response before reading the remainder', async () => {
    const cancelled = vi.fn();
    const client = new ApiClient({
      apiUrl: 'https://example.test', token: 'x', timeoutMs: 100, maxResponseBytes: 4,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5]));
        },
        cancel: cancelled,
      })),
    });
    await expect(client.text('GET', '/agents-md')).rejects.toMatchObject({
      exitCode: 5, message: 'Server response exceeds the size limit',
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('reports a safe request ID and bounds and redacts server details', async () => {
    const client = new ApiClient({
      apiUrl: 'https://example.test', token: 'very-secret', timeoutMs: 100,
      fetch: async () => Response.json({
        error: `${'x'.repeat(300)}very-secret${'y'.repeat(600)}`,
        requestId: 'request-safe-42',
      }, { status: 500 }),
    });
    let failure: CliError | undefined;
    try { await client.json('GET', '/scopes'); } catch (error) { failure = error as CliError; }
    expect(failure).toMatchObject({ exitCode: 5 });
    expect(failure?.message).toContain('(request ID: request-safe-42)');
    expect(failure?.message).not.toContain('very-secret');
    expect(failure!.message.length).toBeLessThanOrEqual(512 + 32);
  });
});
