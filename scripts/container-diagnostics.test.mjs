import test from 'node:test';
import assert from 'node:assert/strict';
import { safeBootstrapFailure } from './container-diagnostics.mjs';

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
