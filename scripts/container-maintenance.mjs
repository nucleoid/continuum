import { spawnSync } from 'node:child_process';
import { existsSync, openSync, closeSync, readSync, writeSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTmpfsMounts } from './container-compose-model.mjs';

export class MaintenanceFailure extends Error {
 constructor(code, phase = '') { super(`Container maintenance ${phase ? `${phase}: ` : ''}${code}`); this.code = code; this.phase = phase; }
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
function hashFile(file) {
 const fd = openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(65536);
 try {
  for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; hash.update(buffer.subarray(0, n)); }
  return hash.digest('hex');
 } finally { closeSync(fd); }
}
function docker(args, timeout = 60000) {
 const result = spawnSync('docker', args, { encoding: 'utf8', timeout,
  killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
 if (result.error || result.status !== 0) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const code = result.error?.code === 'ETIMEDOUT' ? 'DEADLINE_EXCEEDED'
   : output.includes('upgrade role binding does not match stored identity') ? 'BINDING_MISMATCH'
   : output.includes('non-owner application role') ? 'INVALID_APPLICATION_ROLE'
   : 'COMMAND_FAILED';
  throw new MaintenanceFailure(code);
 }
 return result;
}
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
export function runMaintenance(mode, envFile, composeFile, { deadlineMs = 900000 } = {}) {
 if (!['fresh', 'upgrade'].includes(mode) || !Number.isSafeInteger(deadlineMs)
  || deadlineMs < 1000 || deadlineMs > 900000) throw new Error('Invalid maintenance request');
 const compose = ['compose', '--env-file', resolve(envFile), '-f', resolve(composeFile),
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
 const imported = JSON.parse(docker(['image', 'inspect', appImage]).stdout)[0];
 const pg = JSON.parse(docker(['image', 'inspect', pgImage]).stdout)[0];
 if (imported.Os !== 'linux' || imported.Architecture !== 'amd64'
  || pg.Os !== 'linux' || pg.Architecture !== 'amd64') throw new Error('Unsupported image platform');
 const selectedId = imported.Id;
 if (config.services.api.environment.CONTINUUM_AUTH_MODE !== 'entra') throw new Error('Production serving requires Entra authentication');
 const existing = docker(['volume', 'ls', '--format', '{{.Name}}']).stdout.split(/\r?\n/).includes(volume);
 if (mode === 'fresh' && existing) throw new Error('Fresh installation refuses an existing volume');
 if (mode === 'upgrade' && !existing) throw new Error('Upgrade requires the retained installation volume');
 const ids = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim().split(/\s+/).filter(Boolean);
 if (mode === 'fresh' && ids.length) throw new Error('Fresh installation refuses an existing project');
 if (mode === 'upgrade' && process.env.CONTINUUM_QUIESCENCE_CONFIRMED !== 'yes') throw new Error('Confirm external writers, schedulers and callback workers are stopped');
 const ownerRole = config.services.migrate.environment.CONTINUUM_MIGRATION_OWNER_ROLE
  ?? config.services.grant?.environment.PGUSER;
 const database = config.services.postgres.environment.POSTGRES_DB;
 if (!ownerRole || !database) throw new Error('Maintenance database authority is missing');
 // Reserve all outputs before taking any serving process down. Never overwrite.
 const backups = mode === 'upgrade' ? reserveBackupTargets(process.env.CONTINUUM_BACKUP_FILE) : [];
 try {
  for (const id of ids) {
   const container = JSON.parse(docker(['inspect', id]).stdout)[0];
   if (container.Config.Labels['com.docker.compose.project'] !== project) throw new Error('Maintenance ownership mismatch');
   if (container.Config.Labels['com.docker.compose.service'] !== 'postgres') docker(['stop', '--time', '15', id], 25000);
  }
  const overallEnd = Date.now() + deadlineMs;
  const dbaSql = sql => docker([...compose, 'exec', '-T', 'postgres', '/bin/sh', '-ec',
   'export PGPASSWORD="$(cat /run/secrets/dba_password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', '--', sql], 10000).stdout.trim();
  const settleMigration = name => {
   const predicate = `application_name=${literal(name)} AND usename=${literal(ownerRole)} AND datname=${literal(database)} AND pid<>pg_backend_pid()`;
   const end = Date.now() + 10000;
   do {
    dbaSql(`SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE ${predicate}`);
    if (dbaSql(`SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE ${predicate}`) === '0') return;
   } while (Date.now() < end);
   throw new MaintenanceFailure('MIGRATION_BACKEND_REMAINS', 'migrate');
  };
  const phase = service => {
   const name = `${project}-maintenance-${service}-${process.pid}`;
   const applicationName = `ctm-migrate-${randomBytes(12).toString('hex')}`;
   try {
    docker([...compose, 'run', '--rm', '--no-deps', '--pull', 'never', '--name', name,
     '-e', `CONTINUUM_MAINTENANCE_MODE=${mode}`,
     ...(service === 'migrate' ? ['-e', `PGAPPNAME=${applicationName}`,
      '-e', `CONTINUUM_CONTAINER_MAINTENANCE_NAME=${applicationName}`,
      '-e', `CONTINUUM_MIGRATION_OWNER_ROLE=${ownerRole}`] : []), service], Math.max(1, overallEnd - Date.now()));
   } catch (error) {
    const id = docker(['ps', '-aq', '--filter', `name=^/${name}$`]).stdout.trim();
    if (id) {
     const container = JSON.parse(docker(['inspect', id]).stdout)[0];
     if (container.Config.Labels['com.docker.compose.project'] !== project || container.Name !== `/${name}`) throw new Error('Maintenance ownership mismatch');
     docker(['stop', '--time', '10', id], 20000);
     // --rm can remove the container as a result of stop.
     if (docker(['ps', '-aq', '--filter', `name=^/${name}$`]).stdout.trim()) docker(['rm', id]);
    }
    if (service === 'migrate') settleMigration(applicationName);
    throw new MaintenanceFailure(error.code ?? 'COMMAND_FAILED', service);
   }
  };
  docker([...compose, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '120', 'postgres'], 150000);
  if (mode === 'fresh') phase('bootstrap');
  if (mode === 'upgrade') {
   for (const [index, tool] of ['pg_dump -Fc', 'pg_dumpall --roles-only --no-role-passwords'].entries()) {
    const result = spawnSync('docker', [...compose, 'exec', '-T', 'postgres', '/bin/sh', '-ec',
     `export PGPASSWORD="$(cat /run/secrets/dba_password)"; exec ${tool} -U "$POSTGRES_USER"${index === 0 ? ' -d "$POSTGRES_DB"' : ''}`],
     { stdio: ['ignore', backups[index].fd, 'pipe'], timeout: Math.max(1, overallEnd - Date.now()), killSignal: 'SIGKILL' });
    if (result.error || result.status !== 0) throw new MaintenanceFailure('BACKUP_FAILED');
   }
   const sums = backups.slice(0, 2).map(item => `${hashFile(item.path)}  ${item.path}`).join('\n');
   writeSync(backups[2].fd, `${sums}\n`);
  }
  phase('migrate');
  if (mode === 'fresh') phase('provision-admin');
  phase('grant');
  if (Date.now() >= overallEnd) throw new MaintenanceFailure('DEADLINE_EXCEEDED');
  if (readConfig().services.api.image !== appImage || JSON.parse(docker(['image', 'inspect', appImage]).stdout)[0].Id !== selectedId) throw new Error('Selected image changed during maintenance');
  try {
   docker([...compose, 'up', '-d', '--pull', 'never', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '60', 'api'], 90000);
  } catch (error) { docker([...compose, 'stop', '--timeout', '15', 'api'], 25000); throw error; }
  return { imageId: selectedId, mode, project, volume };
 } finally { for (const item of backups) closeSync(item.fd); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 try {
  const [mode, envFile, composeFile] = process.argv.slice(2);
  if (!envFile || !composeFile) throw new Error('Usage: container-maintenance.mjs fresh|upgrade env-file compose-file');
  process.stdout.write(`${JSON.stringify(runMaintenance(mode, envFile, composeFile))}\n`);
 } catch (error) { process.stderr.write(`continuum-maintenance: ${error.message}\n`); process.exitCode = 1; }
}
