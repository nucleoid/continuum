import test from 'node:test';
import assert from 'node:assert/strict';
import { safeBootstrapFailure, sanitizedBootstrapLines } from './container-diagnostics.mjs';

test('bootstrap diagnostics return only known phase and SQLSTATE', () => {
 const result = safeBootstrapFailure("ERROR: fresh database bootstrap failed at create-roles (42601); review approved inputs and database state\nCONTEXT: PASSWORD 'synthetic-sensitive-value'");
 assert.deepEqual(result, { code: 'BOOTSTRAP_SQL_FAILURE', phase: 'create-roles', sqlstate: '42601' });
 assert.ok(!JSON.stringify(result).includes('synthetic-sensitive-value'));
});
test('mount and authentication diagnostics never retain captured paths or values', () => {
 assert.deepEqual(safeBootstrapFailure('cat: /run/secrets/synthetic-sensitive-value: Permission denied'),
  { code: 'SECRET_READ_DENIED', phase: 'secret-read', sqlstate: null });
 assert.deepEqual(safeBootstrapFailure('FATAL: password authentication failed for user synthetic-sensitive-value'),
  { code: 'DATABASE_AUTH_FAILURE', phase: 'connect', sqlstate: null });
 assert.deepEqual(safeBootstrapFailure('arbitrary synthetic-sensitive-value'),
  { code: 'BOOTSTRAP_FAILURE_UNCLASSIFIED', phase: null, sqlstate: null });
});
test('unrecognized phase strings never become public diagnostics', () => {
 assert.deepEqual(safeBootstrapFailure('fresh database bootstrap failed at synthetic-sensitive-value (P0001)'),
  { code: 'BOOTSTRAP_FAILURE_UNCLASSIFIED', phase: null, sqlstate: null });
});

test('unclassified diagnostics scrub credentials, URLs and paths before bounding error lines', () => {
 const password = 'SyntheticOnlySecretValue01234567890123456789';
 const result = sanitizedBootstrapLines(`progress ignored\n/bin/sh: /private/path/job: ${password}\npsql: error: postgres://role:${password}@host/db failed\nError response from daemon: input device is not a TTY`, [password, password, password, password, password]);
 assert.ok(result.some(line => line.includes('input device is not a TTY')));
 assert.ok(!JSON.stringify(result).includes(password));
 assert.ok(!JSON.stringify(result).includes('postgres://'));
 assert.ok(!JSON.stringify(result).includes('/private/path'));
 assert.ok(!JSON.stringify(result).includes('progress ignored'));
 assert.ok(result.every(line=>line.length<=240));
});
test('eligibility observer exact session marker survives PostgreSQL application-name bounds', async () => {
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('./container-production-smoke.mjs',import.meta.url),'utf8');
 const prefix=source.match(/const windowName='([^']+)'\+randomUUID\(\);/)?.[1];
 assert.ok(prefix,'Actual observer name construction must be checked');
 const marker=prefix+'00000000-0000-0000-0000-000000000000';
 assert.equal(Buffer.from(marker).subarray(0,63).toString('utf8'),marker,'Server truncation must not invalidate the exact scoped predicate or cleanup marker');
 assert.ok(Buffer.byteLength(marker,'utf8')<=63);
 assert.ok(source.includes("application_name='${windowName}'"),'Observer and owned cleanup use the same full marker');
});
test('eligibility observer mutates guarded membership only as owner after its DBA wait', async () => {
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('./container-production-smoke.mjs',import.meta.url),'utf8');
 const sql=source.match(/const windowSql=`([\s\S]*?)`;/)?.[1];assert.ok(sql);
 const change=sql.indexOf('UPDATE scope_memberships');assert.ok(change>=0);
 assert.ok(sql.indexOf('END $window$;')<sql.indexOf('SET LOCAL ROLE continuum_owner'),'The DBA observes the backup before switching effective role');
 assert.ok(sql.indexOf('SET LOCAL ROLE continuum_owner')<change&&sql.indexOf('SET LOCAL ROLE continuum_owner')>=0,'The published table-owner guard must apply to the actual mutation');
 assert.match(sql,/GET DIAGNOSTICS changed = ROW_COUNT/);
 assert.ok(sql.indexOf('RESET ROLE;',change)>change&&sql.indexOf('RESET ROLE;',change)<sql.indexOf('COMMIT;',change));
});