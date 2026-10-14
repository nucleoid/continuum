import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, readdirSync, copyFileSync, cpSync, rmSync, chmodSync, existsSync, statSync, openSync, closeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { runMaintenance, acquireMaintenanceLock, releaseMaintenanceLock } from './container-maintenance.mjs';
import { validateTmpfsMounts } from './container-compose-model.mjs';
import { sanitizedMaintenanceLines } from './container-maintenance-evidence.mjs';
import { writeCommandOutput, readCommandInput } from './container-binary-transfer.mjs';
import { safeBootstrapFailure, sanitizedBootstrapLines } from './container-diagnostics.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') throw new Error('Hosted Linux CI required');
const output = resolve(process.argv[2]);
const image = process.env.CONTINUUM_VERIFIED_IMAGE_ID;
const owner = process.env.CONTINUUM_CI_OWNER;
const assets = process.env.CONTINUUM_RUNTIME_ASSETS;
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '') || !/^continuum-ci-[a-f0-9-]+$/.test(owner ?? '')) throw new Error('Verified smoke inputs required');
const temporary = mkdtempSync(join(tmpdir(), 'continuum-operational-'));
chmodSync(temporary, 0o755);
const results = { sourceSha: process.env.SOURCE_SHA, imageId: image, passed: [], unmet: [] };
const projects = [];
const run = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
const check = (condition, message) => { if (!condition) throw new Error(message); };
function failureText(error) {
  return [error?.message, error?.stderr?.toString('utf8'), error?.cause?.message, error?.cause?.stderr?.toString('utf8')].filter(Boolean).join('\n');
}
function expectFailure(action, expected, label) {
  let actual;
  try { action(); } catch (error) { actual = error; }
  if(!actual||!failureText(actual).includes(expected)){
   const knownCodes=new Set(['COMMAND_FAILED','DEADLINE_EXCEEDED','BINDING_MISMATCH','BINDING_INELIGIBLE','ACTIVE_WRITERS','BACKUP_FAILED','BACKEND_SETTLEMENT_FAILED','MIGRATION_BACKEND_REMAINS','MAINTENANCE_LOCKED','ASSET_MISMATCH','VOLUME_OWNERSHIP_MISMATCH','PG_IMAGE_MISMATCH','PREFLIGHT_UNAVAILABLE']);
   const knownPhases=new Set(['preflight','backup','bootstrap','migrate','provision-admin','grant','api','settlement','quiescence']);
   const diagnostic={code:actual?(knownCodes.has(actual.code)?actual.code:'UNCLASSIFIED_FAILURE'):'NO_FAILURE',phase:knownPhases.has(actual?.phase)?actual.phase:null};
   if(actual?.evidencePath){
    try{
     const info=statSync(actual.evidencePath);check(info.isFile()&&info.size<=65536,'Private evidence is not bounded');
     const record=JSON.parse(readFileSync(actual.evidencePath,'utf8'));
     if(Array.isArray(record.lines)&&record.lines.every(line=>typeof line==='string'&&line.length<=1000))diagnostic.evidenceLines=sanitizedMaintenanceLines(record.lines.join('\n'),projects.flatMap(p=>Object.values(p.passwords))).slice(0,8);
    }catch{diagnostic.evidenceUnavailable=true;}
   }
   const mismatch=new Error(`${label}: did not receive the specific expected failure; actual=${JSON.stringify(diagnostic)}`);
   Object.defineProperty(mismatch,'actualFailure',{value:actual});throw mismatch;
  }
  return actual;
}
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
  validateTmpfsMounts(JSON.parse(compose(item, ['config', '--format', 'json'])).services);
  projects.push(item);
  return item;
}
const compose = (p, args, options = {}) => run([...p.base, ...args], { env: p.env, ...options });
function sql(p, statement, role = 'OWNER', options = {}) {
  // Secret values stay in environment, not command arguments or log output.
  return compose(p, ['exec', '-T', '-e', 'PGPASSWORD', 'postgres', 'psql', '-X', '-qAt', '-h', '127.0.0.1', '-U', `continuum_${role.toLowerCase()}`, '-d', 'continuum', '-v', 'ON_ERROR_STOP=1', '-c', `SET search_path TO continuum; ${statement}`], { ...options, env: { ...p.env, PGPASSWORD: p.passwords[role] } }).trim();
}
function bootstrapLogCanary(p) {
  const dbaStatement = statement => compose(p, ['exec', '-T', '-e', 'PGPASSWORD', 'postgres',
    'psql', '-X', '-qAt', '-h', '127.0.0.1', '-U', 'continuum_dba', '-d', 'continuum',
    '-v', 'ON_ERROR_STOP=1', '-c', statement], { env: { ...p.env, PGPASSWORD: p.passwords.DBA } }).trim();
  const settings = {
    log_statement: 'all', log_error_verbosity: 'verbose', log_min_error_statement: 'error',
    log_min_duration_statement: '0', log_min_duration_sample: '0', log_duration: 'on',
  };
  const quoted = value => `'${String(value).replaceAll("'", "''")}'`;
  const settingNames = Object.keys(settings).map(quoted).join(',');
  const readSettings = () => JSON.parse(dbaStatement(`SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN (${settingNames})`));
  const awaitSettings = expected => {
    const deadline = Date.now()+5000;
    do {
      const active=readSettings();
      if(Object.entries(expected).every(([name,value])=>active[name]===value)) return true;
    } while(Date.now()<deadline);
    return false;
  };
  const original = readSettings();
  const job = `${p.project}-bootstrap`;
  const captured = [];
  const captureJob = () => {
    const result = spawnSync('docker', [...p.base, 'run', '--rm', '--name', job, 'bootstrap'], {
      env: p.env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    });
    captured.push(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    // Never propagate an Error containing raw captured output into public results.
    check(!result.error && result.signal === null && Number.isInteger(result.status), 'Bootstrap log canary job did not settle within its deadline');
    return result;
  };
  try {
    // ALTER SYSTEM cannot run in the compound SET-prefixed sql() helper.
    // Each setting therefore runs as its own direct DBA psql statement.
    for (const [name,value] of Object.entries(settings)) dbaStatement(`ALTER SYSTEM SET ${name} = ${quoted(value)}`);
    check(dbaStatement('SELECT pg_reload_conf()')==='t','Bootstrap canary logging reload failed');
    check(awaitSettings(settings),'Bootstrap canary verbose logging was not active');
    dbaStatement("SELECT 'continuum_bootstrap_log_canary'");
    const success = captureJob();
    check(success.status===0, 'Bootstrap log canary fresh job failed: ' + JSON.stringify({ ...safeBootstrapFailure(captured.at(-1)), exitStatus: success.status, errorLines: sanitizedBootstrapLines(captured.at(-1), Object.values(p.passwords)) }));
    const repeated = captureJob();
    check(repeated.status!==0 && `${repeated.stdout ?? ''}${repeated.stderr ?? ''}`.includes('fresh database bootstrap failed at validation (P0001); review approved inputs and database state'),
      'Bootstrap log canary did not receive the specific repeated-bootstrap refusal');
    const postgresId = compose(p,['ps','-q','postgres']).trim();
    const logs = spawnSync('docker',['logs',postgresId],{
      encoding:'utf8',timeout:30_000,killSignal:'SIGKILL',maxBuffer:16*1024*1024,
    });
    check(!logs.error && logs.signal===null && logs.status===0,'Bootstrap log canary could not privately capture PostgreSQL logs');
    captured.push(`${logs.stdout ?? ''}${logs.stderr ?? ''}`);
    check(captured.at(-1).includes('continuum_bootstrap_log_canary'),'Bootstrap log canary did not capture its statement-logging control');
    check(!Object.values(p.passwords).some(password=>captured.some(text=>text.includes(password))),
      'Bootstrap plaintext log canary failed');
    return true;
  } finally {
    // Restore before migrations and transport tests to keep CI log volume bounded.
    for (const [name,value] of Object.entries(original)) dbaStatement(`ALTER SYSTEM SET ${name} = ${quoted(value)}`);
    check(dbaStatement('SELECT pg_reload_conf()')==='t','Bootstrap canary logging restoration failed');
    check(awaitSettings(original),'Bootstrap canary logging settings were not restored');
    captured.length=0;
  }
}
function phase(p, name, timeout = 900_000) {
  const job = `${p.project}-${name}`;
  const mode = p.granted ? 'upgrade' : 'fresh';
  try {
    compose(p, ['run', '--rm', '--name', job, ...(name === 'grant' ? ['-e', `CONTINUUM_MAINTENANCE_MODE=${mode}`] : []), name], { timeout });
    if (name === 'grant') p.granted = true;
  }
  catch (error) {
    try {
      const info = JSON.parse(run(['inspect', job]))[0];
      check(info.Config.Labels['com.docker.compose.project'] === p.project, 'Timed-out job ownership mismatch');
      run(['stop', '-t', '10', job]);
      run(['rm', '-f', job]);
    } catch { /* A completed --rm job is already absent. */ }
    throw new Error(`${name} maintenance failed or exceeded deadline`, { cause: error });
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
function writeMaintenanceEnvironment(p, file, overrides = {}) {
 writeFileSync(file, Object.entries({...p.env,...overrides})
  .filter(([key])=>key==='COMPOSE_PROJECT_NAME'||key.startsWith('CONTINUUM_'))
  .map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n'),{mode:0o600});
}
function maintenanceCli(mode,p,file,backupFile,extraEnv = {}) {
 const stdout=execFileSync(process.execPath,[resolve('scripts/container-maintenance.mjs'),mode,file,resolve(assets,'deploy/compose.production.yml')],{
  encoding:'utf8',timeout:300000,maxBuffer:1024*1024,
  env:{...process.env,...extraEnv,CONTINUUM_QUIESCENCE_CONFIRMED:'yes',CONTINUUM_MAINTENANCE_DEADLINE_SECONDS:'120',CONTINUUM_BACKUP_DEADLINE_SECONDS:'120',...(backupFile?{CONTINUUM_BACKUP_FILE:backupFile}: {})},
 });
 const receipt=JSON.parse(stdout);
 check(receipt.mode===mode&&receipt.project===p.project&&receipt.imageId===image&&receipt.volume===p.env.CONTINUUM_PGDATA_VOLUME,'Successful wrapper selected wrong installation/image');
 check(receipt.deadlineMs===120000&&receipt.backupDeadlineMs===120000,'CLI did not record explicit independent operator budgets');
 return receipt;
}
function syntheticDbaLock(p,label,statement){
 const name='synthetic-'+label+'-'+randomUUID();
 const predicate=`usename='continuum_dba' AND datname='continuum' AND application_name='${name}'`;
 const child=spawn('docker',[...p.base,'exec','-T','-e','PGPASSWORD','-e','PGAPPNAME','postgres','psql','-X','-qAt','-h','127.0.0.1','-U','continuum_dba','-d','continuum','-v','ON_ERROR_STOP=1','-c','BEGIN; '+statement+'; SELECT pg_sleep(120); ROLLBACK'],{env:{...p.env,PGPASSWORD:p.passwords.DBA,PGAPPNAME:name},stdio:'ignore'});
 const close=()=>{sql(p,`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ${predicate} AND pid<>pg_backend_pid()`,'DBA');child.kill('SIGTERM');check(sql(p,`SELECT count(*) FROM pg_stat_activity WHERE ${predicate}`,'DBA')==='0','Owned DBA fixture did not settle');};
 try{
  const end=Date.now()+10000;
  while(sql(p,`SELECT count(*) FROM pg_stat_activity WHERE ${predicate} AND wait_event='PgSleep'`,'DBA')!=='1'&&Date.now()<end){}
  check(sql(p,`SELECT count(*) FROM pg_stat_activity WHERE ${predicate} AND wait_event='PgSleep'`,'DBA')==='1','Owned DBA fixture did not acquire its lock');
 }catch(error){close();throw error;}
 return {predicate,close};
}
function verifyWrapperBackup(file,p) {
 const roleFile=`${file}.roles.sql`, sumsFile=`${file}.sha256`;
 const rows=readFileSync(sumsFile,'utf8').trim().split('\n');
 const expected=[file,roleFile].map(path=>`${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${path}`);
 check(JSON.stringify(rows)===JSON.stringify(expected),'Wrapper backup checksum sidecar differs from real files');
 check(readFileSync(file).subarray(0,5).toString('ascii')==='PGDMP','Wrapper backup is not custom format');
 const roles=readFileSync(roleFile,'utf8');
 check(!/\bPASSWORD\b|SCRAM-SHA-256/i.test(roles)&&!Object.values(p.passwords).some(value=>roles.includes(value)),'Wrapper role definitions contain credentials');
 for(const name of ['continuum_dba','continuum_owner','continuum_app','continuum_operator','continuum_sync']) check(roles.includes(name),'Wrapper role definitions are incomplete');
 return createHash('sha256').update(readFileSync(file)).digest('hex');
}
try {
  const fresh = setup('fresh');
  startDatabase(fresh);
  const wrapperFresh = setup('wrapper-fresh');
  const wrapperFreshEnv = join(wrapperFresh.directory,'maintenance.env');
  writeMaintenanceEnvironment(wrapperFresh,wrapperFreshEnv);
  results.wrapperFresh = maintenanceCli('fresh',wrapperFresh,wrapperFreshEnv,undefined,{COMPOSE_PROJECT_NAME:owner+'-ambient-poison',COMPOSE_FILE:'/private/synthetic-unreviewed.yml',CONTINUUM_PGDATA_VOLUME:owner+'-ambient-volume',CONTINUUM_APP_IMAGE:'sha256:'+'f'.repeat(64),CONTINUUM_DBA_PASSWORD_FILE:'/private/synthetic-foreign-secret',CONTINUUM_ADMIN_PRINCIPAL_ID:randomUUID()});
  verifyLedger(wrapperFresh);
  check(!readdirSync(wrapperFresh.directory).some(name=>/^continuum-maintenance-failure-/.test(name)),'Successful fresh wrapper retained an empty failure reservation');
  await api(wrapperFresh,'/health/ready');
  const wrapperApi = JSON.parse(run(['inspect',compose(wrapperFresh,['ps','-q','api']).trim()]))[0];
  check(wrapperApi.Config.Env.includes('CONTINUUM_AUTH_MODE=entra'),'Fresh wrapper did not start production Entra API');
  compose(wrapperFresh,['stop','-t','15','api']);
  results.passed.push('documented fresh CLI wrapper completes DBA/bootstrap/migrate/admin/profile/image gate and Entra API readiness with recorded bounded budgets');

  results.bootstrapPlaintextLogCanaryPassed=bootstrapLogCanary(fresh);
  results.passed.push('fresh and specifically refused repeated bootstrap expose no generated plaintext passwords in privately captured job output or verbose PostgreSQL logs; logging settings restored');
  check(sql(fresh, "SELECT rolcreaterole AND NOT rolsuper AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname='continuum_owner'", 'DBA') === 't', 'Migration owner lacks the exact existing retirement authority');
  check(sql(fresh, "SELECT count(*) FROM pg_roles WHERE rolname IN ('continuum_app','continuum_operator','continuum_sync') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)", 'DBA') === '0', 'Runtime role gained administrative attributes');
  check(sql(fresh, "SELECT count(*) FROM pg_auth_members m JOIN pg_roles target ON target.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE target.rolname='continuum_sync' AND member.rolname='continuum_owner' AND m.admin_option AND NOT m.set_option AND NOT m.inherit_option", 'DBA') === '1', 'Owner SYNC retirement edge permits runtime impersonation or lacks administration');
  for (const name of ['migrate', 'provision-admin', 'grant']) phase(fresh, name);
  verifyLedger(fresh);
  phase(fresh, 'migrate'); phase(fresh, 'grant');

  // Entra discovery/JWKS are fetched lazily on token authentication. This tests
  // the actual production configuration and startup gates without external IDs.
  run(['compose', '-f', resolve(assets,'deploy/compose.production.yml'), '--profile', 'serving', 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', 'api'], { env: fresh.env });
  const entraApi = JSON.parse(run(['inspect', compose(fresh,['ps','-q','api']).trim()]))[0];
  check(entraApi.Config.Env.includes('CONTINUUM_AUTH_MODE=entra'), 'Production Entra process was not selected');
  check(JSON.stringify(entraApi.Mounts.filter(mount=>mount.Destination.startsWith('/run/secrets/')).map(mount=>mount.Destination))===JSON.stringify(['/run/secrets/app_database_url']), 'Serving process mounted an unexpected authority secret');
  check(!Object.values(entraApi.NetworkSettings.Ports??{}).some(Boolean),'Production API unexpectedly publishes a host port');
  await api(fresh,'/health/ready');
  results.passed.push('production Entra configuration boots and passes readiness; synthetic dev mode is used only for later transport requests; JWT validation is covered by the source authentication suite');
  compose(fresh, ['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', 'api']);
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
  function maintenanceEnv(overrides = {}) { writeMaintenanceEnvironment(fresh,envFile,overrides); }
  const productionCompose = resolve(assets,'deploy/compose.production.yml');
  maintenanceEnv();
  expectFailure(() => runMaintenance('fresh',envFile,productionCompose), 'Fresh installation refuses an existing volume', 'Existing volume refusal');
  process.env.CONTINUUM_QUIESCENCE_CONFIRMED='yes';
  const stale = `${fresh.project}-stale-migration`;
  run(['create','--name',stale,'--label',`com.docker.compose.project=${fresh.project}`,'--label','com.docker.compose.service=migrate',image,'continuum','--help']);
  run(['start','-a',stale]);
  check(JSON.parse(run(['inspect',stale]))[0].State.ExitCode===0,'Synthetic stale job fixture did not complete');
  const alternativeAdmin = randomUUID(), alternativeSync = randomUUID();
  sql(fresh, `INSERT INTO principals(id,external_id,kind,display_name) VALUES ('${alternativeAdmin}','${randomUUID()}','user','Synthetic alternative administrator'), ('${alternativeSync}','synthetic-alternative-sync','service','Synthetic alternative sync'); INSERT INTO scope_memberships(principal_id,scope_id,role,source_kind,source_id,active) VALUES('${alternativeAdmin}',continuum_org_scope_id(),'admin','manual','manual',true)`);
  const storedBindings = () => sql(fresh, 'SELECT jsonb_agg(to_jsonb(t) ORDER BY database_role)::text FROM continuum_trusted_database_identities t');
  const originalBindings = storedBindings();
  const credentialSnapshot = () => sql(fresh, "SELECT jsonb_object_agg(rolname,md5(coalesce(rolpassword,'')))::text FROM pg_authid WHERE rolname IN ('continuum_dba','continuum_owner','continuum_app','continuum_operator','continuum_sync')", 'DBA');
  const originalCredentials = credentialSnapshot();
  const driftMessage = 'upgrade role binding does not match stored identity; use reviewed rotation or restore procedure';
  for (const [setting,value] of [['CONTINUUM_ADMIN_PRINCIPAL_ID',alternativeAdmin],['CONTINUUM_SYNC_PRINCIPAL_ID',alternativeSync],['CONTINUUM_OPERATOR_ROLE','synthetic_other_operator'],['CONTINUUM_SYNC_ROLE','synthetic_other_sync']]) {
    const original = fresh.env[setting];
    try {
      fresh.env[setting]=value;
      expectFailure(() => phase(fresh,'grant'),driftMessage,`Upgrade ${setting} drift refusal`);
    } finally { fresh.env[setting]=original; }
    check(storedBindings()===originalBindings,'Rejected upgrade changed authority bindings');
  }
  sql(fresh,'ALTER ROLE continuum_operator RENAME TO synthetic_preserved_operator; CREATE ROLE continuum_operator LOGIN','DBA');
  try { expectFailure(() => phase(fresh,'grant'),driftMessage,'Upgrade same-name different-OID refusal'); }
  finally { sql(fresh,'DROP ROLE continuum_operator; ALTER ROLE synthetic_preserved_operator RENAME TO continuum_operator','DBA'); }
  check(storedBindings()===originalBindings,'Rejected role-OID drift changed authority bindings');
  phase(fresh,'grant');
  check(storedBindings()===originalBindings && credentialSnapshot()===originalCredentials,'Upgrade grants changed correct stored bindings or role credentials');
  results.passed.push('upgrade refuses changed enabled admin/SYNC UUIDs, role names and same-name foreign role OID before grants; stored bindings and role credentials stay unchanged and correct grants converge');

  // A selected-image asset mismatch must refuse before stopping a ready API.
  compose(fresh,['up','-d','--force-recreate','--wait','--wait-timeout','120','api']);
  // Current authority eligibility must refuse before reserving outputs or downtime.
  const adminId=fresh.env.CONTINUUM_ADMIN_PRINCIPAL_ID,syncId=fresh.env.CONTINUUM_SYNC_PRINCIPAL_ID;
  const ledgerSnapshot=sql(fresh,'SELECT jsonb_agg(to_jsonb(m) ORDER BY name)::text FROM _continuum_migrations m');
  const sqlLiteral=value=>"'"+String(value).replaceAll("'","''")+"'";
  const eligibleAdmin=principal=>sql(fresh,`SELECT EXISTS(SELECT 1 FROM principals p JOIN scope_memberships m ON m.principal_id=p.id WHERE p.id='${principal}' AND p.kind='user' AND p.disabled_at IS NULL AND m.scope_id=continuum_org_scope_id() AND m.source_kind='manual' AND m.source_id='manual' AND m.role='admin' AND m.active)`)==='t';
  const eligibilityWitness=()=>({op:eligibleAdmin(adminId),sync:sql(fresh,`SELECT EXISTS(SELECT 1 FROM principals p WHERE p.id='${syncId}' AND p.kind='service' AND p.disabled_at IS NULL)`)==='t'});
  const fixtureState=()=>sql(fresh,`SELECT jsonb_build_object('principals',(SELECT jsonb_agg(jsonb_build_object('id',id,'disabled_at',disabled_at) ORDER BY id) FROM principals WHERE id IN ('${adminId}','${syncId}')),'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('principal_id',principal_id,'scope_id',scope_id,'source_kind',source_kind,'source_id',source_id,'active',active,'deactivated_at',deactivated_at) ORDER BY principal_id,scope_id,source_kind,source_id) FROM scope_memberships WHERE principal_id IN ('${adminId}','${syncId}')),'[]'::jsonb),'keys',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'revoked_at',revoked_at) ORDER BY id) FROM service_api_keys WHERE principal_id IN ('${adminId}','${syncId}')),'[]'::jsonb))::text`);
  const baselineFixtureState=fixtureState(),baseline=JSON.parse(baselineFixtureState);
  check(eligibilityWitness().op&&eligibilityWitness().sync&&eligibleAdmin(alternativeAdmin),'Eligibility fixtures require all original and alternative identities eligible');
  // A proven TCP authentication refusal never creates an authenticated owner
  // helper. It must refuse before downtime/outputs and leave this project retryable.
  const ownerSecret=fresh.env.CONTINUUM_OWNER_PASSWORD_FILE;
  const unavailableBackup=join(temporary,'owner-preconnect-refused.dump');
  const unavailableFiles=readdirSync(fresh.directory).sort().join(',');
  process.env.CONTINUUM_BACKUP_FILE=unavailableBackup;
  chmodSync(ownerSecret,0o600);writeFileSync(ownerSecret,'SyntheticWrongOwnerPasswordOnly');chmodSync(ownerSecret,0o444);
  try{
   const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}),'PREFLIGHT_UNAVAILABLE','Unauthenticated owner preflight');
   check(error.code==='PREFLIGHT_UNAVAILABLE'&&error.phase==='preflight'&&!error.settlementError&&!error.lockRetained,'Proven unauthenticated preflight retained uncertain settlement');
   check(!existsSync(unavailableBackup)&&readdirSync(fresh.directory).sort().join(',')===unavailableFiles,'Unavailable owner preflight reserved outputs');
   check(!existsSync(join(homedir(),'.continuum-maintenance-locks',fresh.project+'.lock')),'Unauthenticated owner preflight retained project lock');
   check(compose(fresh,['ps','--status','running','-q','api']).trim()!==''&&storedBindings()===originalBindings&&credentialSnapshot()===originalCredentials,'Unavailable owner preflight stopped serving or mutated authority');
  }catch(error){
   const actual=error.actualFailure??error,client=actual.clientFailure??{};
   const diagnostic={code:'OWNER_PREFLIGHT_CLASSIFICATION_FAILED',status:Number.isInteger(client.status)?client.status:null,signal:['SIGKILL','SIGTERM'].includes(client.signal)?client.signal:null,clientCode:['ETIMEDOUT','ENOENT','EPIPE','ENOBUFS'].includes(client.clientCode)?client.clientCode:null,preconnectionProven:client.preconnectionProven===true};
   try{
    const raw=actual.rawOutput??'',values=[...projects.flatMap(p=>Object.values(p.passwords)),'SyntheticWrongOwnerPasswordOnly'];
    check(Buffer.byteLength(raw,'utf8')<=65536,'Owner client diagnostics exceed bound');
    diagnostic.lines=sanitizedMaintenanceLines(raw,values).slice(0,8);
    diagnostic.redactedDigest=createHash('sha256').update(diagnostic.lines.join('\n')).digest('hex');
    diagnostic.stdoutBytes=Buffer.byteLength(client.stdout??'','utf8');diagnostic.stderrBytes=Buffer.byteLength(client.stderr??'','utf8');
    diagnostic.blankLines=raw.split(/\r?\n/).filter(line=>/^\s*$/.test(line)).length;diagnostic.ansi=raw.includes('\u001b');
    const ownedStates=['Creating','Created','Starting','Started'];
    diagnostic.ownedLifecycleStates=ownedStates.filter(state=>raw.split(/\r?\n/).some(line=>line.replace(/[\t ]+/g,' ').trim()===`Container ${client.jobName} ${state}`));
   }catch{diagnostic.evidenceUnavailable=true;}
   try{process.stderr.write(JSON.stringify(diagnostic)+'\n');}catch{/* Preserve the original failure. */}
   throw error;
  }finally{chmodSync(ownerSecret,0o600);writeFileSync(ownerSecret,fresh.passwords.OWNER);chmodSync(ownerSecret,0o444);}
  // Owner-controlled invoker code probes only identities and whether a protected
  // catalog SELECT is denied. LIMIT 0 reads no catalog values; no shell, program,
  // privilege change or escalation operation is attempted.
  const functionSnapshot=()=>sql(fresh,"SELECT jsonb_build_object('definition',pg_catalog.pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl,'securityDefiner',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,'language',p.prolang)::text FROM pg_catalog.pg_proc p WHERE p.oid='continuum.continuum_org_scope_id()'::regprocedure");
  const originalFunctionState=functionSnapshot(),originalFunctionDefinition=JSON.parse(originalFunctionState).definition;
  check(originalFunctionDefinition.includes('SECURITY DEFINER')&&originalFunctionDefinition.includes('BEGIN'),'Owned function fixture requires exact known original definition');
  const probe=`BEGIN
 IF pg_catalog.current_setting('application_name') ~ '^ctm-(eligibility|dba)-[a-f0-9]{24}$' THEN
  DECLARE denied boolean:=false; BEGIN
   BEGIN PERFORM 1 FROM pg_catalog.pg_authid LIMIT 0; EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
   RAISE NOTICE 'synthetic-owner-boundary %',pg_catalog.json_build_object('currentOwner',current_user='continuum_owner','sessionOwner',session_user='continuum_owner','protectedReadDenied',denied);
   RAISE EXCEPTION 'synthetic reviewed owner preflight boundary';
  END;
 END IF;`;
  const invokerFunction=originalFunctionDefinition.replace('SECURITY DEFINER','SECURITY INVOKER').replace('BEGIN',probe);
  const boundaryBackup=join(temporary,'owner-boundary-refused.dump');process.env.CONTINUUM_BACKUP_FILE=boundaryBackup;
  let boundaryError;
  try{
   sql(fresh,invokerFunction);
   const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}),'COMMAND_FAILED','Direct owner controlled-function boundary');
   check(error.phase==='preflight'&&!error.settlementError&&!error.lockRetained,'Controlled owner SQL refusal did not settle');
   const match=(error.rawOutput??'').match(/NOTICE:\s+synthetic-owner-boundary (\{[^\n]+\})/);
   check(Boolean(match),'Owned function did not report controlled authority witness');
   const witness=JSON.parse(match[1]);
   check(witness.currentOwner===true&&witness.sessionOwner===true&&witness.protectedReadDenied===true,'Owner-controlled code inherited DBA authority');
   check(!existsSync(boundaryBackup)&&readdirSync(fresh.directory).sort().join(',')===unavailableFiles,'Owner boundary preflight reserved outputs');
   check(compose(fresh,['ps','--status','running','-q','api']).trim()!==''&&!existsSync(join(homedir(),'.continuum-maintenance-locks',fresh.project+'.lock')),'Owner boundary stopped API or blocked healthy retry');
   check(sql(fresh,"SELECT count(*) FROM pg_stat_activity WHERE usename='continuum_owner' AND datname='continuum' AND application_name ~ '^ctm-eligibility-[a-f0-9]{24}$'",'DBA')==='0','Owned eligibility helper did not settle');
  }catch(error){boundaryError=error;throw error;}finally{
   try{sql(fresh,originalFunctionDefinition);check(functionSnapshot()===originalFunctionState,'Owned function definition/security flags/ACL were not restored exactly');}
   catch(error){if(boundaryError)boundaryError.fixtureCleanupError='Synthetic owner boundary restoration failed';else throw error;}
  }
  check(storedBindings()===originalBindings&&credentialSnapshot()===originalCredentials&&sql(fresh,'SELECT jsonb_agg(to_jsonb(m) ORDER BY name)::text FROM _continuum_migrations m')===ledgerSnapshot,'Owner boundary changed bindings, credentials or ledger');
  results.passed.push('wrong synthetic owner TCP password refuses before outputs/downtime without retained lock; same-project healthy retry executes owner-controlled invoker code with actual session/current OWNER and denied protected catalog SELECT, no DBA authority; exact function definition/security/ACL restored');
  // Synthetic fixture cleanup restores the published disable trigger's membership
  // and key side effects. This is not the production identity recovery procedure.
  const restoreSyntheticFixture=()=>{
   sql(fresh,`UPDATE principals p SET disabled_at=v.disabled_at FROM jsonb_to_recordset(${sqlLiteral(JSON.stringify(baseline.principals))}::jsonb) AS v(id uuid,disabled_at timestamptz) WHERE p.id=v.id;
UPDATE scope_memberships m SET active=v.active,deactivated_at=v.deactivated_at FROM jsonb_to_recordset(${sqlLiteral(JSON.stringify(baseline.memberships))}::jsonb) AS v(principal_id uuid,scope_id uuid,source_kind text,source_id text,active boolean,deactivated_at timestamptz) WHERE m.principal_id=v.principal_id AND m.scope_id=v.scope_id AND m.source_kind=v.source_kind AND m.source_id=v.source_id;
UPDATE service_api_keys k SET revoked_at=v.revoked_at FROM jsonb_to_recordset(${sqlLiteral(JSON.stringify(baseline.keys))}::jsonb) AS v(id uuid,revoked_at timestamptz) WHERE k.id=v.id`);
   check(fixtureState()===baselineFixtureState,'Synthetic disable trigger side effects were not fully restored');
   check(eligibilityWitness().op&&eligibilityWitness().sync&&eligibleAdmin(alternativeAdmin),'Synthetic eligibility cleanup did not restore all reviewed predicates');
  };
  const eligibilityCases=[
   ['demoted-op',`UPDATE scope_memberships SET active=false WHERE principal_id='${adminId}' AND scope_id=continuum_org_scope_id() AND source_kind='manual' AND source_id='manual' AND role='admin'`,{op:false,sync:true},'operator identity must be an effective manual org administrator'],
   ['disabled-op',`UPDATE principals SET disabled_at=clock_timestamp() WHERE id='${adminId}'`,{op:false,sync:true},'operator identity must be an effective manual org administrator'],
   ['disabled-sync',`UPDATE principals SET disabled_at=clock_timestamp() WHERE id='${syncId}'`,{op:true,sync:false},'sync identity must be an enabled service principal'],
  ];
  for(const [label,makeIneligible,expectedWitness,specificReason] of eligibilityCases){
   check(eligibilityWitness().op&&eligibilityWitness().sync,'Earlier fixture contaminated next eligibility case');
   sql(fresh,makeIneligible);
   try{
    check(JSON.stringify(eligibilityWitness())===JSON.stringify(expectedWitness),'Eligibility fixture did not establish its exact intended OP/SYNC predicate');
    const refused=join(temporary,label+'-refused.dump');process.env.CONTINUUM_BACKUP_FILE=refused;
    const priorFiles=readdirSync(fresh.directory).sort().join(',');
    const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}),'BINDING_INELIGIBLE',label);
    check(error.code==='BINDING_INELIGIBLE'&&error.phase==='preflight','Eligibility refusal had unrelated phase/code');
    check(!existsSync(refused)&&readdirSync(fresh.directory).sort().join(',')===priorFiles,'Eligibility refusal reserved outputs');
    check(compose(fresh,['ps','--status','running','-q','api']).trim()!=='','Eligibility refusal stopped serving');
    expectFailure(()=>phase(fresh,'grant'),specificReason,label+' exact direct grant predicate');
    check(storedBindings()===originalBindings&&credentialSnapshot()===originalCredentials,'Eligibility refusal mutated identity authority');
    check(sql(fresh,'SELECT jsonb_agg(to_jsonb(m) ORDER BY name)::text FROM _continuum_migrations m')===ledgerSnapshot,'Eligibility refusal changed ledger');
   }finally{restoreSyntheticFixture();}
  }
  // Separately approved synthetic recovery invokes only the immutable packaged
  // owner grant/verify procedures, then updates the explicit reviewed env file.
  const manualGrant=(file,principal,operatorRole='continuum_operator')=>compose(fresh,['exec','-T','-e','PGPASSWORD','postgres','psql','-X','-qAt','-h','127.0.0.1','-U','continuum_owner','-d','continuum','-v','ON_ERROR_STOP=1','-v','continuum_schema=continuum','-v','continuum_app_role=continuum_app','-v',`continuum_operator_role=${operatorRole}`,'-v','continuum_sync_role=continuum_sync','-v',`continuum_principal_id=${principal}`,'-f','-'],{input:readFileSync(join(assets,'scripts',file)),env:{...fresh.env,PGPASSWORD:fresh.passwords.OWNER}});
  compose(fresh,['stop','-t','15','api']);
  sql(fresh,`UPDATE principals SET disabled_at=clock_timestamp() WHERE id='${adminId}'`);
  check(!eligibleAdmin(adminId)&&eligibleAdmin(alternativeAdmin),'Approved synthetic recovery did not have an eligible replacement administrator');
  let recoveryError;
  try{
   manualGrant('grant-operator-role.sql',alternativeAdmin);
   manualGrant('verify-database-identities.sql',alternativeAdmin);
   fresh.env.CONTINUUM_ADMIN_PRINCIPAL_ID=alternativeAdmin;maintenanceEnv();
   phase(fresh,'grant');
   check(sql(fresh,`SELECT principal_id::text FROM continuum_trusted_database_identities WHERE database_role='continuum_operator'`)===alternativeAdmin,'Approved OP rebind did not establish selected eligible principal');
  }catch(error){recoveryError=error;throw error;}finally{
   try{restoreSyntheticFixture();manualGrant('grant-operator-role.sql',adminId);fresh.env.CONTINUUM_ADMIN_PRINCIPAL_ID=adminId;maintenanceEnv();}
   catch(error){if(recoveryError)recoveryError.fixtureCleanupError='Synthetic recovery cleanup failed';else throw error;}
  }
  manualGrant('grant-sync-role.sql',syncId);manualGrant('verify-database-identities.sql',adminId);phase(fresh,'grant');
  check(storedBindings()===originalBindings&&credentialSnapshot()===originalCredentials,'Approved recovery changed role credentials or did not restore reviewed bindings');
  compose(fresh,['up','-d','--force-recreate','--wait','--wait-timeout','120','api']);
  const heldWindow=acquireMaintenanceLock(fresh.project);
  try{
   const refused=join(temporary,'overlapping-window-refused.dump');process.env.CONTINUUM_BACKUP_FILE=refused;
   const overlapping=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}),'MAINTENANCE_LOCKED','Overlapping project window');
   check(overlapping.code==='MAINTENANCE_LOCKED'&&!existsSync(refused),'Overlapping window reserved backup');
   check(compose(fresh,['ps','--status','running','-q','api']).trim()!=='','Overlapping window stopped serving');
  }finally{releaseMaintenanceLock(heldWindow);}
  results.passed.push('demoted or disabled bound OP and disabled SYNC refuse read-only before outputs/downtime/ledger changes; separately approved immutable owner grant/verify recovery converges; exclusive project window refuses overlap');
  // The existing PG container must stay on its reviewed exact image before any
  // selected-PG helper runs. The already loaded APP image is a synthetic wrong
  // pin, and is never started as PostgreSQL.
  const postgresId=compose(fresh,['ps','--status','running','-q','postgres']).trim();
  const postgresIdentity=JSON.parse(run(['inspect',postgresId]))[0].Image;
  const pgMismatchBackup=join(temporary,'pg-image-mismatch-refused.dump');
  const beforePgMismatchFiles=readdirSync(fresh.directory).sort().join(',');
  process.env.CONTINUUM_BACKUP_FILE=pgMismatchBackup;
  maintenanceEnv({CONTINUUM_POSTGRES_IMAGE:image});
  try{
   const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}),'PG_IMAGE_MISMATCH','Running PostgreSQL image pin mismatch');
   check(error.code==='PG_IMAGE_MISMATCH'&&error.phase==='preflight','PG image mismatch received unrelated failure');
   check(!existsSync(pgMismatchBackup)&&readdirSync(fresh.directory).sort().join(',')===beforePgMismatchFiles,'PG image mismatch reserved outputs');
   check(compose(fresh,['ps','--status','running','-q','api']).trim()!==''&&compose(fresh,['ps','--status','running','-q','postgres']).trim()===postgresId,'PG image mismatch stopped or replaced installation');
   check(JSON.parse(run(['inspect',postgresId]))[0].Image===postgresIdentity,'PG image mismatch replaced PostgreSQL image');
   check(sql(fresh,'SELECT jsonb_agg(to_jsonb(m) ORDER BY name)::text FROM _continuum_migrations m')===ledgerSnapshot,'PG image mismatch changed ledger');
  }finally{maintenanceEnv();}
  results.passed.push('exact running PostgreSQL image mismatch refuses before selected-PG helpers, outputs, API stop or PostgreSQL recreation');
  const driftAssets=join(fresh.directory,'drift-assets'); mkdirSync(driftAssets,{mode:0o755});
  copyFileSync(join(assets,'package.json'),join(driftAssets,'package.json'));
  for(const dir of ['deploy','migrations','scripts']){cpSync(join(assets,dir),join(driftAssets,dir),{recursive:true});chmodSync(join(driftAssets,dir),0o755);}
  const driftSql=join(driftAssets,'scripts/verify-database-identities.sql'); chmodSync(driftSql,0o644);
  writeFileSync(driftSql,readFileSync(driftSql,'utf8')+'\n-- synthetic asset drift\n');
  const driftBackup=join(temporary,'asset-drift-refused.dump');
  process.env.CONTINUUM_BACKUP_FILE=driftBackup;
  maintenanceEnv({CONTINUUM_RUNTIME_ASSETS:driftAssets});
  const assetError=expectFailure(()=>runMaintenance('upgrade',envFile,resolve(driftAssets,'deploy/compose.production.yml'),{deadlineMs:120000}), 'ASSET_MISMATCH', 'Selected image/host asset drift');
  check(assetError.code==='ASSET_MISMATCH','Asset drift received unrelated failure');
  check(compose(fresh,['ps','--status','running','-q','api']).trim()!=='','Asset preflight stopped API before refusing drift');
  check(!existsSync(driftBackup),'Asset preflight reserved a backup before refusal');
  maintenanceEnv();
  // An independently owned synthetic writer is refused, not terminated by wrapper.
  const writerName=`outside-writer-${randomUUID()}`;
  const writer=spawn('docker',[...fresh.base,'exec','-T','-e','PGPASSWORD','-e','PGAPPNAME','postgres','psql','-X','-h','127.0.0.1','-U','continuum_owner','-d','continuum','-v','ON_ERROR_STOP=1','-c','SELECT pg_sleep(120)'],{env:{...fresh.env,PGPASSWORD:fresh.passwords.OWNER,PGAPPNAME:writerName},stdio:'ignore'});
  const writerPredicate=`usename='continuum_owner' AND datname='continuum' AND application_name='${writerName}'`;
  try{
   const connectedEnd=Date.now()+10000;
   while(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE ${writerPredicate}`,'DBA')!=='1'&&Date.now()<connectedEnd){}
   check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE ${writerPredicate}`,'DBA')==='1','Outside writer fixture did not connect');
   const refusedBackup=join(temporary,'active-writer-refused.dump');process.env.CONTINUUM_BACKUP_FILE=refusedBackup;
   const writerError=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}), 'ACTIVE_WRITERS', 'Outside writer quiescence');
   check(writerError.code==='ACTIVE_WRITERS'&&writerError.phase==='quiescence','Writer received unrelated preflight failure');
   check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE ${writerPredicate}`,'DBA')==='1','Wrapper forcibly terminated outside writer');
   check(statSync(refusedBackup).size===0,'Wrapper backed up before quiescence');
   check(sql(fresh,`SELECT id::text || ':' || title FROM memories WHERE id='${captured.id}'`)===before,'Writer refusal changed database content');
  }finally{
   // The fixture owns only this generated session and performs its own cleanup.
   sql(fresh,`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ${writerPredicate} AND pid<>pg_backend_pid()`,'DBA');
   writer.kill('SIGTERM');
   check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE ${writerPredicate}`,'DBA')==='0','Owned writer fixture cleanup did not settle');
  }
  results.passed.push('selected-image host asset drift refuses before API stop/backup; outside owner session is refused after project stop before backup/mutation without killing it');
  // A DBA-owned transaction changes eligibility after readonly preflight and
  // before migration. It releases its ledger lock as soon as the real named
  // pg_dump is observed waiting, well inside its five-second lock timeout.
  check(sql(fresh,"SELECT principal_id::text FROM continuum_trusted_database_identities WHERE database_role='continuum_operator' AND can_approve AND NOT can_sync")===adminId,'Eligibility observer must target the actual bound OP');
  const windowName='synthetic-ew-'+randomUUID();
  check(Buffer.byteLength(windowName,'utf8')<=63,'Eligibility observer application name must not truncate');
  const windowPredicate=`usename='continuum_dba' AND datname='continuum' AND application_name='${windowName}'`;
  const windowProof=join(temporary,'eligibility-window-proof.txt');
  const windowFd=openSync(windowProof,'wx',0o600);
  const windowStderr=join(temporary,'eligibility-window-stderr.txt'),windowStderrFd=openSync(windowStderr,'wx',0o600);
  const windowSql=`SET search_path=continuum,public; SET statement_timeout='90s'; BEGIN; LOCK TABLE _continuum_migrations IN ACCESS EXCLUSIVE MODE;
DO $window$ DECLARE until_at timestamptz:=clock_timestamp()+interval '75 seconds'; BEGIN
 LOOP
  PERFORM pg_stat_clear_snapshot();
  IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='continuum_dba' AND application_name ~ '^ctm-backup-[a-f0-9]{24}$' AND wait_event_type='Lock') THEN EXIT; END IF;
  IF clock_timestamp()>until_at THEN RAISE EXCEPTION 'synthetic eligibility observer deadline'; END IF;
  PERFORM pg_sleep(0.01);
 END LOOP;
END $window$;
SET LOCAL ROLE continuum_owner;
DO $change$ DECLARE changed integer; BEGIN
 IF NOT EXISTS(SELECT 1 FROM continuum_trusted_database_identities WHERE database_role='continuum_operator' AND principal_id='${adminId}' AND can_approve AND NOT can_sync) THEN RAISE EXCEPTION 'synthetic eligibility observer targets the wrong binding'; END IF;
 UPDATE scope_memberships SET active=false WHERE principal_id='${adminId}' AND scope_id=continuum_org_scope_id() AND source_kind='manual' AND source_id='manual' AND role='admin' AND active;
 GET DIAGNOSTICS changed = ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'synthetic eligibility observer expected one changed membership'; END IF;
 IF EXISTS(SELECT 1 FROM principals p JOIN scope_memberships m ON m.principal_id=p.id WHERE p.id='${adminId}' AND p.kind='user' AND p.disabled_at IS NULL AND m.scope_id=continuum_org_scope_id() AND m.source_kind='manual' AND m.source_id='manual' AND m.role='admin' AND m.active) THEN RAISE EXCEPTION 'synthetic eligibility observer did not demote OP'; END IF;
END $change$; RESET ROLE; COMMIT;
SELECT jsonb_build_object('marker','eligibility-window-observed','changedRows',1,'operatorBindingMatches',EXISTS(SELECT 1 FROM continuum_trusted_database_identities WHERE database_role='continuum_operator' AND principal_id='${adminId}' AND can_approve AND NOT can_sync),'opEligible',EXISTS(SELECT 1 FROM principals p JOIN scope_memberships m ON m.principal_id=p.id WHERE p.id='${adminId}' AND p.kind='user' AND p.disabled_at IS NULL AND m.scope_id=continuum_org_scope_id() AND m.source_kind='manual' AND m.source_id='manual' AND m.role='admin' AND m.active),'syncEligible',EXISTS(SELECT 1 FROM principals p WHERE p.id='${syncId}' AND p.kind='service' AND p.disabled_at IS NULL));`;
  const windowChild=spawn('docker',[...fresh.base,'exec','-T','-e','PGPASSWORD','-e','PGAPPNAME','postgres','psql','-X','-qAt','-h','127.0.0.1','-U','continuum_dba','-d','continuum','-v','ON_ERROR_STOP=1','-c',windowSql],{env:{...fresh.env,PGPASSWORD:fresh.passwords.DBA,PGAPPNAME:windowName},stdio:['ignore',windowFd,windowStderrFd]});
  let windowError;
  try{
   const until=Date.now()+10000;
   const held=`SELECT count(*) FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE ${windowPredicate} AND l.relation='continuum._continuum_migrations'::regclass AND l.mode='AccessExclusiveLock' AND l.granted`;
   while(sql(fresh,held,'DBA')!=='1'&&Date.now()<until){}
   check(sql(fresh,held,'DBA')==='1','Eligibility observer did not acquire its owned ledger lock');
   check(eligibilityWitness().op&&eligibilityWitness().sync,'Eligibility race did not start from eligible authority');
   const windowBackup=join(temporary,'eligibility-window.dump');process.env.CONTINUUM_BACKUP_FILE=windowBackup;
   const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000,backupDeadlineMs:120000}),'BINDING_INELIGIBLE','Eligibility changed during backup window');
   check(error.code==='BINDING_INELIGIBLE'&&error.phase==='quiescence','Eligibility race did not fail after backup before migration');
   const witness=JSON.parse(readFileSync(windowProof,'utf8'));
   check(witness.marker==='eligibility-window-observed'&&witness.changedRows===1&&witness.operatorBindingMatches===true&&witness.opEligible===false&&witness.syncEligible===true&&!eligibilityWitness().op&&eligibilityWitness().sync,'Eligibility race lacked committed one-row bound OP and exact predicate witnesses');
   verifyWrapperBackup(windowBackup,fresh);
   check(compose(fresh,['ps','--status','running','-q','api']).trim()==='','Eligibility race unexpectedly resumed serving');
   check(sql(fresh,'SELECT jsonb_agg(to_jsonb(m) ORDER BY name)::text FROM _continuum_migrations m')===ledgerSnapshot&&storedBindings()===originalBindings&&credentialSnapshot()===originalCredentials,'Eligibility race mutated ledger, bindings or role credentials');
   check(sql(fresh,"SELECT count(*) FROM pg_stat_activity WHERE application_name ~ '^ctm-migrate-[a-f0-9]{24}$'",'DBA')==='0','Eligibility race left a migrator backend');
  }catch(error){
   windowError=error;
   const diagnostic={code:'ELIGIBILITY_OBSERVER_FAILED'};
   try{diagnostic.lines=statSync(windowStderr).size<=65536?sanitizedMaintenanceLines(readFileSync(windowStderr,'utf8'),projects.flatMap(p=>Object.values(p.passwords))).slice(0,8):['[observer diagnostics exceeded limit]'];}
   catch{diagnostic.evidenceUnavailable=true;}
   try{
    check(statSync(windowProof).size<=65536,'Observer witness is not bounded');
    const witness=JSON.parse(readFileSync(windowProof,'utf8'));
    diagnostic.witness={committed:witness.marker==='eligibility-window-observed',changedOneRow:witness.changedRows===1,operatorBindingMatches:witness.operatorBindingMatches===true,opEligible:witness.opEligible===true,syncEligible:witness.syncEligible===true};
   }catch{diagnostic.witnessUnavailable=true;}
   try{process.stderr.write(JSON.stringify(diagnostic)+'\n');}catch{/* Preserve the original fixture failure. */}
   throw error;
  }finally{
   try{sql(fresh,`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ${windowPredicate} AND pid<>pg_backend_pid()`,'DBA');windowChild.kill('SIGTERM');closeSync(windowFd);closeSync(windowStderrFd);restoreSyntheticFixture();check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE ${windowPredicate}`,'DBA')==='0','Eligibility observer cleanup did not settle');}
   catch(error){if(windowError)windowError.fixtureCleanupError='Synthetic eligibility window cleanup failed';else throw error;}
  }
  results.passed.push('actual named custom backup wait witnesses mid-window OP demotion; post-quiescence eligibility recheck refuses before migration and preserves authority/ledger; owned fixture fully restores');
  // Exercise the exact operator upgrade success tail and use its real backup.
  maintenanceEnv();
  const successfulBackup = join(temporary,'successful-wrapper-upgrade.dump');
  results.wrapperUpgrade = maintenanceCli('upgrade',fresh,envFile,successfulBackup);
  const wrapperBackupHash = verifyWrapperBackup(successfulBackup,fresh);
  check(!readdirSync(temporary).filter(name=>/^continuum-maintenance-failure-/.test(name)).some(name=>statSync(join(temporary,name)).size===0),'Successful upgrade retained an empty failure reservation');
  await api(fresh,'/health/ready');
  check(sql(fresh, `SELECT id::text || ':' || title FROM memories WHERE id='${captured.id}'`) === before, 'Successful upgrade wrapper changed stored data');
  results.passed.push('documented upgrade CLI wrapper completes migration/grants/image gate/Entra readiness; real custom and password-free role backups match checksum sidecar');
  // A foreign-labelled volume and foreign consumer must fail before downtime.
  const foreignProject=`${owner}-foreign`, foreignVolume=`${owner}-foreign-pgdata`;
  run(['volume','create','--label',`com.docker.compose.project=${foreignProject}`,'--label',`continuum.ci.owner=${owner}`,foreignVolume]);
  try{
   const refused=join(temporary,'foreign-volume-refused.dump');process.env.CONTINUUM_BACKUP_FILE=refused;
   maintenanceEnv({CONTINUUM_PGDATA_VOLUME:foreignVolume});
   const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}),'VOLUME_OWNERSHIP_MISMATCH','Foreign volume label');
   check(error.code==='VOLUME_OWNERSHIP_MISMATCH'&&!existsSync(refused),'Foreign volume mismatch reserved backup');
   check(compose(fresh,['ps','--status','running','-q','api']).trim()!=='','Foreign volume refusal stopped intended API');
   check(sql(fresh,`SELECT id::text || ':' || title FROM memories WHERE id='${captured.id}'`)===before,'Foreign volume refusal changed intended data');
  }finally{
   maintenanceEnv();
   const owned=JSON.parse(run(['volume','inspect',foreignVolume]))[0];
   check(owned.Name===foreignVolume&&owned.Labels['continuum.ci.owner']===owner&&owned.Labels['com.docker.compose.project']===foreignProject,'Foreign fixture volume ownership unclear');
   check(run(['ps','-aq','--filter',`volume=${foreignVolume}`]).trim()==='','Foreign fixture volume unexpectedly consumed');
   run(['volume','rm',foreignVolume]);
  }
  const consumerName=`${owner}-foreign-consumer`;
  run(['run','-d','--pull','never','--name',consumerName,'--label',`com.docker.compose.project=${foreignProject}`,'--label',`continuum.ci.owner=${owner}`,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','10001:10001','--memory','128m','--pids-limit','16','--mount',`type=volume,src=${fresh.env.CONTINUUM_PGDATA_VOLUME},dst=/foreign-pgdata,readonly`,'--entrypoint','node',image,'-e','setInterval(()=>{},1000)']);
  try{
   const refused=join(temporary,'foreign-consumer-refused.dump');process.env.CONTINUUM_BACKUP_FILE=refused;
   const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}),'VOLUME_OWNERSHIP_MISMATCH','Foreign mounted consumer');
   check(error.code==='VOLUME_OWNERSHIP_MISMATCH'&&!existsSync(refused),'Foreign consumer mismatch reserved backup');
   check(compose(fresh,['ps','--status','running','-q','api']).trim()!=='','Foreign consumer refusal stopped intended API');
   check(JSON.parse(run(['inspect',consumerName]))[0].State.Running,'Wrapper stopped foreign mounted consumer');
  }finally{
   const own=JSON.parse(run(['inspect',consumerName]))[0];
   check(own.Name===`/${consumerName}`&&own.Config.Labels['continuum.ci.owner']===owner&&own.Config.Labels['com.docker.compose.project']===foreignProject,'Foreign consumer fixture ownership unclear');
   run(['rm','-f',consumerName]);
  }
  results.passed.push('reviewed env-file defeats ambient project/volume/image/secret/identity poison; foreign-labelled volume and foreign mounted consumer refuse before backup/downtime/mutation');
  // Real helper backend settlement must never terminate the independent locker.
  const dbaLocker=syntheticDbaLock(fresh,'dba-preflight','LOCK TABLE continuum.continuum_trusted_database_identities IN ACCESS EXCLUSIVE MODE');
  try{
   const refused=join(temporary,'dba-helper-refused.dump');process.env.CONTINUUM_BACKUP_FILE=refused;
   const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}),'COMMAND_FAILED','Read-only DBA preflight lock limit');
   check(error.phase==='preflight'&&!existsSync(refused),'DBA preflight failure reserved backup or had wrong phase');
   check(sql(fresh,"SELECT count(*) FROM pg_stat_activity WHERE usename='continuum_dba' AND application_name~'^ctm-dba-[a-f0-9]{24}$'",'DBA')==='0','Failed DBA helper retained backend');
   check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE ${dbaLocker.predicate}`,'DBA')==='1','Wrapper terminated external DBA locker');
   check(compose(fresh,['ps','--status','running','-q','api']).trim()!=='','DBA preflight failure stopped serving');
  }finally{dbaLocker.close();}
  const backupLocker=syntheticDbaLock(fresh,'backup','LOCK TABLE continuum._continuum_migrations IN ACCESS EXCLUSIVE MODE');
  try{
   process.env.CONTINUUM_BACKUP_FILE=join(temporary,'timed-out-backup.dump');
   const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000,backupDeadlineMs:1000}),'BACKUP_FAILED','Real custom dump deadline');
   check(error.phase==='backup'&&error.deadlineExceeded===true&&!error.settlementError,'Backup deadline failed backend settlement');
   check(sql(fresh,"SELECT count(*) FROM pg_stat_activity WHERE usename='continuum_dba' AND application_name~'^ctm-backup-[a-f0-9]{24}$'",'DBA')==='0','Timed-out dump retained DBA backend');
   check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE ${backupLocker.predicate}`,'DBA')==='1','Wrapper terminated external backup locker');
  }finally{backupLocker.close();}
  check(sql(fresh,'SELECT jsonb_agg(to_jsonb(m) ORDER BY name)::text FROM _continuum_migrations m')===ledgerSnapshot,'Backup deadline mutated migration ledger');
  // Canonical grant sessions retain lock_timeout=5s. A lock blocker can fail
  // before the wrapper deadline, so use an owned INSERT trigger sleep instead.
  // No published SQL, entrypoint or Compose setting is overridden.
  sql(fresh,"CREATE FUNCTION synthetic_wait_grant() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(120); RETURN NEW; END$$; CREATE TRIGGER synthetic_wait_grant BEFORE INSERT OR UPDATE ON continuum_trusted_database_identities FOR EACH ROW EXECUTE FUNCTION synthetic_wait_grant()");
  const grantProof=join(fresh.directory,'real-grant-proof.json'),grantProofErr=join(fresh.directory,'real-grant-proof.stderr');
  const grantProofFd=openSync(grantProof,'wx',0o600),grantProofErrFd=openSync(grantProofErr,'wx',0o600);
  const observerName='grant-observer-'+randomUUID();
  const observerInput=join(fresh.directory,'real-grant-observer.sql');
  writeFileSync(observerInput,`CREATE TEMP TABLE observed_grant(pid integer,name text,event text,wait text);
DO $observe$ DECLARE until_time timestamptz:=clock_timestamp()+interval '45 seconds'; BEGIN LOOP
 PERFORM pg_stat_clear_snapshot();
 INSERT INTO observed_grant SELECT a.pid,a.application_name,a.wait_event_type,a.wait_event FROM pg_stat_activity a WHERE a.usename='continuum_owner' AND a.datname=current_database() AND a.application_name~'^ctm-grant-[a-f0-9]{24}$' AND a.wait_event='PgSleep' LIMIT 1;
 EXIT WHEN EXISTS(SELECT 1 FROM observed_grant);
 IF clock_timestamp()>until_time THEN RAISE EXCEPTION 'real grant sleep was not observed'; END IF;
 PERFORM pg_sleep(0.005); END LOOP; END $observe$;
SELECT row_to_json(t)::text FROM observed_grant t;`,{mode:0o600});
  const observerInputFd=openSync(observerInput,'r');
  const grantObserver=spawn('docker',[...fresh.base,'exec','-T','-e','PGPASSWORD','-e','PGAPPNAME','postgres','psql','-X','-qAt','-h','127.0.0.1','-U','continuum_dba','-d','continuum','-v','ON_ERROR_STOP=1','-f','-'],{env:{...fresh.env,PGPASSWORD:fresh.passwords.DBA,PGAPPNAME:observerName},stdio:[observerInputFd,grantProofFd,grantProofErrFd]});
  let grantFailure;
  try{
   const observerEnd=Date.now()+10000;
   while(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE application_name='${observerName}'`,'DBA')!=='1'&&Date.now()<observerEnd){}
   check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE application_name='${observerName}'`,'DBA')==='1','Owned real grant observer did not connect');
   process.env.CONTINUUM_BACKUP_FILE=join(temporary,'timed-out-grant.dump');
   const error=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:10000,backupDeadlineMs:120000}),'DEADLINE_EXCEEDED','Real grant deadline');
   check(error.phase==='grant'&&!error.settlementError,'Grant deadline failed backend settlement or wrong phase');
   const proof=JSON.parse(readFileSync(grantProof,'utf8').trim().split('\n')[0]);
   check(Number.isInteger(proof.pid)&&/^ctm-grant-[a-f0-9]{24}$/.test(proof.name)&&proof.event==='Timeout'&&proof.wait==='PgSleep','Actual canonical owner grant did not enter observed sleep');
   check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE usename='continuum_owner' AND datname='continuum' AND (pid=${proof.pid} OR application_name='${proof.name}')`,'DBA')==='0','Timed-out observed grant retained owner backend');
   check(sql(fresh,'SELECT pg_try_advisory_lock(7215328273579717613::bigint)')==='t','Timed-out grant retained deployment lock');
   check(storedBindings()===originalBindings&&credentialSnapshot()===originalCredentials,'Timed-out grant changed reviewed identity binding or credentials');
   check(sql(fresh,'SELECT jsonb_agg(to_jsonb(m) ORDER BY name)::text FROM _continuum_migrations m')===ledgerSnapshot,'Timed-out grant changed migration ledger');
  }catch(error){grantFailure=error;throw error;}finally{
   try{
    sql(fresh,`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='continuum_dba' AND datname='continuum' AND application_name='${observerName}' AND pid<>pg_backend_pid()`,'DBA');
    grantObserver.kill('SIGTERM');
    sql(fresh,"SET lock_timeout='2s'; DROP TRIGGER synthetic_wait_grant ON continuum_trusted_database_identities; DROP FUNCTION synthetic_wait_grant()",'OWNER',{timeout:15000});
   }catch(error){if(grantFailure)grantFailure.fixtureCleanupError='Owned grant fixture cleanup failed';else throw error;}
   finally{closeSync(observerInputFd);closeSync(grantProofFd);closeSync(grantProofErrFd);}
  }
  results.passed.push('real read-only DBA lock-limit, custom dump deadline and grant deadline settle only uniquely named owned backends; independent DBA lock fixtures survive; actual sleeping owner grant is observed and cancelled with deployment advisory lock released');
  // Inject an owned synthetic post-preflight grant refusal, without changing
  // package SQL or config. The actual grant connection must settle its lock.
  process.env.CONTINUUM_BACKUP_FILE=join(temporary,'failed-upgrade.dump');
  sql(fresh,"CREATE FUNCTION synthetic_refuse_grant() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic reviewed grant refusal'; END$$; CREATE TRIGGER synthetic_refuse_grant BEFORE INSERT OR UPDATE ON continuum_trusted_database_identities FOR EACH ROW EXECUTE FUNCTION synthetic_refuse_grant()");
  let bindingError;
  try{
   bindingError=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:120000}),'COMMAND_FAILED','Failed wrapper grant with stale successful job');
  }finally{sql(fresh,'DROP TRIGGER synthetic_refuse_grant ON continuum_trusted_database_identities; DROP FUNCTION synthetic_refuse_grant()');}
  check(bindingError.code==='COMMAND_FAILED'&&bindingError.phase==='grant','Wrapper did not identify the exact failed grant phase');
  check(bindingError.evidencePath&&existsSync(bindingError.evidencePath),'Failed grant execution evidence was discarded');
  const grantEvidence=readFileSync(bindingError.evidencePath,'utf8');
  check(statSync(bindingError.evidencePath).size<=65536&&(statSync(bindingError.evidencePath).mode&0o777)===0o600,'Grant evidence is not private/bounded');
  const grantRecord=JSON.parse(grantEvidence);
  check(grantEvidence.includes('synthetic reviewed grant refusal'),'Grant evidence omitted actionable SQL failure; actual='+JSON.stringify({code:bindingError.code,phase:bindingError.phase,evidenceLines:sanitizedMaintenanceLines(grantRecord.lines.join('\n'),Object.values(fresh.passwords)).slice(0,8)}));
  check(!Object.values(fresh.passwords).some(value=>grantEvidence.includes(value))&&!grantEvidence.includes('postgres://'),'Grant evidence exposed private credentials or URL');
  check(sql(fresh,"SELECT count(*) FROM pg_stat_activity WHERE usename='continuum_owner' AND application_name~'^ctm-grant-[a-f0-9]{24}$'",'DBA')==='0','Failed grant backend remained');
  check(sql(fresh,'SELECT pg_try_advisory_lock(7215328273579717613::bigint)')==='t','Failed grant retained maintenance advisory lock');
  check(compose(fresh,['ps','--status','running','-q','api']).trim()==='', 'Failed maintenance left API serving');
  maintenanceEnv();
  process.env.CONTINUUM_BACKUP_FILE=join(temporary,'deadline-upgrade.dump');
  const proofFile=join(fresh.directory,'real-migrator-proof.json'),proofError=join(fresh.directory,'real-migrator-proof.stderr');
  const proofFd=openSync(proofFile,'wx',0o600),proofErrFd=openSync(proofError,'wx',0o600);
  const lockerName=`ledger-blocker-${randomUUID()}`;
  // Wait until the real custom dump holds AccessShare, then queue exclusive.
  // Its release admits this DBA before the real migrator's ledger query.
  const lockerSql=`BEGIN; SET LOCAL statement_timeout='90s'; SET LOCAL lock_timeout='60s';
CREATE TEMP TABLE observed_migrator(pid integer,name text,query text,wait text);
DO $wait$ DECLARE until_time timestamptz:=clock_timestamp()+interval '45 seconds'; BEGIN LOOP
 PERFORM pg_stat_clear_snapshot();
 EXIT WHEN EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database() AND a.usename='continuum_dba' AND a.application_name~'^ctm-backup-[a-f0-9]{24}$' AND l.relation='continuum._continuum_migrations'::regclass AND l.mode='AccessShareLock' AND l.granted);
 IF clock_timestamp()>until_time THEN RAISE EXCEPTION 'synthetic dump lock was not observed'; END IF;
 PERFORM pg_sleep(0.005); END LOOP; END $wait$;
LOCK TABLE continuum._continuum_migrations IN ACCESS EXCLUSIVE MODE;
DO $observe$ DECLARE until_time timestamptz:=clock_timestamp()+interval '20 seconds'; BEGIN LOOP
 PERFORM pg_stat_clear_snapshot();
 INSERT INTO observed_migrator SELECT a.pid,a.application_name,a.query,a.wait_event_type FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.usename='continuum_owner' AND a.datname=current_database() AND a.application_name~'^ctm-migrate-[a-f0-9]{24}$' AND a.wait_event_type='Lock' AND l.relation='continuum._continuum_migrations'::regclass AND NOT l.granted LIMIT 1;
 EXIT WHEN EXISTS(SELECT 1 FROM observed_migrator);
 IF clock_timestamp()>until_time THEN RAISE EXCEPTION 'real migrator lock wait was not observed'; END IF;
 PERFORM pg_sleep(0.005); END LOOP; END $observe$;
SELECT row_to_json(t)::text FROM observed_migrator t; SELECT pg_sleep(60); ROLLBACK;`;
  const lockerInput=join(fresh.directory,'real-migrator-locker.sql');writeFileSync(lockerInput,lockerSql,{mode:0o600});
  const lockerInputFd=openSync(lockerInput,'r');
  const locker=spawn('docker',[...fresh.base,'exec','-T','-e','PGPASSWORD','-e','PGAPPNAME','postgres','psql','-X','-qAt','-h','127.0.0.1','-U','continuum_dba','-d','continuum','-v','ON_ERROR_STOP=1','-f','-'],{env:{...fresh.env,PGPASSWORD:fresh.passwords.DBA,PGAPPNAME:lockerName},stdio:[lockerInputFd,proofFd,proofErrFd]});
  let backendProof,deadlineError;
  try{
   const waitEnd=Date.now()+10000;
   while(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE application_name='${lockerName}'`,'DBA')!=='1'&&Date.now()<waitEnd){}
   check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE application_name='${lockerName}'`,'DBA')==='1','Owned DBA deadline locker did not connect');
   deadlineError=expectFailure(()=>runMaintenance('upgrade',envFile,productionCompose,{deadlineMs:10000,backupDeadlineMs:120000}), 'DEADLINE_EXCEEDED', 'Real installed migrator deadline');
   check(deadlineError.code==='DEADLINE_EXCEEDED'&&deadlineError.phase==='migrate','Deadline returned unrelated phase or code');
   backendProof=JSON.parse(readFileSync(proofFile,'utf8').trim().split('\n')[0]);
   check(/^ctm-migrate-[a-f0-9]{24}$/.test(backendProof.name)&&Number.isInteger(backendProof.pid)&&backendProof.wait==='Lock','Actual entrypoint/pool migrator did not enter observed ledger lock wait');
   check(sql(fresh,`SELECT count(*) FROM pg_stat_activity WHERE pid=${backendProof.pid} OR application_name='${backendProof.name}'`,'DBA')==='0','Actual migrator backend survived cancellation');
   check(deadlineError.evidencePath&&existsSync(deadlineError.evidencePath),'Failed real migrator did not retain private evidence');
  }finally{
   sql(fresh,`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='continuum_dba' AND datname='continuum' AND application_name='${lockerName}' AND pid<>pg_backend_pid()`,'DBA');
   locker.kill('SIGTERM');closeSync(lockerInputFd);closeSync(proofFd);closeSync(proofErrFd);
  }
  check(sql(fresh,'SELECT pg_try_advisory_lock(7215328273579717613::bigint)')==='t','Actual migrator retained its deployment advisory lock');
  check(compose(fresh,['ps','--status','running','-q','api']).trim()==='', 'Real migration deadline did not keep API stopped');
  check(run(['ps','-aq','--filter',`name=^/${fresh.project}-maintenance-migrate-${process.pid}$`]).trim()==='', 'Timed-out actual migrator container remained');  // Run the actual immutable packaged rollback guard, not a missing-file error.
  expectFailure(() => compose(fresh,['exec','-T','-e','PGPASSWORD','postgres','psql','-X','-h','127.0.0.1','-U','continuum_owner','-d','continuum','-v','ON_ERROR_STOP=1','-f','-'],{input:readFileSync(join(assets,'scripts/rollback-embedding-provider-key.sql')),env:{...fresh.env,PGPASSWORD:fresh.passwords.OWNER}}), 'Embedding schema rollback requires a verified pre-upgrade database backup; in-place migration ledger deletion is not supported','Packaged downgrade refusal');
  results.passed.push('maintenance rejects existing fresh volume; specific failed grant and real database migration deadline keep API stopped despite successful stale job; timed-out client/backend gone and advisory lock released; packaged downgrade guard specifically rejects');

  // Backup/restore uses another isolated volume; only synthetic data and roles.
  const backup = successfulBackup;
  const backupHash = wrapperBackupHash;
  check(verifyWrapperBackup(backup,fresh) === backupHash,'Wrapper backup changed before restore');
  const restored = setup('restore');
  // Deliberately restore existing reviewed identity UUIDs, with new role OIDs.
  for (const key of ['CONTINUUM_ADMIN_PRINCIPAL_ID','CONTINUUM_ADMIN_ENTRA_OBJECT_ID','CONTINUUM_SYNC_PRINCIPAL_ID']) restored.env[key] = fresh.env[key];
  startDatabase(restored);
  sql(restored, 'CREATE ROLE synthetic_oid_offset NOLOGIN', 'DBA');
  phase(restored, 'bootstrap');
  const restoreId = compose(restored, ['ps', '-q', 'postgres']).trim();
  check(createHash('sha256').update(readFileSync(backup)).digest('hex') === backupHash, 'Backup checksum mismatch');
  // Provider infrastructure is DBA-created; application schema restore retains owner.
  readCommandInput('docker', ['exec', '-i', restoreId, 'pg_restore', '-U', 'continuum_dba', '-d', 'continuum', '--exit-on-error', '--clean', '--if-exists', '--schema=continuum'], backup);
  sql(restored, "SELECT continuum_rebind_database_identity_oids('REBIND DATABASE IDENTITIES','FOREIGN OID NAMESPACE')");
  restored.granted = true;
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
  const historicalBackup = join(historical.directory, 'pre-upgrade.dump');
  writeCommandOutput('docker', ['exec', historyPg, 'pg_dump', '-U', 'continuum_dba', '-d', 'continuum', '-Fc'], historicalBackup);
  check(readFileSync(historicalBackup).subarray(0,5).toString('ascii') === 'PGDMP', 'Historical backup is not PostgreSQL custom format');
  results.historicalBackupSha256 = createHash('sha256').update(readFileSync(historicalBackup)).digest('hex');
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
