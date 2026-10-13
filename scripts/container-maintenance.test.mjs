import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, closeSync, existsSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { reserveBackupTargets, maintenanceBudgets, runtimeAssetManifest, assertRuntimeAssets, assertAssetMounts, quiescenceSql, assertQuiescence } from './container-maintenance.mjs';

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

test('operator deadlines are independently bounded and preserve short test budgets', () => {
 assert.deepEqual(maintenanceBudgets({},{}), {deadlineMs:900000,backupDeadlineMs:900000});
 assert.deepEqual(maintenanceBudgets({}, {CONTINUUM_MAINTENANCE_DEADLINE_SECONDS:'14400',CONTINUUM_BACKUP_DEADLINE_SECONDS:'1800'}), {deadlineMs:14400000,backupDeadlineMs:1800000});
 assert.deepEqual(maintenanceBudgets({deadlineMs:1000}, {}), {deadlineMs:1000,backupDeadlineMs:900000});
 for (const value of ['0','14401','1.5','NaN','', ' 900']) {
  assert.throws(()=>maintenanceBudgets({}, {CONTINUUM_MAINTENANCE_DEADLINE_SECONDS:value}),/Invalid maintenance deadline/);
  assert.throws(()=>maintenanceBudgets({}, {CONTINUUM_BACKUP_DEADLINE_SECONDS:value}),/Invalid backup deadline/);
 }
 assert.throws(()=>maintenanceBudgets({deadlineMs:999},{}), /Invalid maintenance deadline/);
});
test('assets parity refuses changed bytes, missing and added selected files without leaking paths', () => {
 const root=mkdtempSync(join(tmpdir(),'continuum-assets-'));
 try {
  for(const dir of ['deploy','migrations','scripts']) mkdirSync(join(root,dir));
  writeFileSync(join(root,'package.json'),'{}');
  writeFileSync(join(root,'deploy','compose.production.yml'),'public model');
  writeFileSync(join(root,'migrations','0001.sql'),'SELECT 1;');
  writeFileSync(join(root,'scripts','grant.sql'),'SELECT 2;');
  writeFileSync(join(root,'scripts','ignored.mjs'),'ignored runtime helper');
  const reference=runtimeAssetManifest(root);
  assertRuntimeAssets(root,reference);
  writeFileSync(join(root,'scripts','grant.sql'),'tampered');
  assert.throws(()=>assertRuntimeAssets(root,reference),e=>e.code==='ASSET_MISMATCH'&&!e.message.includes(root));
  writeFileSync(join(root,'scripts','grant.sql'),'SELECT 2;');
  writeFileSync(join(root,'scripts','extra.sql'),'SELECT 3;');
  assert.throws(()=>assertRuntimeAssets(root,reference),e=>e.code==='ASSET_MISMATCH');
  rmSync(join(root,'scripts','extra.sql'));
  rmSync(join(root,'migrations','0001.sql'));
  assert.throws(()=>assertRuntimeAssets(root,reference),e=>e.code==='ASSET_MISMATCH');
  assert.throws(()=>assertRuntimeAssets(root,[{name:'../private',sha256:'a'.repeat(64)}]),e=>e.code==='ASSET_MISMATCH');
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('all maintenance assets binds require one readonly verified root', () => {
 const root=resolve('synthetic-assets');
 const job=()=>({volumes:[{type:'bind',source:root,target:'/assets',read_only:true}]});
 const services={bootstrap:job(),'provision-admin':job(),grant:job(),migrate:{volumes:[{type:'bind',source:resolve('proof'),target:'/proof'}]}};
 assertAssetMounts(services,root);
 services.grant.volumes[0].read_only=false;
 assert.throws(()=>assertAssetMounts(services,root),e=>e.code==='ASSET_MISMATCH');
 services.grant=job(); services.migrate.volumes.push({type:'bind',source:resolve('other'),target:'/assets',read_only:true});
 assert.throws(()=>assertAssetMounts(services,root),e=>e.code==='ASSET_MISMATCH');
});
test('quiescence refuses any outside APP OP SYNC owner connection, without terminating it', () => {
 const sql=quiescenceSql('synthetic-db',['owner','app','op',"sync'quoted"]);
 assert.match(sql,/pg_catalog\.pg_stat_activity/); assert.match(sql,/pid<>pg_backend_pid\(\)/);
 for(const role of ['owner','app','op',"sync''quoted"]) assert.ok(sql.includes(role));
 assert.ok(sql.includes('synthetic-db')); assert.ok(!sql.includes('pg_terminate_backend'));
 assertQuiescence('0');
 for(const count of ['1','12','unclassified']) assert.throws(()=>assertQuiescence(count),e=>e.code==='ACTIVE_WRITERS'&&e.phase==='quiescence');
});
