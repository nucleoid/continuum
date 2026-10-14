import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveEvidence, closeEvidence, collectSecretValues, writeFailureEvidence } from './container-maintenance-evidence.mjs';
const fixture = fn => { const dir = mkdtempSync(join(tmpdir(), 'continuum-evidence-')); try { fn(dir); } finally { rmSync(dir, {recursive:true,force:true}); } };
test('evidence reservation is private, unique, bounded and never overwrites retained evidence', () => fixture(dir => {
 const first = reserveEvidence(dir), second = reserveEvidence(dir);
 assert.notEqual(first.path, second.path);
 if (process.platform !== 'win32') assert.equal(statSync(first.path).mode & 0o777, 0o600);
 const path = writeFailureEvidence(first, {phase:'migrate',code:'COMMAND_FAILED',image:'sha256:'+'a'.repeat(64),mode:'upgrade',deadlineMs:900000,backupDeadlineMs:1000}, 'ERROR: 55P03 lock unavailable\nDETAIL: '+'safe detail '.repeat(20000), []);
 assert.equal(path,first.path); assert.ok(statSync(path).size <= 65536);
 const record=JSON.parse(readFileSync(path,'utf8')); assert.equal(record.phase,'migrate'); assert.match(record.lines[0],/55P03 lock unavailable/);
 assert.throws(()=>writeFailureEvidence(first, {}, 'ERROR: overwrite', []), /EVIDENCE_ALREADY_WRITTEN/);
 closeEvidence(first); closeEvidence(first); closeEvidence(second);
 assert.throws(()=>reserveEvidence(join(dir,'missing')), /EVIDENCE_RESERVATION_FAILED/);
}));
test('configured file secrets include exact, newline-normalized and URI password variants', () => fixture(dir => {
 const password='private+password/@value'; const url='postgresql://owner:'+encodeURIComponent(password)+'@postgres/db';
 const path=join(dir,'secret'); writeFileSync(path,url+'\r\n');
 const values=collectSecretValues({secrets:{owner:{file:path}}});
 for (const value of [url+'\r\n',url,password,encodeURIComponent(password)]) assert.ok(values.includes(value));
 const reservation=reserveEvidence(dir);
 const output=`ERROR: 28P01 password authentication failed for user owner\nDETAIL: ${password} ${encodeURIComponent(password)} ${url}\nCONTEXT: SQL statement PASSWORD '${password}'\nError: Bearer eyJabcdefghijk.abcdefghijk.abcdefghijk ctm_123456789abcdefghijklmnop\nERROR: /private/operator/config.env C:\\private\\operator\\config.env\u001b[31m`;
 writeFailureEvidence(reservation,{phase:'grant',code:'COMMAND_FAILED',mode:'fresh'},output,values); closeEvidence(reservation);
 const text=readFileSync(reservation.path,'utf8');
 for (const value of [password,encodeURIComponent(password),url,'eyJabcdefghijk','ctm_123456789','/private/operator','C:\\private']) assert.ok(!text.includes(value),value);
 assert.match(text,/28P01/); assert.match(text,/redacted/); assert.ok(!text.includes('\\u001b'));
}));
test('secret read preflight refuses missing, oversized, invalid UTF8, empty, NUL and symlink inputs without path leaks', () => fixture(dir => {
 const path=join(dir,'operator-private-secret');
 for (const content of [Buffer.alloc(65537,65),Buffer.from([0xff]),Buffer.from(''),Buffer.from('value\0')]) {
  writeFileSync(path,content); assert.throws(()=>collectSecretValues({secrets:{value:{file:path}}}),error=>error.message==='SECRET_EVIDENCE_PREFLIGHT_FAILED'&&!error.message.includes(path));
 }
 assert.throws(()=>collectSecretValues({secrets:{value:{file:join(dir,'missing')}}}),/SECRET_EVIDENCE_PREFLIGHT_FAILED/);
 if(process.platform!=='win32') { writeFileSync(path,'valid'); symlinkSync(path,join(dir,'link')); assert.throws(()=>collectSecretValues({secrets:{value:{file:join(dir,'link')}}}),/SECRET_EVIDENCE_PREFLIGHT_FAILED/); }
}));
test('evidence never serializes arbitrary fields, exception causes or private phase names', () => fixture(dir => {
 const reservation=reserveEvidence(dir);
 writeFailureEvidence(reservation,{phase:'/private/name',code:'raw secret text',image:'private-tag',mode:'unknown',cause:new Error('private-cause'),deadlineMs:-1},'unrecognized private output',[]); closeEvidence(reservation);
 const record=JSON.parse(readFileSync(reservation.path,'utf8'));
 assert.equal(record.phase,null);assert.equal(record.code,null);assert.equal(record.image,null);assert.equal(record.mode,null);assert.deepEqual(record.lines,[]);assert.ok(!JSON.stringify(record).includes('private'));
}));

test('successful close removes only empty reservations, while failed evidence remains retained', () => fixture(dir => {
 const success=reserveEvidence(dir); const path=success.path;
 closeEvidence(success,true); assert.equal(existsSync(path),false); closeEvidence(success,true);
 const failed=reserveEvidence(dir); writeFailureEvidence(failed,{phase:'migrate',code:'DEADLINE_EXCEEDED'},'ERROR: 55P03 lock timeout',[]);
 closeEvidence(failed,true); assert.equal(existsSync(failed.path),true); assert.match(readFileSync(failed.path,'utf8'),/55P03/);
 const interrupted=reserveEvidence(dir); closeEvidence(interrupted); assert.equal(existsSync(interrupted.path),true);
}));

test('reservation, record and cleanup flush files and Linux directory entries in order', () => fixture(dir => {
 const original=fs.fsyncSync, events=[];
 fs.fsyncSync=fd=>{events.push(fs.fstatSync(fd).isDirectory()?'directory':'file');return original(fd);}; syncBuiltinESMExports();
 try {
  const failed=reserveEvidence(dir);writeFailureEvidence(failed,{phase:'grant',code:'COMMAND_FAILED'},'ERROR: 42501 permission denied',[]);closeEvidence(failed);
  const successful=reserveEvidence(dir);closeEvidence(successful,true);
  assert.deepEqual(events,process.platform==='win32'?['file','file','file']:['file','directory','file','directory','file','directory','directory']);
 } finally {fs.fsyncSync=original;syncBuiltinESMExports();}
}));
