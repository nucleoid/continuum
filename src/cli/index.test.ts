import { describe, expect, it, vi } from 'vitest';
import { readBoundedStdin, runCli, type CliDependencies } from './index.js';
import { CliError } from './http.js';

function harness(fetch: typeof globalThis.fetch, stdin = '', stdinIsTTY = true) {
  let stdout = '';
  let stderr = '';
  const readStdin = vi.fn(async () => stdin);
  const deps: CliDependencies = {
    env: { CONTINUUM_API_URL: 'https://example.test', CONTINUUM_TOKEN: 'opaque' },
    fetch, stdinIsTTY, readStdin,
    stdout: (value: string) => { stdout += value; },
    stderr: (value: string) => { stderr += value; },
    readConfig: async () => null,
    statFile: async () => ({ size: 0, isFile: () => false }),
    readFile: async () => { throw new Error('unexpected file read'); },
    now: () => new Date('2026-10-04T12:00:00Z'),
  };
  return {
    deps,
    stdout: () => stdout,
    stderr: () => stderr,
    readStdin,
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

    const ambiguous = harness(fetch as typeof globalThis.fetch, 'pipe', false);
    expect(await runCli([
      'capture', '--scope', 'org', '--type', 'fact', '--title', 'Two',
      '--body', 'flag', '--body-file', 'notes.md',
    ], ambiguous.deps)).toBe(2);
  });

  it('uses explicit flag and file bodies in non-TTY scripts without reading stdin', async () => {
    const bodies: string[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)).body);
      return Response.json({ id: `memory-${bodies.length}` }, { status: 201 });
    });
    const flagged = harness(fetch as typeof globalThis.fetch, 'ignored pipe', false);
    expect(await runCli([
      'capture', '--scope', 'org', '--type', 'fact', '--title', 'Flag', '--body', 'flag body',
    ], flagged.deps)).toBe(0);
    expect(flagged.readStdin).not.toHaveBeenCalled();

    const order: string[] = [];
    const filed = harness(fetch as typeof globalThis.fetch, 'ignored pipe', false);
    filed.deps.statFile = vi.fn(async () => {
      order.push('stat');
      return { size: 9, isFile: () => true };
    });
    filed.deps.readFile = vi.fn(async () => {
      order.push('read');
      return 'file body\r\n';
    });
    expect(await runCli([
      'capture', '--scope', 'org', '--type', 'fact', '--title', 'File', '--body-file', 'notes.md',
    ], filed.deps)).toBe(0);
    expect(filed.readStdin).not.toHaveBeenCalled();
    expect(order).toEqual(['stat', 'read']);
    expect(bodies).toEqual(['flag body', 'file body']);
  });

  it('normalizes one trailing line ending for every capture body source', async () => {
    const bodies: string[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)).body);
      return Response.json({ id: `memory-${bodies.length}` }, { status: 201 });
    });
    const flagged = harness(fetch as typeof globalThis.fetch);
    await runCli([
      'capture', '--scope', 'org', '--type', 'fact', '--title', 'Flag', '--body', 'flag body\n',
    ], flagged.deps);
    const piped = harness(fetch as typeof globalThis.fetch, 'pipe body\r\n', false);
    await runCli([
      'capture', '--scope', 'org', '--type', 'fact', '--title', 'Pipe',
    ], piped.deps);
    expect(bodies).toEqual(['flag body', 'pipe body']);
  });

  it('bounds idle stdin waits', async () => {
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };
    await expect(readBoundedStdin(stream, { idleTimeoutMs: 5, overallTimeoutMs: 50 }))
      .rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/timed out/i) });
  });

  it('rejects oversized body files from metadata before reading them', async () => {
    const h = harness(vi.fn() as typeof globalThis.fetch);
    const readFile = vi.fn();
    h.deps.statFile = vi.fn(async () => ({ size: 1024 * 1024 + 1, isFile: () => true }));
    h.deps.readFile = readFile;
    expect(await runCli([
      'capture', '--scope', 'org', '--type', 'fact', '--title', 'Large', '--body-file', 'large.md',
    ], h.deps)).toBe(2);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown option', ['recall', 'query', '--does-not-exist']],
    ['missing option value', ['recall', 'query', '--timeout']],
  ])('maps every parseArgs %s error to usage exit 2', async (_label, argv) => {
    const h = harness(vi.fn() as typeof globalThis.fetch);
    expect(await runCli(argv, h.deps)).toBe(2);
    expect(h.stderr()).toMatch(/^continuum: /);
  });

  it('treats an explicitly missing config file as a usage error', async () => {
    const h = harness(vi.fn() as typeof globalThis.fetch);
    h.deps.readConfig = vi.fn(async (_path?: string, required?: boolean) => {
      expect(required).toBe(true);
      throw new CliError('Config file does not exist', 2);
    });
    expect(await runCli(['scopes', '--config', 'missing.json'], h.deps)).toBe(2);
    expect(h.stderr()).toContain('Config file does not exist');
  });

  it('validates commands before loading authenticated configuration', async () => {
    const h = harness(vi.fn() as typeof globalThis.fetch);
    h.deps.env = {};
    const readConfig = vi.fn(async () => null);
    h.deps.readConfig = readConfig;
    expect(await runCli(['does-not-exist'], h.deps)).toBe(2);
    expect(h.stderr()).toContain('Unknown command: does-not-exist');
    expect(h.stderr()).not.toContain('bearer token');
    expect(readConfig).not.toHaveBeenCalled();
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
