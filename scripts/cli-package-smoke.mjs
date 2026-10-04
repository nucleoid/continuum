import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  process.stdout.write('Packed continuum CLI entrypoint passed\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
