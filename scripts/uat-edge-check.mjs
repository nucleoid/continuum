// Hosted-only synthetic topology/proxy qualification. No host configuration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const nginx = 'nginx@sha256:959ae6b898852db82e5b29b929388e59914f42be0a8f4d44c89a4c1f53b49208';
const tunnel = 'cloudflare/cloudflared@sha256:b4d7b15b9e9256ee3c9d243a49cec440aa6d7acbf6b2e2c1086ebfff939ec48d';
const node = 'node:22.23.3-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 }).trim();
const directory = mkdtempSync(join(tmpdir(), 'continuum-uat-edge-'));
const name = 'continuum-uat-' + randomUUID();
const networks = [], containers = [];
const run = args => { const id = docker(['run','-d',...args]); containers.push(id); return id; };
const hardened = ['--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=128m','--cpus=0.25','--pids-limit=64'];
try {
  const secret = join(directory, 'synthetic'); writeFileSync(secret, 'synthetic-only', { mode: 0o600 });
  const env = Object.fromEntries(readFileSync('deploy/production.env.example','utf8').split('\n')
    .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => { const [key,...value] = line.split('='); return [key, value.join('=') || 'synthetic']; }));
  Object.assign(env, {
    COMPOSE_PROJECT_NAME:name, CONTINUUM_APP_IMAGE:'sha256:'+'a'.repeat(64), CONTINUUM_POSTGRES_IMAGE:'sha256:'+'b'.repeat(64),
    CONTINUUM_RUNTIME_ASSETS:process.cwd(), CONTINUUM_PGDATA_VOLUME:name+'-data',
    CONTINUUM_MCP_PUBLIC_URL:'https://memory.example.com/mcp',
    CONTINUUM_UAT_ORIGIN_SUBNET:'192.0.2.0/24', CONTINUUM_UAT_ORIGIN_DYNAMIC_RANGE:'192.0.2.128/25',
    CONTINUUM_UAT_INGRESS_SUBNET:'198.51.100.0/24', CONTINUUM_UAT_INGRESS_DYNAMIC_RANGE:'198.51.100.128/25',
    CONTINUUM_UAT_API_IP:'192.0.2.4', CONTINUUM_UAT_PROXY_IP:'192.0.2.2', CONTINUUM_UAT_PROXY_INGRESS_IP:'198.51.100.2', CONTINUUM_UAT_TUNNEL_IP:'198.51.100.3',
    CONTINUUM_UAT_PROXY_IMAGE:nginx, CONTINUUM_UAT_TUNNEL_IMAGE:tunnel,
    CONTINUUM_UAT_PROXY_CONFIG_FILE:secret, CONTINUUM_UAT_TUNNEL_TOKEN_FILE:secret,
    CONTINUUM_UAT_EMBEDDING_CONFIG_FILE:secret, CONTINUUM_UAT_GEMINI_KEY_FILE:secret,
  });
  for (const key of Object.keys(env)) if (key.endsWith('_FILE')) env[key] = secret;
  const envFile = join(directory,'fixture.env'); writeFileSync(envFile,Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n'));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CONTINUUM_')&&!key.startsWith('COMPOSE_')));
  const compose = ['compose','--env-file',envFile,'-f','deploy/compose.production.yml','-f','deploy/compose.uat.yml'];
  const model = extra => JSON.parse(execFileSync('docker',[...compose,...extra,'--profile','maintenance','--profile','serving','--profile','uat','config','--format','json'],{encoding:'utf8',env:clean,timeout:30000}));
  const base = model([]), semantic = model(['-f','deploy/compose.uat-gemini.yml']);
  for (const m of [base,semantic]) {
    assert.deepEqual(Object.keys(m.services.postgres.networks),['backend']);
    assert.deepEqual(Object.keys(m.services['uat-tunnel'].networks),['uat_ingress']);
    assert.deepEqual(Object.keys(m.services['uat-proxy'].networks).sort(),['uat_ingress','uat_origin']);
    assert.equal(m.networks.uat_origin.internal,true);
    assert.deepEqual(m.networks.edge.ipam ?? {}, {});
    for (const service of Object.values(m.services)) assert(!service.ports?.length);
    assert.equal(m.services.api.environment.CONTINUUM_MCP_TRUSTED_PROXY_CIDRS,'192.0.2.2/32');
    assert.equal(m.services.api.networks.uat_origin.ipv4_address,'192.0.2.4');
  }
  assert.equal(base.services.api.environment.GEMINI_API_KEY_FILE,undefined);
  assert.equal(semantic.services.api.environment.GEMINI_API_KEY_FILE,'/run/secrets/gemini_api_key');
  assert.equal(base.services['uat-proxy'].mem_limit,64*1024*1024);
  assert.equal(base.services['uat-tunnel'].mem_limit,128*1024*1024);
  for (const image of [nginx,tunnel,node]) docker(['pull',image]);
  assert(docker(['run','--rm',...hardened,'--network=none',tunnel,'tunnel','run','--help']).includes('--token-file'));
  const origin = docker(['network','create','--internal',name+'-origin']); networks.push(origin);
  const ingress = docker(['network','create',name+'-ingress']); networks.push(ingress);
  const upstream = run([...hardened,'--network',origin,'--network-alias','api','--user=10001:10001','-e','NODE_OPTIONS=--max-old-space-size=64',node,'--input-type=module','-e',
    `import http from 'node:http';http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({host:req.headers.host,proto:req.headers['x-forwarded-proto']}));}).listen(4000,'0.0.0.0');`]);
  const proxyConfig = join(directory,'nginx.conf');
  writeFileSync(proxyConfig,readFileSync('deploy/uat-proxy.conf.example','utf8'));
  const mounts = ['--mount',`type=bind,source=${proxyConfig},target=/etc/nginx/uat.conf,readonly`,'--tmpfs','/tmp:rw,noexec,nosuid,size=16m,uid=101,gid=101'];
  docker(['run','--rm',...hardened,'--network',origin,'--user=101:101',...mounts,'--entrypoint=nginx',nginx,'-t','-c','/etc/nginx/uat.conf']);
  const proxy = run([...hardened,'--network',origin,'--user=101:101',...mounts,'--entrypoint=nginx',nginx,'-c','/etc/nginx/uat.conf','-g','daemon off;']);
  docker(['network','connect','--alias','uat-proxy',ingress,proxy]);
  const probe = `import assert from 'node:assert/strict';
    const request=(path,extra={})=>fetch('http://uat-proxy:8080'+path,{headers:{Host:'memory.example.com','X-Forwarded-Proto':'https',...extra},signal:AbortSignal.timeout(5000)});
    let ready=false;for(let i=0;i<20;i++){try{const r=await request('/mcp');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready);
    for(const path of ['/mcp','/api/v0/audit','/api/v0/recall','/api/v0/memories/example']){const r=await request(path);assert.equal(r.status,200);assert.deepEqual(await r.json(),{host:'memory.example.com',proto:'https'});}
    for(const path of ['/health/ready','/health/live','/api/v0/ingest','/unexpected']){const r=await request(path);assert.equal(r.status,404);await r.body?.cancel();}
    assert.equal((await request('/mcp',{Host:'wrong.example.com'})).status,404);
    assert.equal((await request('/mcp',{'X-Forwarded-Proto':'http'})).status,403);
    await assert.rejects(fetch('http://api:4000',{signal:AbortSignal.timeout(1000)}));
    const burst=await Promise.all(Array.from({length:40},async()=>{const r=await request('/mcp');await r.body?.cancel();return r.status;}));assert(burst.includes(429));
    console.log(JSON.stringify({proxyReadOnlyStart:true,canonicalHost:true,httpsRequired:true,routeAllowlist:true,preAuthRateLimit:true,tunnelCannotReachApi:true}));`;
  const results = docker(['run','--rm',...hardened,'--network',ingress,'--user=10001:10001','-e','NODE_OPTIONS=--max-old-space-size=64',node,'--input-type=module','-e',probe]);
  console.log(results);
  console.log(JSON.stringify({composeModels:true,optionalGemini:true,maintenanceNetworksUnchanged:true,immutableImages:{nginx,tunnel}}));
} finally {
  for (const id of containers.reverse()) docker(['rm','--force',id]);
  for (const id of networks.reverse()) docker(['network','rm',id]);
  assert(resolve(directory).startsWith(resolve(tmpdir())));
  rmSync(directory,{recursive:true,force:true});
}
