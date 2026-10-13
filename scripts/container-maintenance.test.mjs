import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, closeSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reserveBackupTargets } from './container-maintenance.mjs';

test('upgrade preflight refuses missing output, missing parent and every existing sidecar', () => {
 const root = mkdtempSync(join(tmpdir(), 'continuum-backup-preflight-'));
 try {
  assert.throws(() => reserveBackupTargets(undefined), /backup output/);
  assert.throws(() => reserveBackupTargets(join(root, 'absent', 'backup')), /backup directory/);
  for (const suffix of ['', '.roles.sql', '.sha256']) {
   const path = join(root, `candidate-${suffix.length}.dump`);
   writeFileSync(path + suffix, 'retained evidence');
   assert.throws(() => reserveBackupTargets(path), /existing backup/);
   assert.equal(existsSync(path), suffix === '');
  }
 } finally { rmSync(root, { recursive: true, force: true }); }
});
test('preflight reserves new private backup outputs without overwriting evidence', () => {
 const root = mkdtempSync(join(tmpdir(), 'continuum-backup-preflight-'));
 try {
  const paths = reserveBackupTargets(join(root, 'backup.dump'));
  assert.equal(paths.length, 3);
  for (const item of paths) {
   assert.equal(statSync(item.path).size, 0);
   if (process.platform !== 'win32') assert.equal(statSync(item.path).mode & 0o777, 0o600);
   closeSync(item.fd);
  }
  assert.throws(() => reserveBackupTargets(join(root, 'backup.dump')), /existing backup/);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
