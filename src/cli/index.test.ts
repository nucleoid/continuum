import { describe, expect, it, vi } from 'vitest';
import { runCli } from './index.js';

function harness(fetch: typeof globalThis.fetch, stdin = '', stdinIsTTY = true) {
  let stdout = '';
  let stderr = '';
  return {
    deps: {
      env: { CONTINUUM_API_URL: 'https://example.test', CONTINUUM_TOKEN: 'opaque' },
      fetch, stdinIsTTY, readStdin: async () => stdin,
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
      readConfig: async () => null,
      readFile: async () => { throw new Error('unexpected file read'); },
      now: () => new Date('2026-10-04T12:00:00Z'),
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('continuum CLI', () => {
  it('captures from non-TTY stdin and emits one JSON document', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        scope: { kind: 'project', name: 'continuum' }, body: 'from pipe', source: 'manual',
      });
      return Response.json({ id: 'memory-1', scopeId: 'scope-1', expiresAt: null }, { status: 201 });
    });
    const h = harness(fetch as typeof globalThis.fetch, 'from pipe\n', false);
    expect(await runCli([
      'capture', '--scope', 'project:continuum', '--type', 'fact', '--title', 'Pipe', '--json',
    ], h.deps)).toBe(0);
    expect(JSON.parse(h.stdout())).toMatchObject({ id: 'memory-1' });
    expect(h.stderr()).toBe('');
  });

  it('rejects missing or ambiguous capture bodies before any request', async () => {
    const fetch = vi.fn();
    const tty = harness(fetch as typeof globalThis.fetch);
    expect(await runCli([
      'capture', '--scope', 'org', '--type', 'fact', '--title', 'No body',
    ], tty.deps)).toBe(2);
    expect(fetch).not.toHaveBeenCalled();

    const piped = harness(fetch as typeof globalThis.fetch, 'pipe', false);
    expect(await runCli([
      'capture', '--scope', 'org', '--type', 'fact', '--title', 'Two', '--body', 'flag',
    ], piped.deps)).toBe(2);
  });

  it('normalizes relative audit times against the injected clock', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('since=2026-10-03T12%3A00%3A00.000Z');
      return Response.json({ count: 0, orgAdmin: false, entries: [] });
    });
    const h = harness(fetch as typeof globalThis.fetch);
    expect(await runCli(['audit', '--since', '24h', '--json'], h.deps)).toBe(0);
    expect(JSON.parse(h.stdout())).toMatchObject({ count: 0, entries: [] });
  });

  it('returns documented status codes and keeps diagnostics on stderr', async () => {
    const h = harness(async () => Response.json(
      { code: 'MEMORY_NOT_FOUND', error: 'memory not found' }, { status: 404 },
    ));
    expect(await runCli([
      'verify', '00000000-0000-4000-8000-000000000099', '--still-true',
    ], h.deps)).toBe(4);
    expect(h.stdout()).toBe('');
    expect(h.stderr()).toContain('memory not found');
  });
});
