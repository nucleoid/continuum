import test from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, closeSync, existsSync, rmSync, statSync, mkdirSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { reserveBackupTargets, maintenanceBudgets, runtimeAssetManifest, assertRuntimeAssets, assertAssetMounts, quiescenceSql, assertQuiescence, runMaintenance } from './container-maintenance.mjs';

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

test('wrapper gives backup a separate budget and rejects parity drift before stopping serving', () => {
 const root=mkdtempSync(join(tmpdir(),'continuum-wrapper-'));
 const originalSpawn=childProcess.spawnSync, originalNow=Date.now, originalHome=os.homedir;
 os.homedir=()=>root;syncBuiltinESMExports();
 const originalBackup=process.env.CONTINUUM_BACKUP_FILE, originalQuiescence=process.env.CONTINUUM_QUIESCENCE_CONFIRMED;
 try {
  for(const dir of ['deploy','scripts','migrations']) mkdirSync(join(root,dir));
  writeFileSync(join(root,'package.json'),'{}');
  writeFileSync(join(root,'deploy','compose.production.yml'),'public');
  writeFileSync(join(root,'scripts','grant.sql'),'SELECT 1;');
  writeFileSync(join(root,'migrations','0001.sql'),'SELECT 2;');
  const reference=runtimeAssetManifest(root), appImage='sha256:'+'a'.repeat(64),pgImage='sha256:'+'b'.repeat(64);
  const job=()=>({image:pgImage,volumes:[{type:'bind',source:root,target:'/assets',read_only:true}]});
  const config={name:'synthetic-maintenance',volumes:{pgdata:{name:'synthetic-pgdata'}},services:{
   api:{image:appImage,environment:{CONTINUUM_AUTH_MODE:'entra'}},
   postgres:{image:pgImage,environment:{POSTGRES_DB:'synthetic'}},
   migrate:{image:appImage,environment:{CONTINUUM_MIGRATION_OWNER_ROLE:'owner'}},
   bootstrap:job(),'provision-admin':job(),grant:{...job(),environment:{PGUSER:'owner',CONTINUUM_APP_ROLE:'app',CONTINUUM_OPERATOR_ROLE:'op',CONTINUUM_SYNC_ROLE:'sync'}}
  }};
  let time=10000; Date.now=()=>time;
  const calls=[];
  childProcess.spawnSync=(command,args,options)=>{
   assert.equal(command,'docker'); calls.push({args,timeout:options.timeout});
   let stdout='';
   if(args.includes('config')) stdout=JSON.stringify(config);
   else if(args[0]==='image') stdout=JSON.stringify([{Id:args[2],Os:'linux',Architecture:'amd64'}]);
   else if(args[0]==='volume') stdout=args[1]==='inspect'?JSON.stringify([{Name:'synthetic-pgdata',Labels:{'com.docker.compose.project':config.name}}]):'synthetic-pgdata\n';
   else if(args[0]==='ps') stdout=args.includes('label=com.docker.compose.project=synthetic-maintenance')?'synthetic-api\n':'';
   else if(args[0]==='inspect') stdout=JSON.stringify([{Config:{Labels:{'com.docker.compose.project':config.name,'com.docker.compose.service':'api'}}}]);
   else if(args[0]==='run') {
    assert.ok(args.includes('none'));assert.ok(args.includes('--read-only'));assert.ok(args.includes('10001:10001'));
    assert.ok(args.includes('--cap-drop'));assert.ok(args.includes('no-new-privileges:true'));assert.ok(!args.includes('--mount')&&!args.includes('-v'));
    stdout=JSON.stringify(reference);
   } else if(args.some(arg=>arg.includes('exec pg_dump'))) {
    writeSync(options.stdio[1],'synthetic private dump'); time+=400;
   } else if(args.includes('exec')) stdout='0\n';
   return {status:0,stdout,stderr:''};
  };
  syncBuiltinESMExports();
  process.env.CONTINUUM_BACKUP_FILE=join(root,'backup.dump');process.env.CONTINUUM_QUIESCENCE_CONFIRMED='yes';
  const result=runMaintenance('upgrade',join(root,'private.env'),join(root,'deploy','compose.production.yml'),{deadlineMs:1000,backupDeadlineMs:1000});
  assert.equal(result.deadlineMs,1000);assert.equal(result.backupDeadlineMs,1000);
  const migrate=calls.find(call=>call.args.includes('run')&&call.args.at(-1)==='migrate');
  assert.equal(migrate.timeout,1000,'800ms of backup must not consume the migration budget');
  assert.equal(calls.filter(call=>call.args.some(arg=>arg.includes('pg_catalog.pg_stat_activity'))).length,2);
  assert.match(readFileSync(join(root,'backup.dump.sha256'),'utf8'),/^[a-f0-9]{64}  /);
  calls.length=0;writeFileSync(join(root,'scripts','grant.sql'),'tampered');
  assert.throws(()=>runMaintenance('upgrade',join(root,'private.env'),join(root,'deploy','compose.production.yml'),{deadlineMs:1000}),e=>e.code==='ASSET_MISMATCH');
  assert.ok(!calls.some(call=>call.args[0]==='stop'||call.args.includes('up')),'drift refusal must precede downtime');
 } finally {
  childProcess.spawnSync=originalSpawn;os.homedir=originalHome;syncBuiltinESMExports();Date.now=originalNow;
  if(originalBackup===undefined)delete process.env.CONTINUUM_BACKUP_FILE;else process.env.CONTINUUM_BACKUP_FILE=originalBackup;
  if(originalQuiescence===undefined)delete process.env.CONTINUUM_QUIESCENCE_CONFIRMED;else process.env.CONTINUUM_QUIESCENCE_CONFIRMED=originalQuiescence;
  rmSync(root,{recursive:true,force:true});
 }
});

function wrapperFixture(check) {
 const root=mkdtempSync(join(tmpdir(),'continuum-wrapper-safety-'));
 const originalSpawn=childProcess.spawnSync,originalNow=Date.now,originalHome=os.homedir,saved={...process.env};
 os.homedir=()=>root;syncBuiltinESMExports();
 try {
  for(const dir of ['deploy','scripts','migrations']) mkdirSync(join(root,dir));
  for(const [file,value] of [['package.json','{}'],['deploy/compose.production.yml','public'],['scripts/grant.sql','SELECT 1;'],['migrations/0001.sql','SELECT 2;']]) writeFileSync(join(root,file),value);
  const reference=runtimeAssetManifest(root),appImage='sha256:'+'a'.repeat(64),pgImage='sha256:'+'b'.repeat(64);
  const job=()=>({image:pgImage,volumes:[{type:'bind',source:root,target:'/assets',read_only:true}]});
  const project='synthetic-maintenance',volume='synthetic-pgdata';
  const config={name:project,volumes:{pgdata:{name:volume}},services:{api:{image:appImage,environment:{CONTINUUM_AUTH_MODE:'entra'}},postgres:{image:pgImage,environment:{POSTGRES_DB:'synthetic'}},migrate:{image:appImage,environment:{CONTINUUM_MIGRATION_OWNER_ROLE:'owner'}},bootstrap:job(),'provision-admin':job(),grant:{...job(),environment:{PGUSER:'owner',CONTINUUM_APP_ROLE:'app',CONTINUUM_OPERATOR_ROLE:'op',CONTINUUM_SYNC_ROLE:'sync'}}}};
  const container=(id,service='api',owner=project,running=true)=>({Id:id,Name:'/'+id,State:{Running:running},Config:{Labels:{'com.docker.compose.project':owner,'com.docker.compose.service':service}},Mounts:[{Type:'volume',Name:volume,Destination:'/var/lib/postgresql/data'}]});
  const state={volumeOwner:project,consumers:[container('synthetic-postgres','postgres')],calls:[],time:10000};
  Date.now=()=>state.time;
  process.env.CONTINUUM_BACKUP_FILE=join(root,'backup.dump');process.env.CONTINUUM_QUIESCENCE_CONFIRMED='yes';
  childProcess.spawnSync=(command,args,options)=>{
   assert.equal(command,'docker');state.calls.push({args,options});let stdout='';
   if(args.includes('config')) stdout=JSON.stringify(config);
   else if(args[0]==='image') stdout=JSON.stringify([{Id:args[2],Os:'linux',Architecture:'amd64'}]);
   else if(args[0]==='volume') stdout=args[1]==='inspect'?JSON.stringify([{Name:volume,Labels:{'com.docker.compose.project':state.volumeOwner}}]):volume+'\n';
   else if(args[0]==='ps') stdout=args.includes('volume='+volume)?state.consumers.map(c=>c.Id).join('\n'):args.includes('label=com.docker.compose.project='+project)?'synthetic-api\nsynthetic-postgres\n':'';
   else if(args[0]==='inspect') stdout=JSON.stringify([state.consumers.find(c=>c.Id===args[1])??container(args[1],args[1]==='synthetic-postgres'?'postgres':'api')]);
   else if(args[0]==='run') stdout=JSON.stringify(reference);
   else if(args.some(arg=>arg.includes('exec pg_dump'))) writeSync(options.stdio[1],'synthetic dump');
   else if(args.includes('exec')) stdout='0\n';
   if(args.some(arg=>arg.includes('operator identity must be an effective manual org administrator'))&&state.ineligible) return {status:1,stdout:'',stderr:'ERROR: role binding is ineligible'};
   if(args.includes('run')&&args.at(-1)==='grant'&&state.expireAtGrant) state.time+=1001;
   if(args.includes('run')&&args.at(-1)==='grant'&&state.failGrant) return {status:1,stdout:'',stderr:'ERROR: synthetic lock timeout '+state.privateSecret+'\nCONTEXT: PASSWORD '+state.privateSecret};
   if(args.includes('up')&&args.at(-1)==='api'&&state.failApi) return {status:1,stdout:'',stderr:'Container synthetic API unhealthy'};
   if(args.includes('logs')) stdout='Error: synthetic startup failure '+state.privateSecret;
   return {status:0,stdout,stderr:''};
  };syncBuiltinESMExports();
  check({root,state,container,config,run:(compose=join(root,'deploy','compose.production.yml'))=>runMaintenance('upgrade',join(root,'private.env'),compose,{deadlineMs:1000,backupDeadlineMs:1000})});
 } finally {
  childProcess.spawnSync=originalSpawn;os.homedir=originalHome;syncBuiltinESMExports();Date.now=originalNow;
  for(const key of Object.keys(process.env)) if(!(key in saved)) delete process.env[key];
  Object.assign(process.env,saved);rmSync(root,{recursive:true,force:true});
 }
}

test('all Docker children discard ambient Compose and Continuum settings while wrapper controls remain available',()=>wrapperFixture(({state,run})=>{
 process.env.COMPOSE_PROJECT_NAME='foreign-project';process.env.CONTINUUM_PGDATA_VOLUME='foreign-volume';process.env.CONTINUUM_ADMIN_PRINCIPAL_ID='foreign-admin';
 process.env.DOCKER_CONTEXT='synthetic-context';process.env.WRAPPER_TEST_SETTING='preserved';
 run();
 assert.ok(state.calls.some(call=>call.args.some(arg=>arg.includes('exec pg_dump'))));
 for(const call of state.calls) {
  assert.ok(call.options.env,'every Docker call must receive an explicit environment');
  assert.ok(!Object.keys(call.options.env).some(key=>/^(CONTINUUM_|COMPOSE_)/i.test(key)));
  assert.equal(call.options.env.DOCKER_CONTEXT,'synthetic-context');assert.equal(call.options.env.WRAPPER_TEST_SETTING,'preserved');
 }
 assert.equal(process.env.CONTINUUM_QUIESCENCE_CONFIRMED,'yes');assert.equal(process.env.COMPOSE_PROJECT_NAME,'foreign-project');
}));

test('upgrade refuses wrong volume labels and every foreign consumer before backup or downtime',()=>{
 for(const variant of ['volume-label','foreign-live','foreign-stopped','extra-postgres']) wrapperFixture(({root,state,container,run})=>{
  if(variant==='volume-label') state.volumeOwner='foreign-project';
  else state.consumers.push(container('foreign-consumer','postgres',variant==='extra-postgres'?'synthetic-maintenance':'foreign-project',variant!=='foreign-stopped'));
  assert.throws(run,e=>e.code==='VOLUME_OWNERSHIP_MISMATCH'&&e.phase==='preflight');
  assert.equal(existsSync(join(root,'backup.dump')),false);
  assert.ok(!state.calls.some(call=>call.args[0]==='stop'||call.args.includes('up')||call.args[0]==='run'));
 });
});

test('only the verified production Compose asset may execute',()=>wrapperFixture(({root,state,run})=>{
 const alternate=join(root,'alternate-compose.yml');writeFileSync(alternate,'public');
 assert.throws(()=>run(alternate),e=>e.code==='ASSET_MISMATCH'&&e.phase==='preflight');
 assert.equal(existsSync(join(root,'backup.dump')),false);
 assert.ok(!state.calls.some(call=>call.args[0]==='stop'||call.args.includes('up')));
}));

test('successful grant at the budget boundary still starts the explicitly bounded API gate',()=>wrapperFixture(({state,run})=>{
 state.expireAtGrant=true;run();
 const api=state.calls.find(call=>call.args.includes('up')&&call.args.at(-1)==='api');
 assert.ok(api);assert.equal(api.options.timeout,90000);
}));

test('failed grant retains bounded private redacted SQL evidence after job cleanup',()=>wrapperFixture(({root,state,config,run})=>{
 const secret='SyntheticPrivatePassword01234567890123456789',file=join(root,'private-secret');writeFileSync(file,secret);
 config.secrets={synthetic:{file}};state.privateSecret=secret;state.failGrant=true;
 let error;try{run();}catch(value){error=value;}
 assert.equal(error.code,'COMMAND_FAILED');assert.equal(error.phase,'grant');
 const body=readFileSync(error.evidencePath,'utf8'),record=JSON.parse(body);
 assert.equal(record.phase,'grant');assert.equal(record.code,'COMMAND_FAILED');assert.ok(body.includes('synthetic lock timeout'));assert.ok(!body.includes(secret));
 assert.ok(Buffer.byteLength(body)<=65536);
}));
test('failed API gate retains owned API logs before stopping the unhealthy service',()=>wrapperFixture(({root,state,config,run})=>{
 const secret='SyntheticPrivatePassword01234567890123456789',file=join(root,'private-secret');writeFileSync(file,secret);
 config.secrets={synthetic:{file}};state.privateSecret=secret;state.failApi=true;
 let error;try{run();}catch(value){error=value;}
 assert.equal(error.phase,'api');const body=readFileSync(error.evidencePath,'utf8');
 assert.ok(body.includes('synthetic startup failure'));assert.ok(!body.includes(secret));
 const logIndex=state.calls.findIndex(call=>call.args.includes('logs'));
 const stopIndex=state.calls.findIndex((call,index)=>index>logIndex&&call.args.includes('stop')&&call.args.at(-1)==='api');
 assert.ok(logIndex>=0&&stopIndex>logIndex);
}));

test('upgrade eligibility is checked read-only before output reservations and serving stops',()=>wrapperFixture(({root,state,run})=>{
 state.ineligible=true;
 assert.throws(run,e=>e.code==='BINDING_INELIGIBLE'&&e.phase==='preflight');
 assert.equal(existsSync(join(root,'backup.dump')),false);
 assert.ok(!state.calls.some(call=>call.args[0]==='stop'||call.args.includes('up')));
 const check=state.calls.find(call=>call.args.some(arg=>arg.includes('operator identity must be an effective manual org administrator')));
 assert.ok(check);assert.ok(check.args.some(arg=>arg.includes('BEGIN READ ONLY')));
}));

test('backup files and directory are made durable before migration and failure prevents migration',()=>wrapperFixture(({state,run})=>{
 const original=fs.fsyncSync;let count=0;
 fs.fsyncSync=fd=>{count++;if(count===1)throw new Error('synthetic fsync failure');return original(fd);};syncBuiltinESMExports();
 try {assert.throws(run);assert.ok(count>0);assert.ok(!state.calls.some(call=>call.args.includes('run')&&call.args.at(-1)==='migrate'));}
 finally {fs.fsyncSync=original;syncBuiltinESMExports();}
}));

test('backup and grant failure settle only individually named sessions in the configured database',()=>wrapperFixture(({state,run})=>{
 state.failGrant=true;assert.throws(run);
 const grant=state.calls.find(call=>call.args.includes('run')&&call.args.at(-1)==='grant');
 const setting=grant.args.find(arg=>/^PGAPPNAME=ctm-grant-[a-f0-9]{24}$/.test(arg));assert.ok(setting);
 const name=setting.slice('PGAPPNAME='.length);
 const terminate=state.calls.find(call=>call.args.some(arg=>arg.includes('pg_terminate_backend')&&arg.includes(name)));
 assert.ok(terminate);assert.ok(terminate.args.some(arg=>arg.includes("usename='owner'")&&arg.includes("datname='synthetic'")));
 for(const backup of state.calls.filter(call=>call.args.some(arg=>arg.includes('exec pg_dump')))) assert.ok(backup.args.some(arg=>/^PGAPPNAME=ctm-backup-[a-f0-9]{24}$/.test(arg)));
}));

test('a failure writing evidence preserves the original grant code and phase',()=>wrapperFixture(({state,run})=>{
 state.failGrant=true;const original=fs.fsyncSync;
 fs.fsyncSync=fd=>{if(new Error().stack.includes('writeFailureEvidence'))throw new Error('synthetic evidence fsync failure');return original(fd);};syncBuiltinESMExports();
 try {let error;try{run();}catch(value){error=value;}assert.equal(error.code,'COMMAND_FAILED');assert.equal(error.phase,'grant');assert.equal(error.evidenceError,'EVIDENCE_WRITE_FAILED');}
 finally {fs.fsyncSync=original;syncBuiltinESMExports();}
}));


test('an existing project lock refuses another window before outputs or Docker mutations',()=>wrapperFixture(({root,state,run})=>{
 const dir=join(root,'.continuum-maintenance-locks');mkdirSync(dir,{mode:0o700});
 const lock=join(dir,'synthetic-maintenance.lock');writeFileSync(lock,'retained lock',{mode:0o600});
 assert.throws(run,e=>e.code==='MAINTENANCE_LOCKED'&&e.phase==='preflight');
 assert.equal(readFileSync(lock,'utf8'),'retained lock');assert.equal(existsSync(join(root,'backup.dump')),false);
 assert.ok(!state.calls.some(call=>call.args[0]==='stop'||call.args.includes('up')||call.args[0]==='run'));
}));
