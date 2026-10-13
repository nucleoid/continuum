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
 const result = sanitizedBootstrapLines(`progress ignored\n/bin/sh: /private/path/job: ${password}\npsql: error: postgres://role:${password}@host/db failed\nError response from daemon: input device is not a TTY`, [password]);
 assert.ok(result.some(line => line.includes('input device is not a TTY')));
 assert.ok(!JSON.stringify(result).includes(password));
 assert.ok(!JSON.stringify(result).includes('postgres://'));
 assert.ok(!JSON.stringify(result).includes('/private/path'));
 assert.ok(!JSON.stringify(result).includes('progress ignored'));
 assert.ok(result.every(line=>line.length<=240));
});