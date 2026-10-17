import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { extractRuntimePackage } from './container-assets-extract.mjs';

test('extracts immutable package directories after their children into a new owned target', () => {
 const root = mkdtempSync(join(tmpdir(), 'continuum-assets-extract-'));
 const source = join(root, 'source');
 const destination = join(root, 'installed');
 const tar = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/tar.exe' : 'tar';
 try {
  const bin = join(source, 'opt', 'continuum', 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(destination);
  writeFileSync(join(bin, 'continuum-migrate.mjs'), 'synthetic immutable asset\n');
  chmodSync(join(bin, 'continuum-migrate.mjs'), 0o444);
  chmodSync(bin, 0o555);
  const archive = join(root, 'filesystem.tar');
  execFileSync(tar, ['--force-local', '-cf', archive, '-C', source, 'opt'], { timeout: 10000 });
  extractRuntimePackage(archive, destination, tar);
  assert.equal(readFileSync(join(destination, 'bin', 'continuum-migrate.mjs'), 'utf8'), 'synthetic immutable asset\n');
 } finally {
  for (const path of [join(source,'opt','continuum','bin'),join(destination,'bin'),destination]) {
   try { chmodSync(path, 0o755); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
 }
});
