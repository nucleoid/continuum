import { spawnSync } from 'node:child_process';
import { existsSync, openSync, closeSync, readSync, writeSync, statSync, unlinkSync, lstatSync, readdirSync, mkdirSync, fstatSync, fsyncSync, readFileSync, ftruncateSync, constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { validateTmpfsMounts } from './container-compose-model.mjs';
import { reserveEvidence, closeEvidence, collectSecretValues, writeFailureEvidence, safeMaintenanceSideErrors, isProvenPreconnectionFailure } from './container-maintenance-evidence.mjs';

export class MaintenanceFailure extends Error {
 constructor(code, phase = '') { super(`Container maintenance ${phase ? `${phase}: ` : ''}${code}`); this.code = code; this.phase = phase; }
}
export function formatMaintenanceFailure(error) {
 const sides=Object.entries(safeMaintenanceSideErrors(error)).map(([key,value])=>`; ${key}=${value}`).join('');
 return `${error.message}${error.evidencePath ? '; evidence='+error.evidencePath : ''}${sides}${error.lockRetained === true ? '; lockRetained=true' : ''}`;
}
export function reserveBackupTargets(value) {
 if (!value) throw new Error('Upgrade requires a new backup output path');
 const path = resolve(value);
 try { if (!statSync(dirname(path)).isDirectory()) throw new Error(); }
 catch { throw new Error('Upgrade backup directory must already exist'); }
 const names = [path, `${path}.roles.sql`, `${path}.sha256`];
 if (names.some(name => existsSync(name))) throw new Error('Refusing to overwrite existing backup evidence');
 const reserved = [];
 try {
  for (const name of names) reserved.push({ path: name, fd: openSync(name, 'wx', 0o600) });
  return reserved;
 } catch {
  for (const item of reserved) { closeSync(item.fd); unlinkSync(item.path); }
  throw new Error('Unable to reserve private backup output files');
 }
}
function syncDirectory(directory) {
 // Hosted operational support is Linux; Node cannot open a directory on Windows.
 if (process.platform === 'win32') return;
 const fd=openSync(directory,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
 try {fsyncSync(fd);} finally {closeSync(fd);}
}
export function acquireMaintenanceLock(project) {
 if (!/^[a-z0-9][a-z0-9_-]+$/.test(project)) throw new MaintenanceFailure('MAINTENANCE_LOCK_INVALID','preflight');
 const directory=join(homedir(),'.continuum-maintenance-locks');
 try {mkdirSync(directory,{mode:0o700});} catch(error) {if(error.code !== 'EEXIST') throw new MaintenanceFailure('MAINTENANCE_LOCK_INVALID','preflight');}
 const stat=lstatSync(directory);
 if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()))) throw new MaintenanceFailure('MAINTENANCE_LOCK_INVALID','preflight');
 const path=join(directory,project+'.lock'),token=randomBytes(24).toString('hex');let fd;
 try {fd=openSync(path,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),0o600);}
 catch(error) {throw new MaintenanceFailure(error.code === 'EEXIST' ? 'MAINTENANCE_LOCKED' : 'MAINTENANCE_LOCK_INVALID','preflight');}
 const record={version:1,project,pid:process.pid,token};
 const lock={path,directory,fd,record,stat:fstatSync(fd)};
 try {writeSync(fd,JSON.stringify(record)+'\n');fsyncSync(fd);syncDirectory(directory);return lock;}
 catch(error) {try {releaseMaintenanceLock(lock);} catch { /* Preserve acquisition error. */ }throw error;}
}
export function releaseMaintenanceLock(lock) {
 if (!lock || lock.fd === null) return;
 try {
  const stat=lstatSync(lock.path),actual=JSON.parse(readFileSync(lock.path,'utf8'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || stat.ino !== lock.stat.ino || stat.dev !== lock.stat.dev || JSON.stringify(actual) !== JSON.stringify(lock.record)) throw new MaintenanceFailure('MAINTENANCE_LOCK_OWNERSHIP_MISMATCH','preflight');
  unlinkSync(lock.path);syncDirectory(lock.directory);
 } finally {closeSync(lock.fd);lock.fd=null;}
}
function retainUnresolvedLock(lock, session, reason = 'BACKEND_SETTLEMENT_FAILED') {
 lock.retain=true;
 const stat=lstatSync(lock.path),actual=JSON.parse(readFileSync(lock.path,'utf8'));
 if(!stat.isFile() || stat.isSymbolicLink() || stat.size>8192 || stat.ino!==lock.stat.ino || stat.dev!==lock.stat.dev || JSON.stringify(actual)!==JSON.stringify(lock.record)) throw new MaintenanceFailure('MAINTENANCE_LOCK_OWNERSHIP_MISMATCH');
 const sessions=lock.record.unresolved?.sessions ?? [];
 if(!sessions.some(item=>item.applicationName===session.applicationName)) sessions.push(session);
 if(sessions.length>16)throw new MaintenanceFailure('MAINTENANCE_LOCK_MARKER_FAILED');
 lock.record.unresolved={state:reason === 'JOB_CLEANUP_UNRESOLVED' ? 'job-cleanup-unresolved' : 'settlement-unresolved',reason,sessions};
 const bytes=Buffer.from(JSON.stringify(lock.record)+'\n');if(bytes.length>8192)throw new MaintenanceFailure('MAINTENANCE_LOCK_MARKER_FAILED');
 ftruncateSync(lock.fd,0);let offset=0;while(offset<bytes.length)offset+=writeSync(lock.fd,bytes,offset,bytes.length-offset,offset);
 fsyncSync(lock.fd);syncDirectory(lock.directory);
}
export function durableBackupOutputs(backups) {
 for(const item of backups.slice(0,2)) fsyncSync(item.fd);
 const sums=backups.slice(0,2).map(item=>`${hashFile(item.path)}  ${item.path}`).join('\n')+'\n';
 writeSync(backups[2].fd,sums);fsyncSync(backups[2].fd);syncDirectory(dirname(backups[0].path));
 const rechecked=backups.slice(0,2).map(item=>`${hashFile(item.path)}  ${item.path}`).join('\n')+'\n';
 if(rechecked !== sums || readFileSync(backups[2].path,'utf8') !== sums) throw new MaintenanceFailure('BACKUP_VERIFICATION_FAILED','backup');
}
function hashFile(file) {
 const fd = openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(65536);
 try {
  for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; hash.update(buffer.subarray(0, n)); }
  return hash.digest('hex');
 } finally { closeSync(fd); }
}
export function dockerEnvironment(env = process.env) {
 const result = {...env};
 for (const key of Object.keys(result)) if (/^(CONTINUUM_|COMPOSE_)/i.test(key)) delete result[key];
 return result;
}
function docker(args, timeout = 60000) {
 const result = spawnSync('docker', args, { encoding: 'utf8', timeout,
  killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env: dockerEnvironment() });
 if (result.error || result.status !== 0) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const code = result.error?.code === 'ETIMEDOUT' ? 'DEADLINE_EXCEEDED'
   : output.includes('upgrade role binding does not match stored identity') ? 'BINDING_MISMATCH'
   : output.includes('role binding is ineligible') ? 'BINDING_INELIGIBLE'
   : output.includes('non-owner application role') ? 'INVALID_APPLICATION_ROLE'
   : 'COMMAND_FAILED';
  const error = new MaintenanceFailure(code);
  Object.defineProperty(error,'rawOutput',{value:output});
  error.status=result.status;error.signal=result.signal;error.clientCode=result.error?.code;
  throw error;
 }
 return result;
}
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

export function maintenanceBudgets(options = {}, env = process.env) {
 const budget = (override, setting, label) => {
  const input = env[setting];
  const value = override ?? (input === undefined ? 900000 : /^\d+$/.test(input) ? Number(input) * 1000 : NaN);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 14400000) throw new Error('Invalid ' + label + ' deadline');
  return value;
 };
 return { deadlineMs: budget(options.deadlineMs, 'CONTINUUM_MAINTENANCE_DEADLINE_SECONDS', 'maintenance'),
  backupDeadlineMs: budget(options.backupDeadlineMs, 'CONTINUUM_BACKUP_DEADLINE_SECONDS', 'backup') };
}
export function runtimeAssetManifest(root) {
 root = resolve(root);
 if (!lstatSync(root).isDirectory()) throw new Error('Invalid assets');
 const files = []; let total = 0;
 const add = name => {
  const file = join(root, name), stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (total += stat.size) > 128 * 1024 * 1024 || files.length >= 10000) throw new Error('Invalid assets');
  files.push({ name, sha256: hashFile(file) });
 };
 const deploy = (directory, depth = 0) => {
  if (depth > 8 || !lstatSync(join(root,directory)).isDirectory()) throw new Error('Invalid assets');
  for (const entry of readdirSync(join(root,directory)).sort()) {
   const name = directory + '/' + entry, stat = lstatSync(join(root,name));
   if (stat.isDirectory()) deploy(name, depth + 1); else add(name);
  }
 };
 add('package.json'); deploy('deploy');
 for (const directory of ['migrations', 'scripts']) {
  if (!lstatSync(join(root,directory)).isDirectory()) throw new Error('Invalid assets');
  for (const name of readdirSync(join(root,directory)).sort()) if (name.endsWith('.sql')) add(directory + '/' + name);
 }
 return files.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export function assertRuntimeAssets(root, reference) {
 try {
  if (!Array.isArray(reference) || reference.length < 4 || reference.length > 10000) throw new Error();
  const names = new Set();
  for (const item of reference) {
   if (!item || Object.keys(item).sort().join(',') !== 'name,sha256' || typeof item.name !== 'string'
    || !/^(package\.json|deploy\/[a-zA-Z0-9_.\/-]+|(?:migrations|scripts)\/[a-zA-Z0-9_.-]+\.sql)$/.test(item.name)
    || item.name.split('/').some(part => part === '.' || part === '..' || !part)
    || !/^[a-f0-9]{64}$/.test(item.sha256) || names.has(item.name)) throw new Error();
   names.add(item.name);
  }
  const expected = [...reference].sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (JSON.stringify(runtimeAssetManifest(root)) !== JSON.stringify(expected)) throw new Error();
 } catch { throw new MaintenanceFailure('ASSET_MISMATCH', 'preflight'); }
}
export function assertAssetMounts(services, root) {
 try {
  root = resolve(root);
  for (const name of ['bootstrap','provision-admin','grant']) {
   if (services[name]?.volumes?.filter(mount=>mount.target === '/assets').length !== 1) throw new Error();
  }
  for (const service of Object.values(services)) for (const mount of service.volumes ?? []) {
   if (mount.target === '/assets' && (mount.type !== 'bind' || mount.read_only !== true || resolve(mount.source) !== root)) throw new Error();
   if (mount.target?.startsWith('/assets/')) throw new Error();
  }
 } catch { throw new MaintenanceFailure('ASSET_MISMATCH', 'preflight'); }
}
export function quiescenceSql(database, roles) {
 if (!database || roles.length !== 4 || roles.some(role=>typeof role !== 'string' || !role)) throw new Error('Maintenance database authority is missing');
 return 'SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE datname=' + literal(database)
  + ' AND usename IN (' + roles.map(literal).join(',') + ') AND pid<>pg_catalog.pg_backend_pid()';
}
export function assertQuiescence(count) {
 if (count !== '0') throw new MaintenanceFailure('ACTIVE_WRITERS', 'quiescence');
}
export function bindingPreflightSql(environment, ownerRole = environment.PGUSER) {
 const schema=environment.CONTINUUM_APPLICATION_SCHEMA;
 const admin=environment.CONTINUUM_ADMIN_PRINCIPAL_ID,sync=environment.CONTINUUM_SYNC_PRINCIPAL_ID;
 if(typeof schema !== 'string' || !schema || !/^[a-f0-9-]{36}$/i.test(admin ?? '') || !/^[a-f0-9-]{36}$/i.test(sync ?? '')) throw new MaintenanceFailure('BINDING_INELIGIBLE','preflight');
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='5000'; SET LOCAL lock_timeout='2000';
 SET LOCAL search_path="${schema.replaceAll('"','""')}";
 DO $bindings$ DECLARE i RECORD; BEGIN
 IF session_user <> ${literal(ownerRole)} OR current_user <> ${literal(ownerRole)}
 OR current_user::pg_catalog.regrole::oid <> (SELECT relowner FROM pg_catalog.pg_class WHERE oid='principals'::pg_catalog.regclass)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
 RAISE EXCEPTION 'eligibility requires the direct non-superuser migration owner'; END IF;
 SELECT ${literal(environment.CONTINUUM_OPERATOR_ROLE)}::text AS operator_role,
 ${literal(environment.CONTINUUM_SYNC_ROLE)}::text AS sync_role,${literal(admin)}::uuid AS admin_id,${literal(sync)}::uuid AS sync_id INTO i;
 IF NOT EXISTS (SELECT 1 FROM continuum_trusted_database_identities identity JOIN pg_roles role ON role.oid=identity.database_role_oid
   WHERE identity.database_role::text=i.operator_role AND role.rolname::text=i.operator_role
   AND identity.principal_id=i.admin_id AND identity.can_approve AND NOT identity.can_sync)
 OR NOT EXISTS (SELECT 1 FROM continuum_trusted_database_identities identity JOIN pg_roles role ON role.oid=identity.database_role_oid
   WHERE identity.database_role::text=i.sync_role AND role.rolname::text=i.sync_role
   AND identity.principal_id=i.sync_id AND identity.can_sync AND NOT identity.can_approve)
 OR (SELECT count(*) FROM continuum_trusted_database_identities WHERE can_sync)<>1 THEN
 RAISE EXCEPTION 'upgrade role binding does not match stored identity'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principals principal JOIN scope_memberships membership ON membership.principal_id = principal.id
    WHERE principal.id = i.admin_id AND principal.kind = 'user' AND principal.disabled_at IS NULL
      AND membership.scope_id = continuum_org_scope_id() AND membership.source_kind = 'manual'
      AND membership.source_id = 'manual' AND membership.role = 'admin' AND membership.active
  ) THEN RAISE EXCEPTION 'role binding is ineligible: operator identity must be an effective manual org administrator'; END IF;
  IF NOT EXISTS (SELECT 1 FROM principals principal WHERE principal.id = i.sync_id
    AND principal.kind = 'service' AND principal.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'role binding is ineligible: sync identity must be an enabled service principal';
  END IF;
  IF EXISTS (SELECT 1 FROM continuum_unresolved_retired_sync_database_identities
    WHERE database_role IN (i.operator_role::name,i.sync_role::name) AND resolution_kind = 'restore_pending')
    OR EXISTS (SELECT 1 FROM continuum_retired_sync_database_identities
      WHERE database_role_oid IN (SELECT oid FROM pg_roles WHERE rolname IN (i.operator_role,i.sync_role)))
    OR EXISTS (SELECT 1 FROM continuum_unresolved_retired_sync_database_identities
      WHERE previous_database_role_oid IN (SELECT oid FROM pg_roles WHERE rolname IN (i.operator_role,i.sync_role))
        AND cluster_epoch = (SELECT epoch FROM continuum_database_identity_epoch WHERE singleton)) THEN
    RAISE EXCEPTION 'role binding is ineligible: retired identity requires reviewed recovery';
  END IF;
  BEGIN
    PERFORM continuum_validate_trusted_database_role(i.sync_role::name,'sync',EXISTS(
      SELECT 1 FROM continuum_trusted_database_identities WHERE database_role = i.sync_role::name
        AND principal_id = i.sync_id AND can_sync AND NOT can_approve));
    IF NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = i.sync_role) THEN RAISE EXCEPTION 'sync role is not LOGIN-capable'; END IF;
    PERFORM continuum_require_sync_retirement_authority((SELECT oid FROM pg_roles WHERE rolname = i.sync_role));
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'role binding is ineligible: sync installation prerequisites require reviewed recovery';
  END;
 END $bindings$; COMMIT;`;
}
function imageAssetManifest(image, project) {
 const token = randomBytes(12).toString('hex'), name = project + '-assets-' + token;
 const script = "import {openSync,closeSync,readSync,lstatSync,readdirSync} from 'node:fs';import {createHash} from 'node:crypto';import {resolve,join} from 'node:path';"
  + hashFile.toString() + runtimeAssetManifest.toString() + ";process.stdout.write(JSON.stringify(runtimeAssetManifest('/opt/continuum')));";
 try {
  return JSON.parse(docker(['run','--rm','--pull','never','--name',name,'--label','io.continuum.maintenance.probe=' + token,
   '--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges:true',
   '--pids-limit','32','--memory','128m','--cpus','1','--entrypoint','node',image,'--input-type=module','-e',script],30000).stdout);
 } catch {
  const id = docker(['ps','-aq','--filter','name=^/' + name + '$']).stdout.trim();
  if (id) {
   const container = JSON.parse(docker(['inspect',id]).stdout)[0];
   if (container.Name !== '/' + name || container.Config.Labels['io.continuum.maintenance.probe'] !== token) throw new MaintenanceFailure('OWNERSHIP_MISMATCH', 'preflight');
   docker(['stop','--time','5',id],10000);
   if (docker(['ps','-aq','--filter','name=^/' + name + '$']).stdout.trim()) docker(['rm',id]);
  }
  throw new MaintenanceFailure('ASSET_MISMATCH', 'preflight');
 }
}
function assertVolumeOwnership(volume, project, projectIds) {
 try {
  const record = JSON.parse(docker(['volume','inspect',volume]).stdout);
  if (record.length !== 1 || record[0].Name !== volume || record[0].Labels?.['com.docker.compose.project'] !== project) throw new Error();
  const consumers = docker(['ps','-aq','--filter',`volume=${volume}`]).stdout.trim().split(/\s+/).filter(Boolean);
  let livePostgres = 0;
  for (const id of consumers) {
   const records = JSON.parse(docker(['inspect',id]).stdout), container = records[0];
   if (records.length !== 1 || container.Config?.Labels?.['com.docker.compose.project'] !== project
    || !container.Mounts?.some(mount=>mount.Type === 'volume' && mount.Name === volume)) throw new Error();
   if (container.State?.Running) {
    if (container.Config.Labels['com.docker.compose.service'] !== 'postgres'
     || container.Config.Labels['com.docker.compose.oneoff']?.toLowerCase() === 'true'
     || !projectIds.includes(id) || ++livePostgres > 1) throw new Error();
   }
  }
 } catch { throw new MaintenanceFailure('VOLUME_OWNERSHIP_MISMATCH','preflight'); }
}
function assertRunningPostgres(ids,project,imageId,volume) {
 try {
  const running=[];
  for(const id of ids) {
   const container=JSON.parse(docker(['inspect',id]).stdout)[0];
   if(container.Config?.Labels?.['com.docker.compose.project']!==project) throw new Error();
   if(container.Config.Labels['com.docker.compose.service']==='postgres' && container.State?.Running===true) running.push(container);
  }
  if(running.length!==1 || running[0].Config.Labels['com.docker.compose.oneoff']?.toLowerCase()==='true'
   || running[0].Image!==imageId || !running[0].Mounts?.some(mount=>mount.Type==='volume'&&mount.Name===volume)) throw new Error();
 } catch {throw new MaintenanceFailure('PG_IMAGE_MISMATCH','preflight');}
}
function assertCanonicalCompose(file, assets) {
 try {
  if (resolve(file) !== join(resolve(assets),'deploy','compose.production.yml') || !lstatSync(resolve(file)).isFile()) throw new Error();
 } catch { throw new MaintenanceFailure('ASSET_MISMATCH','preflight'); }
}
export function runMaintenance(mode, envFile, composeFile, options = {}) {
 const {deadlineMs,backupDeadlineMs} = maintenanceBudgets(options);
 if (!['fresh', 'upgrade'].includes(mode)) throw new Error('Invalid maintenance request');
 const compose = ['compose', '--ansi', 'never', '--env-file', resolve(envFile), '-f', resolve(composeFile),
  '--profile', 'maintenance', '--profile', 'serving'];
 const readConfig = () => JSON.parse(docker([...compose, 'config', '--format', 'json']).stdout);
 const config = readConfig();
 validateTmpfsMounts(config.services);
 if (!config.services?.api || !config.services?.migrate || !config.services?.postgres || !config.volumes?.pgdata) {
  throw new Error('Production configuration is missing maintenance or serving services');
 }
 const project = config.name, volume = config.volumes.pgdata.name;
 const appImage = config.services.api.image, pgImage = config.services.postgres.image;
 const immutable = /^(sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/;
 if (!/^[a-z0-9][a-z0-9_-]+$/.test(project) || !/^[a-z0-9][a-z0-9_.-]+$/.test(volume)
  || !immutable.test(appImage) || !immutable.test(pgImage)) throw new Error('Unique project/volume and immutable images are required');
 const lock=acquireMaintenanceLock(project);let outerError,evidence,secrets=[],selectedId,activePhase='preflight',successful=false;
 try {
 const imported = JSON.parse(docker(['image', 'inspect', appImage]).stdout)[0];
 const pg = JSON.parse(docker(['image', 'inspect', pgImage]).stdout)[0];
 if (imported.Os !== 'linux' || imported.Architecture !== 'amd64'
  || pg.Os !== 'linux' || pg.Architecture !== 'amd64') throw new Error('Unsupported image platform');
 selectedId = imported.Id;
 if (config.services.api.environment.CONTINUUM_AUTH_MODE !== 'entra') throw new Error('Production serving requires Entra authentication');
 const existing = docker(['volume', 'ls', '--format', '{{.Name}}']).stdout.split(/\r?\n/).includes(volume);
 if (mode === 'fresh' && existing) throw new Error('Fresh installation refuses an existing volume');
 if (mode === 'upgrade' && !existing) throw new Error('Upgrade requires the retained installation volume');
 const ids = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim().split(/\s+/).filter(Boolean);
 if (mode === 'fresh' && ids.length) throw new Error('Fresh installation refuses an existing project');
 if (mode === 'upgrade') {assertVolumeOwnership(volume,project,ids);assertRunningPostgres(ids,project,pg.Id,volume);}
 if (mode === 'upgrade' && process.env.CONTINUUM_QUIESCENCE_CONFIRMED !== 'yes') throw new Error('Confirm external writers, schedulers and callback workers are stopped');
 const ownerRole = config.services.migrate.environment.CONTINUUM_MIGRATION_OWNER_ROLE
  ?? config.services.grant?.environment.PGUSER;
 const database = config.services.postgres.environment.POSTGRES_DB;
 if (!ownerRole || !database) throw new Error('Maintenance database authority is missing');
 const roles = [ownerRole,...['CONTINUUM_APP_ROLE','CONTINUUM_OPERATOR_ROLE','CONTINUUM_SYNC_ROLE'].map(key=>config.services.grant?.environment[key])];
 const activitySql = quiescenceSql(database,roles);
 const assets = config.services.grant?.volumes?.find(mount=>mount.target === '/assets')?.source;
 if (!assets || config.services.migrate.image !== appImage || ['bootstrap','provision-admin','grant'].some(name=>config.services[name]?.image !== pgImage)) throw new MaintenanceFailure('ASSET_MISMATCH','preflight');
 assertCanonicalCompose(composeFile,assets);
 assertAssetMounts(config.services,assets);
 const dbaRole=config.services.postgres.environment.POSTGRES_USER;
 if (!dbaRole) throw new MaintenanceFailure('BINDING_INELIGIBLE','preflight');
 const applicationName=prefix=>`ctm-${prefix}-${randomBytes(12).toString('hex')}`;
 const rawDbaSql=(sql,name,timeout=15000)=>docker([...compose,'exec','-T','-e',`PGAPPNAME=${name}`,'postgres','/bin/sh','-ec',
  'export PGPASSWORD="$(cat /run/secrets/dba_password)" PGCONNECT_TIMEOUT=5 PGOPTIONS="-c search_path=pg_catalog,pg_temp -c statement_timeout=5000 -c lock_timeout=2000"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"','--',sql],timeout).stdout.trim();
 const settleBackend=(name,role,phase)=>{
  try {
  const predicate=`application_name=${literal(name)} AND usename=${literal(role)} AND datname=${literal(database)} AND pid<>pg_catalog.pg_backend_pid()`;
  const end=Date.now()+10000;
  for(let attempts=0;attempts<10 && Date.now()<=end;attempts++) {
   rawDbaSql(`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE ${predicate}`,applicationName('settle'),Math.max(1,end-Date.now()));
   if(rawDbaSql(`SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE ${predicate}`,applicationName('settle'),Math.max(1,end-Date.now()))==='0') return;
  }
  throw new MaintenanceFailure('BACKEND_SETTLEMENT_FAILED',phase);
  } catch(error) {
   try {retainUnresolvedLock(lock,{applicationName:name,role,database,phase});}
   catch(marker) {lock.markerError=marker.code === 'MAINTENANCE_LOCK_OWNERSHIP_MISMATCH' ? marker.code : 'MAINTENANCE_LOCK_MARKER_FAILED';}
   throw new MaintenanceFailure('BACKEND_SETTLEMENT_FAILED',phase);
  }
 };
 const provenPreconnection=(error,jobName)=>isProvenPreconnectionFailure(error.rawOutput,{jobName,status:error.status,code:error.clientCode,signal:error.signal,timedOut:error.code==='DEADLINE_EXCEEDED'});
 const dbaSql=sql=>{
  const name=applicationName('dba');
  try {return rawDbaSql(sql,name);} catch(error) {
   if(provenPreconnection(error)) {
    const failure=new MaintenanceFailure('PREFLIGHT_UNAVAILABLE');Object.defineProperty(failure,'rawOutput',{value:error.rawOutput});throw failure;
   }
   try {settleBackend(name,dbaRole,'settlement');} catch(failure) {error.settlementError=failure.code ?? 'BACKEND_SETTLEMENT_FAILED';}
   throw error;
  }
 };
 const cleanupOwnedJob=name=>{
  const id=docker(['ps','-aq','--filter',`name=^/${name}$`]).stdout.trim();
  if(!id)return;
  const container=JSON.parse(docker(['inspect',id]).stdout)[0];
  if(container.Name!==`/${name}` || container.Config?.Labels?.['com.docker.compose.project']!==project)throw new MaintenanceFailure('OWNERSHIP_MISMATCH');
  if(container.State?.Running)docker(['stop','--time','10',id],20000);
  if(docker(['ps','-aq','--filter',`name=^/${name}$`]).stdout.trim())docker(['rm',id]);
 };
 const ownerEligibility=phase=>{
  const sessionName=applicationName('eligibility'),name=`${project}-maintenance-eligibility-${randomBytes(12).toString('hex')}`;
  const script='export PGPASSWORD="$(cat /run/secrets/owner_password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=terse -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c "$1"';
  try {
   if(config.services.grant.environment.PGUSER!==ownerRole)throw new MaintenanceFailure('BINDING_INELIGIBLE',phase);
   docker([...compose,'run','--rm','--no-deps','--pull','never','--name',name,'-e',`PGAPPNAME=${sessionName}`,'--entrypoint','/bin/sh','grant','-ec',script,'--',bindingPreflightSql(config.services.grant.environment,ownerRole)],15000);
   cleanupOwnedJob(name);
   const predicate=`application_name=${literal(sessionName)} AND usename=${literal(ownerRole)} AND datname=${literal(database)} AND pid<>pg_catalog.pg_backend_pid()`;
   if(dbaSql(`SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE ${predicate}`)!=='0')throw new MaintenanceFailure('BACKEND_SETTLEMENT_FAILED',phase);
  } catch(error) {
   const noSession=provenPreconnection(error,name);
   const failed=new MaintenanceFailure(noSession?'PREFLIGHT_UNAVAILABLE':error.code ?? 'COMMAND_FAILED',phase);
   Object.defineProperty(failed,'rawOutput',{value:error.rawOutput ?? 'Error: '+error.message});
   for(const key of ['settlementError','cleanupError','lockError'])if(error[key])failed[key]=error[key];
   try {cleanupOwnedJob(name);}catch(cleanup) {
    failed.cleanupError='JOB_CLEANUP_UNRESOLVED';
    try {retainUnresolvedLock(lock,{applicationName:sessionName,role:ownerRole,database,phase,jobName:name},'JOB_CLEANUP_UNRESOLVED');}
    catch(marker) {lock.markerError=marker.code === 'MAINTENANCE_LOCK_OWNERSHIP_MISMATCH' ? marker.code : 'MAINTENANCE_LOCK_MARKER_FAILED';}
   }
   if(!noSession) {
    try {settleBackend(sessionName,ownerRole,phase);}catch(failure) {failed.settlementError='BACKEND_SETTLEMENT_FAILED';}
   }
   throw failed;
  }
 };
 if(mode === 'upgrade') ownerEligibility('preflight');
 assertRuntimeAssets(assets,imageAssetManifest(selectedId,project));
 // Reserve redacted private failure evidence before any downtime.
 secrets = collectSecretValues(config);
 evidence = reserveEvidence(process.env.CONTINUUM_MAINTENANCE_EVIDENCE_DIR ?? dirname(mode === 'upgrade' ? process.env.CONTINUUM_BACKUP_FILE ?? envFile : envFile));
 let backups = [],runError;
 try {
  backups = mode === 'upgrade' ? reserveBackupTargets(process.env.CONTINUUM_BACKUP_FILE) : [];
  for (const id of ids) {
   const container = JSON.parse(docker(['inspect', id]).stdout)[0];
   if (container.Config.Labels['com.docker.compose.project'] !== project) throw new Error('Maintenance ownership mismatch');
   if (container.Config.Labels['com.docker.compose.service'] !== 'postgres') docker(['stop', '--time', '15', id], 25000);
  }
  let overallEnd;
  const phase = service => {
   activePhase = service;
   const name = `${project}-maintenance-${service}-${process.pid}`;
   const sessionName = applicationName(service === 'provision-admin' ? 'admin' : service);
   try {
    docker([...compose, 'run', '--rm', '--no-deps', '--pull', 'never', '--name', name,
     '-e', `CONTINUUM_MAINTENANCE_MODE=${mode}`, '-e', `PGAPPNAME=${sessionName}`,
     ...(service === 'migrate' ? ['-e', `CONTINUUM_CONTAINER_MAINTENANCE_NAME=${sessionName}`,
      '-e', `CONTINUUM_MIGRATION_OWNER_ROLE=${ownerRole}`] : []), service], Math.max(1, overallEnd - Date.now()));
   } catch (error) {
    const failed = new MaintenanceFailure(error.code ?? 'COMMAND_FAILED', service);
    Object.defineProperty(failed,'rawOutput',{value:error.rawOutput ?? 'Error: ' + error.message});
    try {
     const id = docker(['ps', '-aq', '--filter', `name=^/${name}$`]).stdout.trim();
     if (id) {
      const container = JSON.parse(docker(['inspect', id]).stdout)[0];
      if (container.Config.Labels['com.docker.compose.project'] !== project || container.Name !== `/${name}`) throw new MaintenanceFailure('OWNERSHIP_MISMATCH',service);
      docker(['stop', '--time', '10', id], 20000);
      if (docker(['ps', '-aq', '--filter', `name=^/${name}$`]).stdout.trim()) docker(['rm', id]);
     }
    } catch(cleanup) {
     failed.cleanupError='JOB_CLEANUP_UNRESOLVED';
     try {retainUnresolvedLock(lock,{applicationName:sessionName,role:service === 'bootstrap' ? dbaRole : ownerRole,database,phase:service,jobName:name},'JOB_CLEANUP_UNRESOLVED');}
     catch(marker) {lock.markerError=marker.code === 'MAINTENANCE_LOCK_OWNERSHIP_MISMATCH' ? marker.code : 'MAINTENANCE_LOCK_MARKER_FAILED';}
    }
    // Settlement runs even when client/container cleanup itself failed.
    try {settleBackend(sessionName,service === 'bootstrap' ? dbaRole : ownerRole,service);}
    catch(failure) {failed.settlementError=failure.code ?? 'BACKEND_SETTLEMENT_FAILED';}
    throw failed;
   }
  };
  if(mode === 'fresh') docker([...compose, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '120', 'postgres'], 150000);
  assertQuiescence(dbaSql(activitySql));
  if (mode === 'fresh') { overallEnd = Date.now() + deadlineMs; phase('bootstrap'); }
  if (mode === 'upgrade') {
   const backupEnd = Date.now() + backupDeadlineMs;
   for (const [index, tool] of ['pg_dump -Fc --lock-wait-timeout=5000', 'pg_dumpall --roles-only --no-role-passwords -l "$POSTGRES_DB"'].entries()) {
    const backupName=applicationName('backup');
    const result = spawnSync('docker', [...compose, 'exec', '-T', '-e', `PGAPPNAME=${backupName}`, 'postgres', '/bin/sh', '-ec',
     `export PGPASSWORD="$(cat /run/secrets/dba_password)"; exec ${tool} -U "$POSTGRES_USER"${index === 0 ? ' -d "$POSTGRES_DB"' : ''}`],
     { stdio: ['ignore', backups[index].fd, 'pipe'], timeout: Math.max(1, backupEnd - Date.now()), killSignal: 'SIGKILL', env: dockerEnvironment() });
    if (result.error || result.status !== 0) {
     const failure = new MaintenanceFailure('BACKUP_FAILED','backup');
     failure.deadlineExceeded=result.error?.code === 'ETIMEDOUT';
     Object.defineProperty(failure,'rawOutput',{value:result.stderr?.toString('utf8') ?? 'Error: Backup command failed'});
     try {settleBackend(backupName,dbaRole,'backup');} catch(error) {failure.settlementError=error.code ?? 'BACKEND_SETTLEMENT_FAILED';}
     throw failure;
    }
   }
   activePhase='backup';durableBackupOutputs(backups);
   overallEnd = Date.now() + deadlineMs;
  }
  activePhase='quiescence';
  assertQuiescence(dbaSql(activitySql));
  if(mode === 'upgrade') {
   ownerEligibility('quiescence');
  }
  phase('migrate');
  if (mode === 'fresh') phase('provision-admin');
  phase('grant');
  if (readConfig().services.api.image !== appImage || JSON.parse(docker(['image', 'inspect', appImage]).stdout)[0].Id !== selectedId) throw new Error('Selected image changed during maintenance');
  activePhase = 'api';
  try {
   docker([...compose, 'up', '-d', '--pull', 'never', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '60', 'api'], 90000);
  } catch (error) {
   let logs = '';
   try { logs = docker([...compose,'logs','--no-color','--tail','100','api'],10000).stdout; } catch { /* Keep original failure. */ }
   const failure = new MaintenanceFailure(error.code ?? 'COMMAND_FAILED','api');
   Object.defineProperty(failure,'rawOutput',{value:(error.rawOutput ?? '') + '\n' + logs});
   try {docker([...compose, 'stop', '--timeout', '15', 'api'], 25000);}
   catch(cleanup) {failure.cleanupError=cleanup.code ?? 'COMMAND_FAILED';}
   throw failure;
  }
  successful=true;
  return { imageId: selectedId, mode, project, volume, deadlineMs, backupDeadlineMs };
 } catch (error) {
  runError=error;throw error;
 } finally {
  try {for (const item of backups) closeSync(item.fd);}
  catch(error) {if(runError) runError.cleanupError='COMMAND_FAILED';else throw error;}
 }
 } catch(error) {outerError=error;throw error;}
 finally {
  try {
   if(lock.retain) {
    if(outerError) {outerError.lockRetained=true;if(lock.markerError)outerError.lockError=lock.markerError;}
    closeSync(lock.fd);lock.fd=null;
   } else releaseMaintenanceLock(lock);
  } catch(error) {if(outerError) outerError.lockError=error.code ?? 'MAINTENANCE_LOCK_RELEASE_FAILED';else outerError=new MaintenanceFailure(error.code ?? 'MAINTENANCE_LOCK_RELEASE_FAILED');}
  if(outerError && evidence) {
   try {outerError.evidencePath=writeFailureEvidence(evidence,{phase:outerError.phase || activePhase,code:outerError.code ?? 'COMMAND_FAILED',image:selectedId,mode,deadlineMs,backupDeadlineMs,lockRetained:outerError.lockRetained,...safeMaintenanceSideErrors(outerError)},outerError.rawOutput ?? 'Error: '+outerError.message,secrets);}
   catch(error) {outerError.evidenceError='EVIDENCE_WRITE_FAILED';}
  }
  try {closeEvidence(evidence,successful && !outerError);}
  catch(error) {if(outerError)outerError.evidenceCloseError='EVIDENCE_CLOSE_FAILED';else outerError=new MaintenanceFailure('EVIDENCE_CLOSE_FAILED');}
  // A cleanup-only failure must be surfaced on an otherwise successful window.
  if(outerError && successful) throw outerError;
 }

}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 try {
  const [mode, envFile, composeFile] = process.argv.slice(2);
  if (!envFile || !composeFile) throw new Error('Usage: container-maintenance.mjs fresh|upgrade env-file compose-file');
  process.stdout.write(`${JSON.stringify(runMaintenance(mode, envFile, composeFile))}\n`);
 } catch (error) { process.stderr.write(`continuum-maintenance: ${formatMaintenanceFailure(error)}\n`); process.exitCode = 1; }
}
