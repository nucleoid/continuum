import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = 10_000;

function spawnEntrypoint(relativePath, env) {
  return spawn(process.execPath, [resolve(root, relativePath)], {
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

async function waitForApiReady(child, output) {
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`API readiness timed out. stdout=${JSON.stringify(output.stdout)} stderr=${JSON.stringify(output.stderr)}`));
    }, timeoutMs);

    const finish = (callback) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      callback();
    };
    const onData = () => {
      if (output.stdout.includes('Continuum API listening on :0')) {
        finish(resolveReady);
      }
    };
    const onError = (error) => finish(() => reject(error));
    const onExit = (code, signal) => finish(() => reject(new Error(
      `API exited before readiness (code=${code}, signal=${signal}). stdout=${JSON.stringify(output.stdout)} stderr=${JSON.stringify(output.stderr)}`,
    )));

    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    onData();
  });
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
  const child = spawnEntrypoint('dist/api/server.js', {
    ...process.env,
    CONTINUUM_API_PORT: '0',
    CONTINUUM_DATABASE_URL: 'postgres://continuum:continuum@127.0.0.1:1/continuum',
  });
  const output = captureOutput(child);
  try {
    await waitForApiReady(child, output);
  } finally {
    await terminate(child);
  }
  process.stdout.write('API compiled entrypoint reached readiness\n');
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

await smokeApi();
await smokeMcpValidation();
