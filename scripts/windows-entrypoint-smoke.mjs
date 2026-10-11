import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = 10_000;

function spawnEntrypoint(relativePath, env, args = []) {
  return spawn(process.execPath, [resolve(root, relativePath), ...args], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function captureOutput(child) {
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk;
  });
  return output;
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  let timeout;
  const exit = once(child, 'exit');
  child.kill();
  const result = await Promise.race([
    exit.then(() => 'exited'),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout('timeout'), 5_000);
    }),
  ]);
  clearTimeout(timeout);
  if (result === 'timeout' && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function smokeApi() {
  // This platform job has no PostgreSQL service. Startup must execute its
  // database preflight and fail closed, rather than listen without verification.
  const result = await runToExit('dist/api/server.js', {
    ...process.env,
    CONTINUUM_AUTH_MODE: 'dev',
    CONTINUUM_API_PORT: '0',
    CONTINUUM_DATABASE_URL: 'postgres://continuum:continuum@127.0.0.1:1/continuum',
  });
  const failure = result.stderr.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).find((event) => event?.event === 'startup_failed');
  if (result.code !== 1 || result.signal !== null || failure?.error?.code !== 'ECONNREFUSED'
    || result.stdout.includes('Continuum API listening')) {
    throw new Error(`API did not fail its database preflight clearly: ${JSON.stringify(result)}`);
  }
  process.stdout.write('API compiled entrypoint failed closed during database preflight\n');
}

async function smokeMcpValidation() {
  const env = { ...process.env };
  delete env.CONTINUUM_PRINCIPAL_EXTERNAL_ID;
  delete env.CONTINUUM_BEARER;

  const child = spawnEntrypoint('dist/api/mcp.js', env);
  const output = captureOutput(child);
  const exit = once(child, 'exit');
  let timeout;
  const result = await Promise.race([
    exit.then(([code, signal]) => ({ code, signal })),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(null), timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  if (result === null) {
    await terminate(child);
    throw new Error(`MCP validation timed out. stdout=${JSON.stringify(output.stdout)} stderr=${JSON.stringify(output.stderr)}`);
  }

  if (result.code === 0 || !output.stderr.includes('continuum-mcp: set CONTINUUM_PRINCIPAL_EXTERNAL_ID')) {
    throw new Error(
      `MCP did not execute production validation (code=${result.code}, signal=${result.signal}). stdout=${JSON.stringify(output.stdout)} stderr=${JSON.stringify(output.stderr)}`,
    );
  }
  process.stdout.write('MCP compiled entrypoint reached principal validation\n');
}

async function runToExit(relativePath, env, args = []) {
  const child = spawnEntrypoint(relativePath, env, args);
  const output = captureOutput(child);
  let timeout;
  try {
    const result = await Promise.race([
      once(child, 'close').then(([code, signal]) => ({ code, signal, ...output })),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Entrypoint ${relativePath} timed out`)), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timeout);
    await terminate(child);
  }
}

async function smokeDisabledAuditRetention() {
  const env = {
    ...process.env,
    CONTINUUM_AUDIT_RETENTION_BATCH_SIZE: 'malformed-but-disabled',
    CONTINUUM_AUDIT_RETENTION_EXPORT_DIR: 'relative-but-disabled',
  };
  delete env.CONTINUUM_AUDIT_RETENTION_DAYS;
  const result = await runToExit('dist/maintenance/audit-retention-cli.js', env);
  if (result.code !== 0 || result.stdout.trim() !== '{"status":"disabled"}') {
    throw new Error(`Disabled retention smoke failed: ${JSON.stringify(result)}`);
  }
  process.stdout.write('Audit retention disabled entrypoint ignored inactive tuning\n');
}

async function smokeWindowsAuditExportRejection() {
  if (process.platform !== 'win32') return;
  const result = await runToExit('dist/maintenance/audit-retention-cli.js', {
    ...process.env,
    CONTINUUM_AUDIT_RETENTION_DAYS: '30',
    CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID: 'smoke-admin',
    CONTINUUM_AUDIT_RETENTION_EXPORT_DIR: root,
    CONTINUUM_DATABASE_URL: 'postgres://continuum:continuum@127.0.0.1:1/continuum',
  });
  if (result.code === 0 || !result.stderr.includes('Durable audit export is not supported on Windows')) {
    throw new Error(`Windows audit export did not fail clearly: ${JSON.stringify(result)}`);
  }
  process.stdout.write('Audit retention rejected unsupported Windows export before database access\n');
}

async function smokeTagCliValidation() {
  const env = { ...process.env };
  delete env.CONTINUUM_BEARER;
  const result = await runToExit('dist/cli/tag-vocabularies.js', env, ['list', 'project']);
  if (result.code === 0 || !result.stderr.includes('CONTINUUM_BEARER is required')) {
    throw new Error(
      `Tag CLI did not execute credential validation: ${JSON.stringify(result)}`,
    );
  }
  process.stdout.write('Tag CLI compiled entrypoint reached credential validation\n');
}

await smokeApi();
await smokeMcpValidation();
await smokeDisabledAuditRetention();
await smokeWindowsAuditExportRejection();
await smokeTagCliValidation();
