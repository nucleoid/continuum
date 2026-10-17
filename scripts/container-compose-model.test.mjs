import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateTmpfsMounts } from './container-compose-model.mjs';
test('rejects comma-split Compose tmpfs entries before container creation', () => {
 assert.throws(()=>validateTmpfsMounts({bootstrap:{tmpfs:['/tmp:rw','noexec','nosuid','size=16m','uid=999','gid=999']}}), /Invalid production tmpfs mount/);
});
test('accepts separate absolute mounts with bounded security options', () => {
 assert.doesNotThrow(()=>validateTmpfsMounts({bootstrap:{tmpfs:['/tmp:rw,noexec,nosuid,size=16m,uid=999,gid=999']},postgres:{tmpfs:['/tmp:rw,noexec,nosuid,size=16m','/var/run/postgresql:rw,noexec,nosuid,size=8m,uid=999,gid=999']}}));
});
test('production Compose requires the PostgreSQL pin and gates direct API startup on a successful grant job',()=>{
 const source=readFileSync(resolve(import.meta.dirname,'../deploy/compose.production.yml'),'utf8');
 assert.match(source,/postgres:\r?\n\s+image: \$\{CONTINUUM_POSTGRES_IMAGE:\?pinned pgvector PostgreSQL 16 digest required\}/);
 assert.match(source,/api:[\s\S]*?depends_on:\r?\n\s+postgres: \{condition: service_healthy\}\r?\n\s+grant: \{condition: service_completed_successfully\}/);
});
test('Entra readiness uses canonical production Compose before synthetic dev requests',()=>{
 const source=readFileSync(resolve(import.meta.dirname,'container-production-smoke.mjs'),'utf8');
 assert.doesNotMatch(source,/run\(\['compose',[^\n]*'--profile',\s*'serving'[^\n]*'api'/);
 const canonicalBase=source.match(/const canonicalBase = (\[[^\n]+\]);/)?.[1];
 assert.ok(canonicalBase);
 assert.doesNotMatch(canonicalBase,/override/);
 assert.match(canonicalBase,/'--profile', 'maintenance', '--profile', 'serving'/);
 const syntheticBase=source.match(/const base = (\[[^\n]+\]);/)?.[1];
 assert.ok(syntheticBase);
 assert.match(syntheticBase,/'-f', override/);
 const probe=source.match(/\/\/ Entra discovery\/JWKS[\s\S]*?(?=  results\.passed\.push\('production Entra mode)/)?.[0];
 assert.ok(probe);
 assert.match(probe,/canonicalCompose\(fresh, \['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '120', 'api'\]\)/);
 assert.match(probe,/canonicalCompose\(fresh,\['ps','-q','api'\]\)/);
 assert.doesNotMatch(probe,/(?:^|\n)  compose\(fresh/);
 assert.match(source,/later transport requests explicitly use synthetic dev mode'\);\n  compose\(fresh, \['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '120', 'api'\]\)/);
});
