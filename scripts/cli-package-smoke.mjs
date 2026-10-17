import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'continuum-package-smoke-'));

try {
  const packed = JSON.parse(execFileSync(
    'npm', ['pack', '--json', '--pack-destination', temporary],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
  ));
  const tarball = join(temporary, packed[0].filename);
  const compiledTests = packed[0].files.filter(
    ({ path }) => /\.(?:test|spec)\.(?:js|d\.ts)(?:\.map)?$/.test(path)
      || /(?:^|\/)test-helpers\.(?:js|d\.ts)(?:\.map)?$/.test(path),
  );
  if (compiledTests.length > 0) {
    throw new Error(
      `Packed package contains compiled tests: ${compiledTests.map(({ path }) => path).join(', ')}`,
    );
  }
  const sourceMaps = packed[0].files.filter(({ path }) => path.endsWith('.map'));
  if (sourceMaps.length > 0) {
    throw new Error(
      `Packed package contains source maps without packaged sources: ${sourceMaps.map(({ path }) => path).join(', ')}`,
    );
  }
  const forbidden = packed[0].files.filter(
    ({ path }) => path === 'docs/internal-security-brief.md' || /(?:^|\/)tenants?(?:\/|$)/i.test(path),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Packed package contains internal or tenant-specific material: ${forbidden.map(({ path }) => path).join(', ')}`,
    );
  }
  execFileSync(
    'npm', ['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: root, stdio: 'pipe', shell: process.platform === 'win32' },
  );
  const launcher = join(temporary, 'node_modules', '@continuum', 'core', 'bin', 'continuum.mjs');
  const output = execFileSync(process.execPath, [launcher, '--help'], {
    cwd: temporary,
    encoding: 'utf8',
    env: { ...process.env, CONTINUUM_TOKEN: '' },
  });
  if (!output.startsWith('Usage: continuum <command>')) {
    throw new Error(`Unexpected CLI help output: ${JSON.stringify(output)}`);
  }
  const packageJson = JSON.parse(readFileSync(
    join(temporary, 'node_modules', '@continuum', 'core', 'package.json'), 'utf8',
  ));
  if (packageJson.bin?.continuum !== 'bin/continuum.mjs') {
    throw new Error('Packed package does not expose the continuum binary');
  }
  if (packageJson.bin?.['continuum-migrate'] !== 'bin/continuum-migrate.mjs') {
    throw new Error('Packed package does not expose the migration binary');
  }
  if (packageJson.bin?.['continuum-tags'] !== 'bin/continuum-tags.mjs') {
    throw new Error('Packed package does not expose the tag vocabulary binary through its wrapper');
  }
  const installedRoot = join(temporary, 'node_modules', '@continuum', 'core');
  for (const required of [
    'migrations/0001_init.sql',
    'migrations/0004_review_queue_index.sql',
    'migrations/0007_decision_supersession_constraints.sql',
    'migrations/0008_decision_supersession_validation.sql',
    'migrations/0009_decision_supersession_unique_index.sql',
    'migrations/0073_coordination_bounded_discovery_and_locking.sql',
    'migrations/0074_coordination_compatibility_and_upgrade_repair.sql',
    'migrations/0075_coordination_online_repair_finish.sql',
    'migrations/0076_coordination_review_2_remediation.sql',
    'migrations/0077_coordination_review_2_online_finish.sql',
    'migrations/0078_coordination_upgrade_scale_indexes.sql',
    'migrations/0079_coordination_upgrade_scale_remediation.sql',
    'migrations/0080_pgvector_provider_grants.sql',
    'migrations/0081_coordination_public_contract.sql',
    'migrations/0083_tag_vocabularies.sql',
    'migrations/0084_provider_embeddings_backfill.sql',
    'migrations/0085_embedding_backfill_failures.sql',
    'migrations/0086_embedding_backfill_failure_disposition.sql',
    'migrations/0087_embedding_provider_scan_index.sql',
    'migrations/0088_embedding_provider_scan_index_rebuild.sql',
    'migrations/0090_standup_activity.sql',
    'docs/standup.md',
    'docs/deployment.md',
    'deploy/container-entrypoint.mjs',
    'deploy/compose.production.yml',
    'deploy/production.env.example',
    'deploy/bootstrap-database.sql',
    'deploy/bootstrap-production-admin.sql',
    'deploy/apply-role-profiles.sh',
    'dist/maintenance/embed-backfill-cli.js',
    'bin/continuum-migrate.mjs',
    'scripts/ensure-scope.mjs',
    'scripts/create-scope-operator.sql',
    'scripts/retire-scope-operator.sql',
    'scripts/enable-tag-legacy-writer-compat.sql',
    'scripts/restore-tag-strict-enforcement.sql',
    'docs/audit-retention.md',
    'docs/coordination.md',
    'docs/memory-api.md',
    'docs/tag-vocabularies.md',
    'docs/embedding-backfill.md',
    'docs/webhook-ingestion.md',
  ]) {
    if (!existsSync(join(installedRoot, required))) {
      throw new Error(`Packed package is missing required runtime artifact: ${required}`);
    }
  }
  for (const directory of ['migrations', 'scripts']) {
    for (const name of readdirSync(join(root, directory)).filter(name => name.endsWith('.sql'))) {
      const relative = join(directory, name);
      if (!readFileSync(join(root, relative)).equals(readFileSync(join(installedRoot, relative)))) {
        throw new Error(`Packaged SQL differs from its committed source: ${relative}`);
      }
    }
  }
  const containerHelp = execFileSync(process.execPath,
    [join(installedRoot, 'deploy/container-entrypoint.mjs'), 'continuum', '--help'], {
      cwd: temporary, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, CONTINUUM_TOKEN: undefined },
    });
  if (!containerHelp.startsWith('Usage: continuum <command>')) {
    throw new Error('Installed container launcher did not preserve wrapper argv');
  }
  const installedTagLauncher = join(
    temporary,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'continuum-tags.cmd' : 'continuum-tags',
  );
  const tagResult = spawnSync(installedTagLauncher, ['--invalid-smoke-argument'], {
    cwd: temporary,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, CONTINUUM_BEARER: '' },
  });
  if (tagResult.status !== 1 || !tagResult.stderr.startsWith('continuum-tags: Usage:')) {
    throw new Error(
      `Installed continuum-tags launcher did not execute: ${JSON.stringify(tagResult)}`,
    );
  }
  const embeddingResult = spawnSync(process.execPath,
    [join(installedRoot, 'dist/maintenance/embed-backfill-cli.js'), '--batch-size', '0'], {
      cwd: temporary, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { ...process.env, CONTINUUM_DATABASE_URL: '' },
    });
  if (embeddingResult.error || embeddingResult.status !== 1
    || !embeddingResult.stderr.startsWith('continuum-embed-backfill: --batch-size must be')) {
    throw new Error('Installed embedding backfill entrypoint did not reach bounded option validation');
  }
  for (const migrationDoc of ['README.md', 'docs/cli.md']) {
    const contents = readFileSync(join(installedRoot, migrationDoc), 'utf8');
    if (!contents.includes('CONTINUUM_DATABASE_URL')) {
      throw new Error(`${migrationDoc} does not document the migration database configuration`);
    }
    if (/set `DATABASE_URL`/.test(contents)) {
      throw new Error(`${migrationDoc} documents the unsupported DATABASE_URL variable`);
    }
  }
  const { pathToFileURL } = await import('node:url');
  const { runMigrations } = await import(
    pathToFileURL(join(installedRoot, 'dist', 'storage', 'migrator.js')).href
  );
  const migrationNames = packed[0].files
    .filter(({ path }) => /^migrations\/[^/]+\.sql$/.test(path))
    .map(({ path }) => path.slice('migrations/'.length));
  const discoveredMigrations = new Set();
  const contractSource = readFileSync(join(installedRoot,
    'migrations/0081_coordination_public_contract.sql'), 'utf8').replaceAll('\r\n', '\n');
  const contractBodies = new Map();
  for (const name of ['continuum_coordination_require_contract_ready',
    'continuum_backfill_coordination_contract']) {
    const definition = contractSource.match(new RegExp(
      `CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
    ));
    if (!definition) throw new Error(`Packaged contract function definition is missing: ${name}`);
    contractBodies.set(name, definition[1]);
  }
  let verifiedContractBodies = 0;
  let contractBackfillCalls = 0;
  let completedContractAttempts = 0;
  let vectorExtensionCreated = false;
  const client = {
    async query(sql, values = []) {
      // Catalog qualification changes resolution, not the mocked query shape.
      // Match both forms while the migrator retains the original SQL evidence.
      const statement = String(sql).replace(/\bpg_catalog\./g, '');
      if (statement.includes('pg_try_advisory_lock')) {
        return { rowCount: 1, rows: [{ locked: true }] };
      }
      if (statement.includes("current_setting('search_path') AS path")
          && statement.includes('LEFT JOIN pg_namespace')) {
        return {
          rowCount: 1,
          rows: [{
            path: 'public',
            schema: 'public',
            owned: true,
            unsafeCreate: false,
            userSchemaExists: false,
          }],
        };
      }
      if (statement.includes("extension.extname = 'vector'")) {
        return vectorExtensionCreated
          ? { rowCount: 1, rows: [{ schema: 'continuum_extensions' }] }
          : { rowCount: 0, rows: [] };
      }
      if (statement.includes("to_regclass(format('%I._continuum_migrations'")) {
        return { rowCount: 1, rows: [{ exists: false }] };
      }
      if (statement.includes('namespace.nspowner = role.oid AS owned')) {
        return { rowCount: 1, rows: [{ owned: true, unsafeCreate: false }] };
      }
      if (statement.includes("to_regnamespace($1) IS NOT NULL AS exists")) {
        return { rowCount: 1, rows: [{ exists: false }] };
      }
      if (statement.includes('CREATE EXTENSION vector')) {
        vectorExtensionCreated = true;
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("has_schema_privilege(current_user, $1, 'USAGE')")) {
        return { rowCount: 1, rows: [{ allowed: true, role: 'continuum_smoke' }] };
      }
      if (statement.includes('AS "tenantObjects"')) {
        return { rowCount: 1, rows: [{ tenantObjects: false }] };
      }
      if (statement.includes('AS "vectorType"')) {
        return { rowCount: 1, rows: [{ vectorType: false, vectorOpclass: false }] };
      }
      if (statement.includes("current_setting('search_path') AS path")) {
        return { rowCount: 1, rows: [{ path: 'public' }] };
      }
      // This fixture represents an already migrated package database. Supply
      // catalog bodies from the installed SQL, not invented verifier output.
      if (statement.includes('SELECT function.prosrc')
          && statement.includes('to_regprocedure')) {
        const body = contractBodies.get(values[0]);
        if (body === undefined) throw new Error('Unexpected packaged function verification');
        verifiedContractBodies += 1;
        return { rowCount: 1, rows: [{ prosrc: body, owner: true, language: 'plpgsql',
          prosecdef: true, hardened: true, publicExecute: false }] };
      }
      if (statement.startsWith('SELECT continuum_backfill_coordination_contract($1)')) {
        if (!Number.isInteger(values[0]) || values[0] < 1 || values[0] > 1000) {
          throw new Error('Packaged contract backfill exceeded its bounded batch');
        }
        contractBackfillCalls += 1;
        return { rowCount: 1, rows: [{ completed: true }] };
      }
      if (statement.includes('UPDATE _continuum_migration_execution SET state=\'completed\'')) {
        completedContractAttempts += 1;
        return { rowCount: 1, rows: [] };
      }
      if (statement.includes('FROM _continuum_migrations')) {
        if (statement.includes('SELECT 1 FROM _continuum_migrations WHERE name = $1')) {
          discoveredMigrations.add(values[0]);
        }
        return { rowCount: 1, rows: [] };
      }
      if (statement.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  await runMigrations({ connect: async () => client });
  if (migrationNames.some((name) => !discoveredMigrations.has(name))) {
    throw new Error('Packed migrator did not discover every packaged migration');
  }
  if (verifiedContractBodies !== 4 || contractBackfillCalls !== 1 || completedContractAttempts !== 1) {
    throw new Error('Packed migrator did not verify and finish the ledgered contract backfill');
  }
  process.stdout.write('Packed continuum CLI entrypoint passed\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
