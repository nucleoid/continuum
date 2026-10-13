import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecretFiles, resolveCommand } from './container-entrypoint.mjs';
test('secrets preserve whitespace and remove one trailing terminator', () => {
 const root = mkdtempSync(join(tmpdir(), 'continuum-secrets-'));
 try {
  writeFileSync(join(root, 'token'), '  synthetic value  \r\n');
  const env = { CONTINUUM_TOKEN_FILE: join(root, 'token') };
  loadSecretFiles(env, root);
  assert.equal(env.CONTINUUM_TOKEN, '  synthetic value  ');
  assert.equal(env.CONTINUUM_TOKEN_FILE, undefined);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
test('invalid secrets fail before dispatch without exposing values', () => {
 const root = mkdtempSync(join(tmpdir(), 'continuum-secrets-'));
 try {
  mkdirSync(join(root, 'directory'));
  for (const env of [
   { CONTINUUM_TOKEN: 'synthetic-sensitive', CONTINUUM_TOKEN_FILE: join(root, 'missing') },
   { CONTINUUM_TOKEN_FILE: join(root, 'missing') },
   { CONTINUUM_TOKEN_FILE: join(root, '..', 'outside') },
   { CONTINUUM_TOKEN_FILE: join(root, 'directory') },
   { CONTINUUM_TOKEN: '' }, { CONTINUUM_TOKEN: 'synthetic-sensitive\0' },
   { CONTINUUM_TOKEN: 'x'.repeat(65537) },
  ]) assert.throws(() => loadSecretFiles(env, root), e => !e.message.includes('synthetic-sensitive'));
  for (const value of ['', '\n', 'synthetic-sensitive\0', 'x'.repeat(65537)]) {
   writeFileSync(join(root, 'token'), value);
   assert.throws(() => loadSecretFiles({ CONTINUUM_TOKEN_FILE: join(root, 'token') }, root),
    e => !e.message.includes('synthetic-sensitive'));
  }
 } finally { rmSync(root, { recursive: true, force: true }); }
});
test('dispatch permits only installed public entrypoints', () => {
 assert.deepEqual(resolveCommand(['continuum', '--help']), ['bin/continuum.mjs', '--help']);
 assert.deepEqual(resolveCommand(['node', 'dist/api/mcp.js']), ['dist/api/mcp.js']);
 assert.deepEqual(resolveCommand([]), ['dist/api/server.js']);
 for (const args of [['sh', '-c', 'anything'], ['node', '-e', 'anything'],
  ['node', '../dist/api/server.js'], ['dist/test.js']]) assert.throws(() => resolveCommand(args));
});
