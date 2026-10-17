import { constants, openSync, closeSync, lstatSync, fstatSync, readSync, writeSync, ftruncateSync, fsyncSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
const MAX_BYTES = 65536;
const phases = new Set(['preflight','backup','bootstrap','migrate','provision-admin','grant','api','settlement','quiescence']);
const codes = new Set(['COMMAND_FAILED','DEADLINE_EXCEEDED','BINDING_MISMATCH','INVALID_APPLICATION_ROLE','BACKEND_SETTLEMENT_FAILED','COMPLETED_AFTER_DEADLINE','BACKUP_FAILED','ACTIVE_WRITERS','OWNERSHIP_MISMATCH','MIGRATION_BACKEND_REMAINS','BINDING_INELIGIBLE','MAINTENANCE_LOCKED','BACKUP_DURABILITY_FAILED','PG_IMAGE_MISMATCH','PREFLIGHT_UNAVAILABLE']);
const sideCodes = {
 settlementError: new Set(['BACKEND_SETTLEMENT_FAILED']),
 cleanupError: new Set(['COMMAND_FAILED','DEADLINE_EXCEEDED','OWNERSHIP_MISMATCH','JOB_CLEANUP_UNRESOLVED']),
 evidenceError: new Set(['EVIDENCE_WRITE_FAILED','EVIDENCE_CLOSE_FAILED']),
 evidenceCloseError: new Set(['EVIDENCE_CLOSE_FAILED']),
 lockError: new Set(['MAINTENANCE_LOCK_OWNERSHIP_MISMATCH','MAINTENANCE_LOCK_RELEASE_FAILED','MAINTENANCE_LOCK_MARKER_FAILED'])
};
// Public receipts may expose only fixed codes, never nested exception contents.
export function safeMaintenanceSideErrors(fields) {
 const result={};
 for(const [key,allowed] of Object.entries(sideCodes)) {
  if(!fields || !Object.hasOwn(fields,key))continue;
  let code='SIDE_ERROR_UNCLASSIFIED';
  try {
   const value=fields[key];
   const candidates=typeof value==='string'?[value]:[value?.code,value?.message];
   code=candidates.find(candidate=>typeof candidate==='string' && allowed.has(candidate)) ?? code;
  } catch { /* A malformed side error remains classified without its details. */ }
  result[key]=code;
 }
 return result;
}
// This proof controls lock release. Ambiguous, partial or server SQL output
// must fall through to normal owned-session settlement and manual recovery.
export function isProvenPreconnectionFailure(rawOutput,{status,code,signal,timedOut,jobName}={}) {
 if(!Number.isInteger(status) || status<=0 || status>255 || timedOut
  || (signal!==undefined && signal!==null && signal!=='')
  || (code!==undefined && code!==null && code!=='COMMAND_FAILED'))return false;
 let text;
 try {
  if(Buffer.isBuffer(rawOutput)) {
   if(rawOutput.length>16384)return false;
   text=new TextDecoder('utf-8',{fatal:true}).decode(rawOutput);
  } else if(typeof rawOutput==='string' && Buffer.byteLength(rawOutput,'utf8')<=16384)text=rawOutput;
  else return false;
 } catch {return false;}
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))return false;
 text=text.replace(/\r\n/g,'\n').replace(/\n+$/,'');
 if(typeof jobName==='string' && /^[a-z0-9][a-z0-9_-]{0,127}-maintenance-eligibility-[a-f0-9]{24}$/.test(jobName)) {
  const lifecycle=new Set(['Creating','Created','Starting','Started'].map(state=>`Container ${jobName} ${state}`));
  text=text.split('\n').filter(line=>!lifecycle.has(line.replace(/[\t ]+/g,' ').trim())).join('\n');
 }

 // No ERROR/NOTICE/CONTEXT/SQL-command output is accepted as client proof.
 if(/(?:^|\n)\s*(?:(?:ERROR|CONTEXT|NOTICE|DETAIL|HINT|WARNING):|(?:BEGIN|SET|SELECT|DO|COMMIT|ROLLBACK)(?:\s|$))/i.test(text))return false;
 if(status===1 && (/^Error response from daemon: container [a-f0-9]{12,64} is not running$/.test(text)
  || /^Error response from daemon: No such container: [a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(text)
  || /^service "(?:postgres|grant)" is not running$/.test(text)))return true;
 if(status!==2)return false;
 const authentication=/^psql: error: connection to server at "[a-zA-Z0-9_.:-]{1,253}" \([^\n()]{1,128}\), port [0-9]{1,5} failed: FATAL: +password authentication failed for user "[^"\r\n]{1,63}"$/;
 const refusal=/^psql: error: connection to server at "[a-zA-Z0-9_.:-]{1,253}" \([^\n()]{1,128}\), port [0-9]{1,5} failed: Connection refused(?:\n[\t ]*Is the server running on that host and accepting TCP\/IP connections\?)?$/;
 return authentication.test(text) || refusal.test(text);
}
const fail = code => { throw new Error(code); };
function syncDirectory(directory) {
 // Deployment is supported on Linux. Node cannot open directory fds on Windows.
 if(process.platform==='win32')return;
 const fd=openSync(directory,constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
 try {fsyncSync(fd);} finally {closeSync(fd);}
}
export function reserveEvidence(directory) {
 let reservation, opened;
 try {
  const root=resolve(directory); if(!lstatSync(root).isDirectory()) throw new Error();
  const path=join(root,`continuum-maintenance-failure-${randomBytes(16).toString('hex')}.json`);
  const fd=openSync(path,'wx',0o600);opened={path,fd};
  const identity=fstatSync(fd);
  reservation={path,fd,written:false,ino:identity.ino,dev:identity.dev};
  fsyncSync(fd);syncDirectory(root);return reservation;
 } catch {
  if(opened) {
   try {closeSync(opened.fd);} catch { /* Preserve the reservation failure code. */ }
   try {unlinkSync(opened.path);syncDirectory(dirname(opened.path));} catch { /* Preflight still refuses downtime. */ }
  }
  fail('EVIDENCE_RESERVATION_FAILED');
 }
}
export function closeEvidence(reservation, successful=false) {
 if(!reservation)return;
 try {
  if(Number.isInteger(reservation.fd)) {const fd=reservation.fd;reservation.fd=null;closeSync(fd);}
  if(successful===true && !reservation.written && !reservation.removed) {
   const current=lstatSync(reservation.path);
   if(!current.isFile() || current.ino!==reservation.ino || current.dev!==reservation.dev)throw new Error();
   unlinkSync(reservation.path);reservation.removed=true;syncDirectory(dirname(reservation.path));
  }
 } catch {fail('EVIDENCE_CLOSE_FAILED');}
}
export function collectSecretValues(config) {
 const values=new Set();
 try {
  const entries=Object.values(config?.secrets ?? {}); if(entries.length>128) throw new Error();
  for(const entry of entries) {
   if(typeof entry?.file!=='string') throw new Error();
   const before=lstatSync(entry.file); if(!before.isFile()||before.isSymbolicLink()||before.size>MAX_BYTES) throw new Error();
   const fd=openSync(entry.file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
   let raw;
   try {
    const after=fstatSync(fd);if(!after.isFile()||after.size>MAX_BYTES||before.ino!==after.ino||before.dev!==after.dev) throw new Error();
    const buffer=Buffer.alloc(MAX_BYTES+1);let count=0;
    while(count<buffer.length) { const n=readSync(fd,buffer,count,buffer.length-count,null);if(!n)break;count+=n; }
    if(!count||count>MAX_BYTES)throw new Error();raw=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count));
   } finally { closeSync(fd); }
   if(raw.includes('\0'))throw new Error();
   const trimmed=raw.replace(/(?:\r\n|\r|\n)$/,'');if(!trimmed)throw new Error();
   values.add(raw);values.add(trimmed);values.add(raw.replace(/[\r\n]+$/,''));
   for(const value of [raw,trimmed]) {
    values.add(encodeURIComponent(value));values.add(encodeURIComponent(value).replace(/%[A-F0-9]{2}/g,part=>part.toLowerCase()));
    try { const url=new URL(value);if(url.password) { const decoded=decodeURIComponent(url.password);values.add(url.password);values.add(decoded);values.add(encodeURIComponent(decoded));values.add(encodeURIComponent(decoded).replace(/%[A-F0-9]{2}/g,part=>part.toLowerCase())); } } catch { /* Non-URL secrets still use exact-value redaction. */ }
   }
  }
  return [...values].sort((a,b)=>b.length-a.length);
 } catch { fail('SECRET_EVIDENCE_PREFLIGHT_FAILED'); }
}
export function sanitizedMaintenanceLines(rawOutput,secrets) {
 let text=String(rawOutput ?? '');
 for(const secret of [...secrets].filter(value=>typeof value==='string'&&value).sort((a,b)=>b.length-a.length)) text=text.replaceAll(secret,'[redacted-secret]');
 text=text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi,'[redacted-url]')
  .replace(/\bBearer\s+[^\s]+/gi,'Bearer [redacted-token]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted-token]')
  .replace(/\bctm_[A-Za-z0-9_-]+/g,'[redacted-token]')
  .replace(/\b(?:password|passwd|token|secret|api[_-]?key)\s*(?:=|:|\s)\s*(?:'[^']*'|"[^"]*"|[^\s;,]+)/gi,(match,offset,input)=>{
   const prefix=input.slice(input.lastIndexOf('\n',offset)+1,offset);
   const standard=/(?:^|:\s*)FATAL:\s*(?:28P01[:\s]+)?$/i.test(prefix)
    && /^password authentication failed for user\b/i.test(input.slice(offset));
   return standard?match:'credential [redacted-secret]';
  })
  .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|\/)[^\s:;"']+/g,'[redacted-path]')
  .replace(/\b[a-f0-9]{32,}\b/gi,'[redacted-token]');
 const lines=[];
 for(const line of text.split(/\r?\n/)) {
  if(!/^(?:psql:|cat:|ERROR:|FATAL:|DETAIL:|HINT:|CONTEXT:|Error:|Error response from daemon:|\[redacted-path\]:|\s*"?(?:code|message|detail)"?\s*:)/i.test(line))continue;
  // SQL contexts may embed credentials in nested dynamic statements.
  const safe=/^(?:CONTEXT:|DETAIL:).*\b(?:PASSWORD|CREDENTIAL|SECRET|TOKEN)\b/i.test(line)?line.split(':')[0]+': [redacted-sensitive-context]':line;
  lines.push(safe.replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,1000));if(lines.length===48)break;
 }
 return lines;
}
export function writeFailureEvidence(reservation,fields={},rawOutput='',secrets=[]) {
 if(reservation?.written)fail('EVIDENCE_ALREADY_WRITTEN');
 if(!Number.isInteger(reservation?.fd))fail('EVIDENCE_WRITE_FAILED');
 try {
  const budget=value=>Number.isSafeInteger(value)&&value>=1000&&value<=14400000?value:null;
  const record={version:1,phase:phases.has(fields.phase)?fields.phase:null,code:codes.has(fields.code)?fields.code:null,
   image:/^sha256:[a-f0-9]{64}$/.test(fields.image ?? '')?fields.image:null,mode:['fresh','upgrade'].includes(fields.mode)?fields.mode:null,
   deadlineMs:budget(fields.deadlineMs),backupDeadlineMs:budget(fields.backupDeadlineMs),...safeMaintenanceSideErrors(fields),
   ...(fields.lockRetained===true?{lockRetained:true}:{}),lines:sanitizedMaintenanceLines(rawOutput,secrets)};
  let data=Buffer.from(JSON.stringify(record,null,2)+'\n');
  while(data.length>MAX_BYTES&&record.lines.length) {record.lines.pop();data=Buffer.from(JSON.stringify(record,null,2)+'\n');}
  if(data.length>MAX_BYTES)throw new Error();
  ftruncateSync(reservation.fd,0);let offset=0;while(offset<data.length)offset+=writeSync(reservation.fd,data,offset,data.length-offset,offset);
  fsyncSync(reservation.fd);syncDirectory(dirname(reservation.path));reservation.written=true;return reservation.path;
 } catch { fail('EVIDENCE_WRITE_FAILED'); }
}
