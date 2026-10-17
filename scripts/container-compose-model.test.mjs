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
test('operational API probes retain the full profiled Compose model',()=>{
 const source=readFileSync(resolve(import.meta.dirname,'container-production-smoke.mjs'),'utf8');
 assert.match(source,/run\(\['compose', '-f', resolve\(assets,'deploy\/compose\.production\.yml'\), '--profile', 'maintenance', '--profile', 'serving',[\s\S]*?'up', '-d', '--no-deps',[^\n]*'api'\], \{ env: fresh\.env \}\)/);
 assert.match(source,/compose\(fresh, \['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '120', 'api'\]\)/);
});
