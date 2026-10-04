import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectEntrypoint } from './entrypoint.js';

describe('isDirectEntrypoint', () => {
  const originalArgvPath = process.argv[1];

  afterEach(() => {
    if (originalArgvPath === undefined) {
      delete process.argv[1];
    } else {
      process.argv[1] = originalArgvPath;
    }
  });

  it('recognises the canonical URL for the invoked script', () => {
    const argvPath = resolve('dist/api/server.js');

    expect(isDirectEntrypoint(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });

  it('rejects a different module URL', () => {
    const argvPath = resolve('dist/api/server.js');
    const moduleUrl = pathToFileURL(resolve('dist/api/mcp.js')).href;

    expect(isDirectEntrypoint(moduleUrl, argvPath)).toBe(false);
  });

  it('rejects a missing argv script path', () => {
    delete process.argv[1];

    expect(isDirectEntrypoint(import.meta.url)).toBe(false);
  });

  it.each([
    'entry point with spaces.js',
    'entry%point.js',
    '記憶-über.js',
  ])('handles special characters in %s', (filename) => {
    const argvPath = resolve('dist/api', filename);

    expect(isDirectEntrypoint(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });

  it('normalises a relative argv script path', () => {
    const argvPath = 'dist/api/server.js';

    expect(isDirectEntrypoint(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });
});
