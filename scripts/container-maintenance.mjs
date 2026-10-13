import { spawnSync } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function docker(args, timeout = 60000, allowedFailure = false) {
 const result = spawnSync('docker', args, { encoding: 'utf8', timeout,
  killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
 if (result.error || (result.status !== 0 && !allowedFailure)) {
  throw new Error(`Container maintenance command failed: ${args[0]}`);
 }
 return result;
}
export function runMaintenance(mode, envFile, composeFile, { deadlineMs = 900000 } = {}) {
 if (!['fresh', 'upgrade'].includes(mode) || !Number.isSafeInteger(deadlineMs)
  || deadlineMs < 1000 || deadlineMs > 900000) throw new Error('Invalid maintenance request');
 const compose = ['compose', '--env-file', resolve(envFile), '-f', resolve(composeFile)];
 const config = JSON.parse(docker([...compose, 'config', '--format', 'json']).stdout);
 const project = config.name;
 const volume = config.volumes.pgdata.name;
 const appImage = config.services.api.image;
 const pgImage = config.services.postgres.image;
 if (!/^(sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(pgImage)) throw new Error('Immutable database image required');
 docker(['image', 'inspect', pgImage]);
 if (!/^[a-z0-9][a-z0-9_-]+$/.test(project)
  || !/^[a-z0-9][a-z0-9_.-]+$/.test(volume)
  || !/^(sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(appImage)) {
  throw new Error('Unique project, volume and immutable image are required');
 }
 // No build or pull is allowed here. Import the already verified artifact first.
 const imported = JSON.parse(docker(['image', 'inspect', appImage]).stdout)[0];
 if (imported.Os !== 'linux' || imported.Architecture !== 'amd64') throw new Error('Unsupported image platform');
 const selectedId = imported.Id;
 if (config.services.api.environment.CONTINUUM_AUTH_MODE !== 'entra') throw new Error('Production serving requires Entra authentication');
 const existing = docker(['volume', 'ls', '--format', '{{.Name}}']).stdout.split(/\r?\n/).includes(volume);
 if (mode === 'fresh' && existing) throw new Error('Fresh installation refuses an existing volume');
 if (mode === 'upgrade' && !existing) throw new Error('Upgrade requires the retained installation volume');
 const ids = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])
  .stdout.trim().split(/\s+/).filter(Boolean);
 if (mode === 'fresh' && ids.length) throw new Error('Fresh installation refuses an existing project');
 if (mode === 'upgrade' && process.env.CONTINUUM_QUIESCENCE_CONFIRMED !== 'yes') {
  throw new Error('Confirm external writers, schedulers and callback workers are stopped');
 }
 for (const id of ids) {
  const container = JSON.parse(docker(['inspect', id]).stdout)[0];
  if (container.Config.Labels['com.docker.compose.service'] !== 'postgres') {
   docker(['stop', '--time', '15', id], 25000);
  }
 }
 const overallEnd = Date.now() + deadlineMs;
 const phase = service => {
  const name = `${project}-maintenance-${service}-${process.pid}`;
  try {
   docker([...compose, '--profile', 'maintenance', 'run', '--rm', '--no-deps',
    '--pull', 'never', '--name', name, service], Math.max(1, overallEnd - Date.now()));
  } catch (error) {
   // Killing a Compose client does not kill its one-shot container.
   const inspection = docker(['ps', '-aq', '--filter', `name=^/${name}$`]).stdout.trim();
   if (inspection) {
    const container = JSON.parse(docker(['inspect', inspection]).stdout)[0];
    if (container.Config.Labels['com.docker.compose.project'] !== project
     || container.Name !== `/${name}`) throw new Error('Maintenance ownership mismatch');
    docker(['stop', '--time', '10', inspection], 20000);
    docker(['rm', inspection]);
   }
   throw error;
  }
 };
 docker([...compose, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '120', 'postgres'], 150000);
 if (mode === 'fresh') phase('bootstrap');
 if (mode === 'upgrade') {
  if (!process.env.CONTINUUM_BACKUP_FILE) throw new Error('Upgrade requires a new backup output path');
  // The backup uses the DBA identity through its private mounted password file.
  const backup = resolve(process.env.CONTINUUM_BACKUP_FILE);

  if (existsSync(backup)) throw new Error('Refusing to overwrite an existing backup');
  const fd = openSync(backup, 'wx', 0o600);
  try {
   const result = spawnSync('docker', [...compose, 'exec', '-T', 'postgres', '/bin/sh', '-ec',
    'export PGPASSWORD="$(cat /run/secrets/dba_password)"; exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
    { stdio: ['ignore', fd, 'pipe'], timeout: Math.max(1, overallEnd - Date.now()), killSignal: 'SIGKILL' });
   if (result.error || result.status !== 0) throw new Error('Upgrade backup failed; retain installation stopped');
  } finally { closeSync(fd); }
  const rolesFd = openSync(`${backup}.roles.sql`, 'wx', 0o600);
  try {
   const result = spawnSync('docker', [...compose, 'exec', '-T', 'postgres', '/bin/sh', '-ec',
    'export PGPASSWORD="$(cat /run/secrets/dba_password)"; exec pg_dumpall --roles-only -U "$POSTGRES_USER"'],
    { stdio: ['ignore', rolesFd, 'pipe'], timeout: Math.max(1, overallEnd - Date.now()), killSignal: 'SIGKILL' });
   if (result.error || result.status !== 0) throw new Error('Role backup failed; retain installation stopped');
  } finally { closeSync(rolesFd); }
  const sums = [backup, `${backup}.roles.sql`].map(file =>
   `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${file}`).join('\n');
  writeFileSync(`${backup}.sha256`, `${sums}\n`, { flag: 'wx', mode: 0o600 });
 }
 phase('migrate');
 if (mode === 'fresh') phase('provision-admin');
 phase('grant');
 if (Date.now() >= overallEnd) throw new Error('Maintenance deadline exceeded; application remains stopped');
 const stillSelected = JSON.parse(docker([...compose, 'config', '--format', 'json']).stdout).services.api.image;
 if (stillSelected !== appImage || JSON.parse(docker(['image', 'inspect', appImage]).stdout)[0].Id !== selectedId) {
  throw new Error('Selected image changed during maintenance');
 }
 // Force a new container: an old exited job is never a readiness receipt.
 try {
  docker([...compose, '--profile', 'serving', 'up', '-d', '--pull', 'never', '--no-deps',
   '--force-recreate', '--wait', '--wait-timeout', '60', 'api'], 90000);
 } catch (error) { docker([...compose, 'stop', '--timeout', '15', 'api'], 25000); throw error; }
 return { imageId: selectedId, mode, project, volume };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 try {
  const [mode, envFile, composeFile] = process.argv.slice(2);
  if (!envFile || !composeFile) throw new Error('Usage: container-maintenance.mjs fresh|upgrade env-file compose-file');
  process.stdout.write(`${JSON.stringify(runMaintenance(mode, envFile, composeFile))}\n`);
 } catch (error) { process.stderr.write(`continuum-maintenance: ${error.message}\n`); process.exitCode = 1; }
}


