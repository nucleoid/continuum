import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const SECRET_SETTINGS = Object.freeze([
 'CONTINUUM_DATABASE_URL', 'CONTINUUM_BEARER', 'CONTINUUM_PRINCIPAL_EXTERNAL_ID',
 'CONTINUUM_TOKEN', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY',
 'CONTINUUM_ADMIN_ACTOR', 'CONTINUUM_GRAPH_ACCESS_TOKEN', 'CONTINUUM_MEMBERSHIP_SYNC_ACTOR',
 'CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID', 'CONTINUUM_EMBEDDING_CONFIG',
 ...['GITHUB_PR', 'GITHUB_BRANCH', 'ADO_WORKITEM', 'DEPLOY_EVENT', 'TERMINAL_SUMMARY']
  .flatMap(source => ['PRINCIPAL', 'DATABASE_URL', 'ACTOR_EXTERNAL_ID',
   ...(source.startsWith('GITHUB') ? ['SECRET'] : []),
   ...(source === 'ADO_WORKITEM' ? ['USERNAME', 'PASSWORD'] : [])]
   .map(setting => `CONTINUUM_INGEST_${source}_${setting}`)),
]);
const MAX_BYTES = 64 * 1024;
function failure(setting) { return new Error(`Invalid container secret setting: ${setting}`); }
function validate(value, setting) {
 if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > MAX_BYTES
  || value.includes('\0')) throw failure(setting);
 return value;
}
// The root parameter permits filesystem tests on platforms without /run/secrets.
// The executable always uses the fixed container root below.
export function loadSecretFiles(env, root = '/run/secrets') {
 const pending = new Map();
 for (const setting of SECRET_SETTINGS) {
  const fileKey = `${setting}_FILE`;
  if (env[fileKey] === undefined) {
   if (env[setting] !== undefined) validate(env[setting], setting);
   continue;
  }
  if (env[setting] !== undefined) throw failure(setting);
  let fd;
  try {
   const file = env[fileKey];
   const secretRoot = resolve(root);
   if (typeof file !== 'string' || file !== resolve(file) || dirname(file) !== secretRoot
    || !/^[A-Za-z0-9_.-]+$/.test(basename(file)) || ['.', '..'].includes(basename(file))) {
    throw failure(setting);
   }
   if (!lstatSync(file).isFile() || realpathSync(file) !== file
    || realpathSync(secretRoot) !== secretRoot) throw failure(setting);
   fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
   const stat = fstatSync(fd);
   if (!stat.isFile() || stat.size > MAX_BYTES) throw failure(setting);
   const bytes = Buffer.alloc(MAX_BYTES + 1);
   let length = 0;
   while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, null);
    if (count === 0) break;
    length += count;
   }
   if (length > MAX_BYTES) throw failure(setting);
   const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    .replace(/(?:\r\n|\n|\r)$/, '');
   pending.set(setting, validate(value, setting));
  } catch { throw failure(setting); }
  finally { if (fd !== undefined) closeSync(fd); }
 }
 for (const [setting, value] of pending) { env[setting] = value; delete env[`${setting}_FILE`]; }
}
const COMMANDS = Object.freeze({
 continuum: 'bin/continuum.mjs', 'continuum-tags': 'bin/continuum-tags.mjs',
 'continuum-migrate': 'bin/continuum-migrate.mjs',
});
const SCRIPTS = new Set([
 ...Object.values(COMMANDS), 'dist/api/server.js', 'dist/api/mcp.js',
 'dist/storage/migrate-cli.js', 'dist/identity/admin-cli.js', 'dist/identity/sync-cli.js',
 'dist/lifecycle/sweep-cli.js', 'dist/maintenance/audit-retention-cli.js',
 'dist/maintenance/embed-backfill-cli.js', 'dist/cli/tag-vocabularies.js',
]);
export function resolveCommand(args) {
 const supplied = args.length ? [...args] : ['dist/api/server.js'];
 if (supplied[0] === 'node') supplied.shift();
 const selected = Object.hasOwn(COMMANDS, supplied[0]) ? COMMANDS[supplied[0]] : supplied[0];
 if (!SCRIPTS.has(selected)) throw new Error('Unsupported container command');
 return [selected, ...supplied.slice(1)];
}
export function maintenanceDatabaseUrl(value, name, ownerRole) {
 try {
  if (!/^ctm-migrate-[a-f0-9]{24}$/.test(name)) throw new Error();
  const url = new URL(value);
  if ((ownerRole !== undefined && decodeURIComponent(url.username) !== ownerRole)
   || !['postgres:', 'postgresql:'].includes(url.protocol)
   || (url.searchParams.has('application_name') && url.searchParams.get('application_name') !== name)) throw new Error();
  url.searchParams.set('application_name', name);
  return url.href;
 } catch { throw new Error('Invalid container maintenance connection identity'); }
}
async function main() {
 loadSecretFiles(process.env);
 const [selected, ...args] = resolveCommand(process.argv.slice(2));
 if (process.env.CONTINUUM_CONTAINER_MAINTENANCE_NAME && ['bin/continuum-migrate.mjs', 'dist/storage/migrate-cli.js'].includes(selected)) {
  if (!process.env.CONTINUUM_MIGRATION_OWNER_ROLE) throw new Error('Invalid container maintenance connection identity');
  process.env.CONTINUUM_DATABASE_URL = maintenanceDatabaseUrl(process.env.CONTINUUM_DATABASE_URL, process.env.CONTINUUM_CONTAINER_MAINTENANCE_NAME, process.env.CONTINUUM_MIGRATION_OWNER_ROLE);
 }
 const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
 const target = resolve(root, selected);
 process.argv = [process.execPath, target, ...args];
 await import(pathToFileURL(target).href);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 try { await main(); }
 catch (error) {
  const safe = error.message?.startsWith('Invalid container secret setting:')
   || error.message === 'Unsupported container command'
   || error.message === 'Invalid container maintenance connection identity';
  process.stderr.write(`continuum-container: ${safe ? error.message : 'Runtime launch failed'}\n`);
  process.exitCode = 1;
 }
}
