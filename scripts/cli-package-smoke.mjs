import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    'migrations/0010_tag_vocabularies.sql',
    'bin/continuum-migrate.mjs',
    'scripts/ensure-scope.mjs',
    'scripts/create-scope-operator.sql',
    'scripts/retire-scope-operator.sql',
    'scripts/enable-tag-legacy-writer-compat.sql',
    'scripts/restore-tag-strict-enforcement.sql',
    'docs/audit-retention.md',
    'docs/memory-api.md',
    'docs/tag-vocabularies.md',
  ]) {
    if (!existsSync(join(installedRoot, required))) {
      throw new Error(`Packed package is missing required runtime artifact: ${required}`);
    }
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
  let ledgerChecks = 0;
  const client = {
    async query(sql) {
      if (String(sql).includes('FROM _continuum_migrations')) {
        ledgerChecks += 1;
        return { rowCount: 1, rows: [] };
      }
      if (String(sql).includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  await runMigrations({ connect: async () => client });
  if (ledgerChecks < 10) throw new Error('Packed migrator did not discover packaged migrations');
  process.stdout.write('Packed continuum CLI entrypoint passed\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
