import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./apply-role-profiles.sh', import.meta.url));
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
function run(mode, failPreflight = false) {
  const root = mkdtempSync(join(tmpdir(), 'continuum-profile-test-'));
  try {
    // This fake never connects to a database. It distinguishes the registry
    // preflight from packaged SQL grants and records whether mutation was tried.
    writeFileSync(join(root, 'psql'), `#!/bin/sh
has_file=0
for arg do
  case "$arg" in --file=*) has_file=1 ;; esac
done
printf '%s\\n' "$*" >> "$PROFILE_CALLS"
if [ "$has_file" = 0 ]; then
  cat > "$PROFILE_INPUT"
  if [ "$FAIL_PREFLIGHT" = 1 ]; then
    printf '%s\\n' 'upgrade role binding does not match stored identity; use reviewed rotation or restore procedure' >&2
    exit 42
  fi
fi
`, { mode: 0o755 });
    const env = {
      ...process.env, PATH: `${root}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      PROFILE_CALLS: join(root, 'calls'), PROFILE_INPUT: join(root, 'input'),
      FAIL_PREFLIGHT: failPreflight ? '1' : '0',
      CONTINUUM_RUNTIME_ASSETS: '/synthetic assets', CONTINUUM_APPLICATION_SCHEMA: 'synthetic',
      CONTINUUM_APP_ROLE: 'synthetic_app', CONTINUUM_OPERATOR_ROLE: 'synthetic_operator',
      CONTINUUM_SYNC_ROLE: 'synthetic_sync',
      CONTINUUM_ADMIN_PRINCIPAL_ID: '11111111-1111-4111-8111-111111111111',
      CONTINUUM_SYNC_PRINCIPAL_ID: '22222222-2222-4222-8222-222222222222',
    };
    delete env.CONTINUUM_MAINTENANCE_MODE;
    if (mode !== undefined) env.CONTINUUM_MAINTENANCE_MODE = mode;
    const result = spawnSync(shell, [script], { env, encoding: 'utf8', input: '', timeout: 5000 });
    const read = name => { try { return readFileSync(join(root, name), 'utf8'); } catch { return ''; } };
    return { ...result, calls: read('calls').trim().split('\n').filter(Boolean), sql: read('input') };
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    rmSync(root, { recursive: true, force: true });
  }
}
test('grant requires explicit fresh or upgrade mode before running psql', () => {
  for (const mode of [undefined, '', 'rotate']) {
    const result = run(mode);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONTINUUM_MAINTENANCE_MODE/);
    assert.deepEqual(result.calls, []);
  }
});
test('upgrade binding refusal prevents every grant and verifier invocation', () => {
  const result = run('upgrade', true);
  assert.equal(result.status, 42);
  assert.match(result.stderr, /upgrade role binding does not match stored identity/);
  assert.equal(result.calls.length, 1);
  assert.ok(!result.calls[0].includes('--file='));
  assert.match(result.calls[0], /--set=maintenance_mode=upgrade/);
});
test('fresh and upgrade retain one maintenance session across the existing exact grant scripts', () => {
  for (const mode of ['fresh', 'upgrade']) {
    const result = run(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.ok(!result.calls[0].includes('--file='));
    assert.match(result.calls[0], new RegExp(`--set=maintenance_mode=${mode}`));
    assert.match(result.calls[0], /--set=operator_application_grant=\/synthetic assets\/scripts\/grant-application-role\.sql/);
    assert.match(result.sql, /pg_try_advisory_lock\(7215328273579717613/);
    assert.match(result.sql, /pg_advisory_unlock\(7215328273579717613/);
    assert.equal((result.sql.match(/\\i :application_grant/g) ?? []).length, 1);
    assert.match(result.sql, /\\i :operator_grant/);
    assert.match(result.sql, /\\i :sync_grant/);
    assert.match(result.sql, /\\i :identity_verifier/);
  }
});


test('grant preflight rechecks current OP and SYNC eligibility before any grant include',()=>{
 const result=run('upgrade');assert.equal(result.status,0,result.stderr);
 const eligibility=result.sql.indexOf('role binding is ineligible');
 assert.ok(eligibility>=0);assert.ok(eligibility<result.sql.indexOf('\\i :application_grant'));
 for(const predicate of ["principal.kind = 'user'", "principal.disabled_at IS NULL", "membership.source_kind = 'manual'", "membership.source_id = 'manual'", "membership.role = 'admin' AND membership.active", "principal.kind = 'service'", 'continuum_require_sync_retirement_authority', 'continuum_unresolved_retired_sync_database_identities']) assert.ok(result.sql.includes(predicate),predicate);
});

test('packaged OP and SYNC grants lock and recheck eligibility in their own grant transactions',()=>{
 const operator=readFileSync(resolve(import.meta.dirname,'../scripts/grant-operator-role.sql'),'utf8');
 const application=readFileSync(resolve(import.meta.dirname,'../scripts/grant-application-role.sql'),'utf8');
 const sync=readFileSync(resolve(import.meta.dirname,'../scripts/grant-sync-role.sql'),'utf8');
 for(const [sql,kind] of [[operator,'operator'],[sync,'sync']]) {
  const begin=sql.indexOf('BEGIN;'),lock=sql.indexOf('FOR UPDATE OF principal'),register=sql.indexOf('continuum_register_trusted_database_identity('),commit=sql.lastIndexOf('COMMIT;');
  assert.ok(begin>=0&&lock>begin&&register>lock&&commit>register,`${kind} eligibility lock must surround registration and grants`);
  assert.match(sql,/role binding is ineligible:/);
 }
 assert.match(operator,/FOR UPDATE OF principal, membership/);
 assert.match(operator,/membership\.source_kind = 'manual'.*membership\.source_id = 'manual'/s);
 const lock=operator.indexOf('FOR UPDATE OF principal, membership'),nestedApplication=operator.indexOf('\\i :operator_application_grant'),register=operator.indexOf('continuum_register_trusted_database_identity(');
 assert.ok(lock<nestedApplication&&nestedApplication<register,'operator application privileges must remain inside the locked grant transaction');
 assert.match(application,/\\if :continuum_profile_transaction\s+\\else\s+BEGIN;/);
 assert.match(application,/\\if :continuum_profile_transaction\s+\\else\s+COMMIT;/);
 assert.match(sync,/principal\.kind = 'service'.*principal\.disabled_at IS NULL/s);
});
