import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, readdirSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { runMaintenance } from './container-maintenance.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') throw new Error('Hosted Linux CI required');
const output = resolve(process.argv[2]);
const image = process.env.CONTINUUM_VERIFIED_IMAGE_ID;
const owner = process.env.CONTINUUM_CI_OWNER;
const assets = process.env.CONTINUUM_RUNTIME_ASSETS;
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '') || !/^continuum-ci-[a-f0-9-]+$/.test(owner ?? '')) throw new Error('Verified smoke inputs required');
const temporary = mkdtempSync(join(tmpdir(), 'continuum-operational-'));
chmodSync(temporary, 0o755);
const results = { sourceSha: process.env.GITHUB_SHA, imageId: image, passed: [], unmet: [] };
const projects = [];
const run = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
const check = (condition, message) => { if (!condition) throw new Error(message); };
function setup(suffix) {
  const project = `${owner}-${suffix}`;
  const directory = join(temporary, suffix);
  mkdirSync(directory, { mode: 0o755 });
  const env = { ...process.env,
    COMPOSE_PROJECT_NAME: project, CONTINUUM_APP_IMAGE: image, CONTINUUM_POSTGRES_IMAGE: process.env.PG_IMAGE,
    CONTINUUM_RUNTIME_ASSETS: assets, CONTINUUM_PGDATA_VOLUME: `${project}-pgdata`,
    CONTINUUM_DATABASE: 'continuum', CONTINUUM_APPLICATION_SCHEMA: 'continuum', CONTINUUM_PROVIDER_SCHEMA: 'continuum_vector',
    CONTINUUM_DBA_ROLE: 'continuum_dba', CONTINUUM_OWNER_ROLE: 'continuum_owner', CONTINUUM_APP_ROLE: 'continuum_app',
    CONTINUUM_OPERATOR_ROLE: 'continuum_operator', CONTINUUM_SYNC_ROLE: 'continuum_sync',
    CONTINUUM_ADMIN_PRINCIPAL_ID: randomUUID(), CONTINUUM_ADMIN_ENTRA_OBJECT_ID: randomUUID(), CONTINUUM_ADMIN_DISPLAY_NAME: 'Synthetic administrator',
    CONTINUUM_SYNC_PRINCIPAL_ID: randomUUID(), CONTINUUM_SYNC_EXTERNAL_ID: 'synthetic-sync',
    CONTINUUM_ENTRA_TENANT: randomUUID(), CONTINUUM_ENTRA_AUDIENCE: 'synthetic-audience', CONTINUUM_ENTRA_USER_SCOPE: 'access',
    CONTINUUM_ENTRA_SERVICE_APP_ROLE: 'synthetic-role', CONTINUUM_ENTRA_ALLOWED_CLIENT_IDS: randomUUID(),
  };
  const passwords = Object.fromEntries(['DBA', 'OWNER', 'APP', 'OPERATOR', 'SYNC'].map(name => [name, randomBytes(32).toString('hex')]));
  function secret(name, value) {
    const file = join(directory, name.toLowerCase());
    writeFileSync(file, value, { mode: 0o444 });
    env[`CONTINUUM_${name}_FILE`] = file;
    return file;
  }
  for (const [name, value] of Object.entries(passwords)) secret(`${name}_PASSWORD`, value);
  for (const name of ['OWNER', 'APP']) secret(`${name}_DATABASE_URL`, `postgres://continuum_${name.toLowerCase()}:${passwords[name]}@postgres:5432/continuum?options=-csearch_path%3Dcontinuum`);
  const override = join(directory, 'ci.yml');
  writeFileSync(override, 'services:\n  api:\n    environment:\n      CONTINUUM_AUTH_MODE: dev\n');
  const base = ['compose', '-f', resolve(assets, 'deploy/compose.production.yml'), '-f', override, '--profile', 'maintenance', '--profile', 'serving'];
  const item = { project, directory, env, passwords, base };
  projects.push(item);
  return item;
}
const compose = (p, args, options = {}) => run([...p.base, ...args], { env: p.env, ...options });
function sql(p, statement, role = 'OWNER', options = {}) {
  // Secret values stay in environment, not command arguments or log output.
  return compose(p, ['exec', '-T', '-e', 'PGPASSWORD', 'postgres', 'psql', '-X', '-qAt', '-h', '127.0.0.1', '-U', `continuum_${role.toLowerCase()}`, '-d', 'continuum', '-v', 'ON_ERROR_STOP=1', '-c', `SET search_path TO continuum; ${statement}`], { ...options, env: { ...p.env, PGPASSWORD: p.passwords[role] } }).trim();
}
function phase(p, name, timeout = 900_000) {
  const job = `${p.project}-${name}`;
  try { compose(p, ['run', '--rm', '--name', job, name], { timeout }); }
  catch (error) {
    try {
      const info = JSON.parse(run(['inspect', job]))[0];
      check(info.Config.Labels['com.docker.compose.project'] === p.project, 'Timed-out job ownership mismatch');
      run(['stop', '-t', '10', job]);
      run(['rm', '-f', job]);
    } catch { /* A completed --rm job is already absent. */ }
    throw new Error(`${name} maintenance failed or exceeded deadline`);
  }
}
function startDatabase(p) {
  const existing = run(['volume', 'ls', '--format', '{{.Name}}']).trim().split('\n');
  check(!existing.includes(p.env.CONTINUUM_PGDATA_VOLUME), 'Fresh smoke volume already exists');
  compose(p, ['up', '-d', '--wait', '--wait-timeout', '120', 'postgres']);
  const id = compose(p, ['ps', '-q', 'postgres']).trim();
  const info = JSON.parse(run(['inspect', id]))[0];
  check(Object.keys(info.NetworkSettings.Networks).length === 1 && info.NetworkSettings.Networks[`${p.project}_backend`], 'Database attached outside private backend');
  check(!Object.values(info.NetworkSettings.Ports ?? {}).some(Boolean), 'Database publishes a host port');
  check(info.Config.User === '999:999' && info.HostConfig.Memory === 1073741824 && info.HostConfig.PidsLimit === 256, 'Database resource/UID mismatch');
}
async function api(p, path, body, expectedStatus = 200) {
  const script = `const r=await fetch('http://127.0.0.1:4000${path}',{method:${JSON.stringify(body ? 'POST' : 'GET')},headers:{authorization:'Bearer ${p.env.CONTINUUM_ADMIN_ENTRA_OBJECT_ID}','content-type':'application/json'},${body ? `body:${JSON.stringify(JSON.stringify(body))},` : ''}signal:AbortSignal.timeout(3000)});if(r.status!==${expectedStatus})throw new Error('HTTP '+r.status);console.log(JSON.stringify({body:await r.text(),etag:r.headers.get('etag')}));`;
  return JSON.parse(compose(p, ['exec', '-T', 'api', 'node', '--input-type=module', '-e', script]));
}
function verifyLedger(p) {
  const names = readdirSync(join(assets, 'migrations')).filter(file => file.endsWith('.sql')).sort();
  const recorded = sql(p, 'SELECT name FROM _continuum_migrations ORDER BY name').split('\n').filter(Boolean);
  check(JSON.stringify(recorded) === JSON.stringify(names), 'Current migration ledger is incomplete');
  check(sql(p, 'SELECT continuum_coordination_require_contract_ready()') !== undefined, 'Coordination contract incomplete');
  check(sql(p, "SELECT count(*) FROM pg_extension WHERE extname='vector'", 'DBA') === '1', 'pgvector missing');
  check(sql(p, "SELECT NOT has_schema_privilege(current_user,'continuum','CREATE')", 'APP') === 't', 'APP has schema creation authority');
}
try {
  const fresh = setup('fresh');
  startDatabase(fresh);
  for (const name of ['bootstrap', 'migrate', 'provision-admin', 'grant']) phase(fresh, name);
  verifyLedger(fresh);
  let refused = false;
  try { phase(fresh, 'bootstrap'); } catch { refused = true; }
  check(refused, 'Repeated fresh bootstrap unexpectedly succeeded');
  phase(fresh, 'migrate'); phase(fresh, 'grant');
  compose(fresh, ['up', '-d', '--wait', '--wait-timeout', '120', 'api']);
  await api(fresh, '/health/ready');
  const captured = JSON.parse((await api(fresh, '/api/v0/capture', { scope: { kind: 'org', name: '' }, type: 'decision', title: 'Synthetic immutable packaging decision', body: 'Synthetic packaging persistence evidence.', source: 'manual', tags: ['decision'] }, 201)).body);
  const recall = JSON.parse((await api(fresh, '/api/v0/recall', { query: 'packaging persistence' })).body);
  check(!captured.embedded && recall.diagnostics.vector === 'disabled' && recall.results.some(row => row.id === captured.id), 'Full-text capture/recall failed');
  await api(fresh, `/api/v0/memories/${captured.id}`);
  const bundle = await api(fresh, '/api/v0/agents-md');
  check(bundle.body.includes('Synthetic immutable packaging decision'), 'AGENTS.md lacks captured decision');
  const hash = bundle.etag.replaceAll('"', '');
  check(JSON.parse((await api(fresh, `/api/v0/agents-md/freshness?hash=${hash}`)).body).fresh, 'AGENTS.md freshness failed');
  const cli = compose(fresh, ['exec', '-T', '-e', 'CONTINUUM_API_URL=http://127.0.0.1:4000', '-e', `CONTINUUM_TOKEN=${fresh.env.CONTINUUM_ADMIN_ENTRA_OBJECT_ID}`, 'api', 'continuum', 'recall', 'packaging persistence', '--json']);
  check(cli.includes(captured.id), 'Installed authenticated CLI recall failed');
  const tags = compose(fresh, ['exec', '-T', '-e', `CONTINUUM_BEARER=${fresh.env.CONTINUUM_ADMIN_ENTRA_OBJECT_ID}`, 'api', 'continuum-tags', 'list', 'org']);
  check(tags.includes('decision'), 'Installed tags launcher failed');
  check(Number(sql(fresh, 'SELECT count(*) FROM audit_log')) >= 5, 'Transport auditing missing');
  results.passed.push('fresh non-root PostgreSQL initialization, full ledger/contract/provider checks, exact profiles, APP CREATE denial, repeated bootstrap refusal, repeated maintenance, REST/CLI/tags/AGENTS.md full-text delivery and audit');

  const mcpEnv = join(fresh.directory, 'mcp.env');
  writeFileSync(mcpEnv, `CONTINUUM_DATABASE_URL=${readFileSync(fresh.env.CONTINUUM_APP_DATABASE_URL_FILE, 'utf8')}\nCONTINUUM_AUTH_MODE=dev\nCONTINUUM_PRINCIPAL_EXTERNAL_ID=${fresh.env.CONTINUUM_ADMIN_ENTRA_OBJECT_ID}\nCONTINUUM_APPLICATION_SCHEMA=continuum\nCONTINUUM_EMBEDDING_PROVIDER=none\n`, { mode: 0o600 });
  await new Promise((resolvePromise, reject) => {
    const name = `${fresh.project}-mcp`;
    const child = spawn('docker', ['run', '--rm', '-i', '--name', name, '--label', `continuum.ci.owner=${owner}`, '--network', `${fresh.project}_backend`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--env-file', mcpEnv, image, 'node', 'dist/api/mcp.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffered = '', errors = '', settled = false;
    const timer = setTimeout(() => { run(['rm', '-f', name]); reject(new Error('MCP smoke deadline exceeded')); }, 30_000);
    child.stderr.on('data', data => { errors = (errors + data).slice(-4096); });
    child.stdout.on('data', data => {
      buffered += data;
      while (buffered.includes('\n')) {
        const end = buffered.indexOf('\n'), line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) throw new Error('MCP response failed');
          if (message.id === 1) {
            child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
            child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');
          } else if (message.id === 2) {
            check(message.result.tools.some(tool => tool.name === 'continuum.recall'), 'MCP tools/list lacks recall');
            child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'continuum.recall',arguments:{query:'packaging persistence'}}})+'\n');
          } else if (message.id === 3) {
            check(!message.result.isError && JSON.stringify(message.result).includes(captured.id), 'MCP authenticated recall failed');
            settled = true; child.stdin.end();
          }
        } catch (error) { clearTimeout(timer); child.kill(); run(['rm','-f',name]); reject(error); }
      }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (settled && code === 0 && !buffered.trim()) resolvePromise(); else reject(new Error('MCP protocol/exit check failed')); });
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'synthetic-smoke',version:'1'}}})+'\n');
  });
  results.passed.push('installed stdio MCP initialize, tools/list, authenticated recall and protocol-clean stdout');

  compose(fresh, ['stop', '-t', '15', 'api']);
  const stoppedApi = JSON.parse(run(['inspect', compose(fresh, ['ps', '-aq', 'api']).trim()]))[0];
  check(stoppedApi.State.ExitCode === 0 && !stoppedApi.State.OOMKilled, 'API SIGTERM shutdown was not orderly');
  const before = sql(fresh, `SELECT id::text || ':' || title FROM memories WHERE id='${captured.id}'`);
  phase(fresh, 'migrate'); phase(fresh, 'grant');
  compose(fresh, ['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', 'api']);
  check(sql(fresh, `SELECT id::text || ':' || title FROM memories WHERE id='${captured.id}'`) === before, 'Container replacement lost UUID/data');
  compose(fresh, ['stop', '-t', '10', 'postgres']);
  await api(fresh, '/health/ready', undefined, 503);
  compose(fresh, ['up', '-d', '--wait', '--wait-timeout', '120', 'postgres']);
  compose(fresh, ['stop', '-t', '15', 'api']);
  results.passed.push('same-image compatible replacement preserves data/UUID/ledger; SIGTERM shutdown; database outage changes readiness to 503');

  const envFile = join(fresh.directory,'maintenance.env');
  function maintenanceEnv(overrides = {}) {
    writeFileSync(envFile, Object.entries({...fresh.env,...overrides})
      .filter(([key])=> key === 'COMPOSE_PROJECT_NAME' || key.startsWith('CONTINUUM_'))
      .map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n'), {mode:0o600});
  }
  const productionCompose = resolve(assets,'deploy/compose.production.yml');
  maintenanceEnv();
  let preexistingRefused = false;
  try { runMaintenance('fresh',envFile,productionCompose); } catch(error) { preexistingRefused = error.message.includes('existing volume'); }
  check(preexistingRefused,'Fresh maintenance accepted an existing volume');
  process.env.CONTINUUM_QUIESCENCE_CONFIRMED='yes';
  process.env.CONTINUUM_BACKUP_FILE=join(temporary,'failed-upgrade.dump');
  const stale = `${fresh.project}-stale-migration`;
  run(['create','--name',stale,'--label',`com.docker.compose.project=${fresh.project}`,'--label','com.docker.compose.service=migrate',image,'continuum','--help']);
  run(['start','-a',stale]);
  check(JSON.parse(run(['inspect',stale]))[0].State.ExitCode===0,'Synthetic stale job fixture did not complete');
  maintenanceEnv({CONTINUUM_APP_ROLE:'nonexistent_synthetic_role'});
  let grantFailed = false;
  try { runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120_000}); } catch { grantFailed=true; }
  check(grantFailed,'Invalid grant phase unexpectedly succeeded');
  check(compose(fresh,['ps','--status','running','-q','api']).trim()==='', 'Failed maintenance left API serving');
  maintenanceEnv();
  process.env.CONTINUUM_BACKUP_FILE=join(temporary,'deadline-upgrade.dump');
  const timeoutCompose = join(fresh.directory,'timeout-compose.json');
  const timeoutConfig = JSON.parse(compose(fresh,['config','--format','json']));
  timeoutConfig.services.api.environment.CONTINUUM_AUTH_MODE='entra';
  const timeoutProof = join(fresh.directory,'timeout-proof');
  mkdirSync(timeoutProof,{mode:0o777}); chmodSync(timeoutProof,0o777);
  timeoutConfig.services.migrate.volumes=[...(timeoutConfig.services.migrate.volumes??[]),{type:'bind',source:timeoutProof,target:'/proof'}];
  timeoutConfig.services.migrate.entrypoint=['node','-e',"require('fs').writeFileSync('/proof/started','started');setInterval(()=>{},1000)"];
  timeoutConfig.services.migrate.command=[];
  writeFileSync(timeoutCompose,JSON.stringify(timeoutConfig),{mode:0o600});
  let deadlineFailed=false;
  try { runMaintenance('upgrade',envFile,timeoutCompose,{deadlineMs:10000}); } catch { deadlineFailed=true; }
  check(readFileSync(join(timeoutProof,'started'),'utf8')==='started','Deadline fixture never launched its migration process');
  check(deadlineFailed && compose(fresh,['ps','--status','running','-q','api']).trim()==='', 'Finite migration deadline did not keep API stopped');
  check(run(['ps','-aq','--filter',`name=^/${fresh.project}-maintenance-migrate-${process.pid}$`]).trim()==='', 'Timed-out one-shot migration remained running');
  let downgradeRefused=false;
  // Run the actual immutable packaged rollback guard, not a missing-file error.
  const guardContainer = compose(fresh,['ps','-q','postgres']).trim();
  run(['cp',join(assets,'scripts/rollback-embedding-provider-key.sql'),`${guardContainer}:/tmp/rollback-guard.sql`]);
  downgradeRefused=false;
  try { compose(fresh,['exec','-T','-e','PGPASSWORD','postgres','psql','-X','-h','127.0.0.1','-U','continuum_owner','-d','continuum','-v','ON_ERROR_STOP=1','-f','/tmp/rollback-guard.sql'],{env:{...fresh.env,PGPASSWORD:fresh.passwords.OWNER}}); } catch { downgradeRefused=true; }
  check(downgradeRefused,'Packaged in-place embedding downgrade guard did not reject');
  results.passed.push('maintenance rejects existing fresh volume; failed exact grant and synthetic hung-job deadline keep API stopped despite successful stale job; timed-out job removed; packaged in-place embedding downgrade guard rejects');

  // Backup/restore uses another isolated volume; only synthetic data and roles.
  const backup = join(temporary, 'backup.dump');
  const pgid = compose(fresh, ['ps', '-q', 'postgres']).trim();
  run(['exec', pgid, 'pg_dump', '-U', 'continuum_dba', '-d', 'continuum', '-Fc', '-f', '/tmp/backup.dump']);
  run(['cp', `${pgid}:/tmp/backup.dump`, backup]);
  const backupHash = createHash('sha256').update(readFileSync(backup)).digest('hex');
  const restored = setup('restore');
  // Deliberately restore existing reviewed identity UUIDs, with new role OIDs.
  for (const key of ['CONTINUUM_ADMIN_PRINCIPAL_ID','CONTINUUM_ADMIN_ENTRA_OBJECT_ID','CONTINUUM_SYNC_PRINCIPAL_ID']) restored.env[key] = fresh.env[key];
  startDatabase(restored);
  sql(restored, 'CREATE ROLE synthetic_oid_offset NOLOGIN', 'DBA');
  phase(restored, 'bootstrap');
  const restoreId = compose(restored, ['ps', '-q', 'postgres']).trim();
  check(createHash('sha256').update(readFileSync(backup)).digest('hex') === backupHash, 'Backup checksum mismatch');
  run(['cp', backup, `${restoreId}:/tmp/backup.dump`]);
  // Provider infrastructure is DBA-created; application schema restore retains owner.
  run(['exec', restoreId, 'pg_restore', '-U', 'continuum_dba', '-d', 'continuum', '--exit-on-error', '--clean', '--if-exists', '--schema=continuum', '/tmp/backup.dump']);
  sql(restored, "SELECT continuum_rebind_database_identity_oids('REBIND DATABASE IDENTITIES','FOREIGN OID NAMESPACE')");
  phase(restored, 'grant'); verifyLedger(restored);
  check(sql(restored, `SELECT id::text || ':' || title FROM memories WHERE id='${captured.id}'`) === before, 'Restored data/UUID differs');
  compose(restored, ['up', '-d', '--wait', '--wait-timeout', '120', 'api']);
  await api(restored, '/health/ready'); compose(restored, ['stop','-t','15','api']);
  results.passed.push(`real custom backup checksum ${backupHash}; separate-volume restore, foreign OID rebind, exact profile and readiness verification; original volume retained during restore`);

  const historical = setup('historical'); startDatabase(historical); phase(historical, 'bootstrap');
  const fixture = join(temporary, 'historical-migrations'); mkdirSync(fixture, { mode: 0o755 });
  for (const file of readdirSync(join(assets, 'migrations')).filter(file => file.endsWith('.sql') && file < '0083')) copyFileSync(join(assets,'migrations',file), join(fixture,file));
  // Current migrator enforces published checksums on this exact pre-0083 source slice.
  compose(historical, ['run','--rm','--entrypoint','node','-v',`${fixture}:/fixture:ro`,'migrate','--input-type=module','-e', "import {loadSecretFiles} from './deploy/container-entrypoint.mjs';loadSecretFiles(process.env);const {getPool,closePool}=await import('./dist/storage/pool.js');const {runMigrations}=await import('./dist/storage/migrator.js');await runMigrations(getPool(),'/fixture');await closePool();"], { timeout: 900_000 });
  phase(historical, 'provision-admin');
  const legacyId = randomUUID();
  sql(historical, `INSERT INTO memories(id,scope_id,type,title,body,tags,author_id,source) VALUES('${legacyId}',continuum_org_scope_id(),'decision','Synthetic historical packaging','Synthetic pre0083 memory',ARRAY['Decision','legacy-synthetic'],'${historical.env.CONTINUUM_ADMIN_PRINCIPAL_ID}','container-ci'); INSERT INTO memory_embeddings(memory_id,provider,dim,embedding) VALUES('${legacyId}','synthetic-fixture',768,('[1,'||repeat('0,',766)||'0]')::continuum_vector.vector);`);
  const historyPg = compose(historical, ['ps','-q','postgres']).trim();
  run(['exec',historyPg,'pg_dump','-U','continuum_dba','-d','continuum','-Fc','-f','/tmp/pre-upgrade.dump']);
  phase(historical, 'migrate'); phase(historical,'grant'); verifyLedger(historical);
  check(sql(historical, `SELECT tags::text FROM memories WHERE id='${legacyId}'`) === '{decision}', 'Historical tag normalization failed');
  check(sql(historical, `SELECT metadata->'continuum_legacy_tags' FROM memories WHERE id='${legacyId}'`).includes('legacy-synthetic'), 'Legacy tags were not quarantined');
  check(sql(historical, `SELECT provider || ':' || dim FROM memory_embeddings WHERE memory_id='${legacyId}'`) === 'synthetic-fixture:768', 'Historical vector lost');
  check(sql(historical, 'SELECT count(*) FROM memory_activity_attributions') === '0', 'Historical activity was invented');
  compose(historical,['up','-d','--wait','--wait-timeout','120','api']); await api(historical,'/health/ready');
  results.passed.push('checksum-verified synthetic pre0083 schema fixture, real pre-upgrade custom backup, exact current image migration CLI, tag quarantine, vector preservation, identity/profile/contract/Standup startup; fixture does not run a historical binary');
} catch (error) {
  results.unmet.push(error.message); process.exitCode = 1;
} finally {
  for (const p of projects.reverse()) {
    try {
      // Compose resource labels establish ownership before synthetic cleanup.
      const ids = run(['ps','-aq','--filter',`label=com.docker.compose.project=${p.project}`]).trim().split('\n').filter(Boolean);
      for (const id of ids) check(JSON.parse(run(['inspect',id]))[0].Config.Labels['com.docker.compose.project'] === p.project, 'Container cleanup ownership mismatch');
      compose(p,['down','--remove-orphans'],{timeout:120_000});
      const volume = JSON.parse(run(['volume','inspect',p.env.CONTINUUM_PGDATA_VOLUME]))[0];
      check(volume.Labels['com.docker.compose.project'] === p.project, 'Volume cleanup ownership mismatch');
      run(['volume','rm',p.env.CONTINUUM_PGDATA_VOLUME]);
    } catch(error) { results.unmet.push(`Cleanup: ${error.message}`); process.exitCode = 1; }
  }
  rmSync(temporary,{recursive:true,force:true});
  writeFileSync(join(output,'operational-results.json'),`${JSON.stringify(results,null,2)}\n`);
  process.stdout.write(`${JSON.stringify(results)}\n`);
}
