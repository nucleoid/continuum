// Full real-PG source suite prerequisite: POSIX signal semantics (Linux CI).
// Windows child.kill(SIGTERM) force-terminates; this draft does not pretend that proves graceful shutdown.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { captureMemory } from '../services/capture.js';
import { readEmbeddingStatus } from '../storage/embedding-jobs.js';

it('loads an external trusted composition through the actual worker launcher, completes one real job and exits cleanly on SIGTERM', async () => {
  // No skip branch: target the existing Linux real-PG source gate, where SIGTERM
  // really reaches the Node listener. A Windows force-kill is not an accepted pass.
  await embeddingQueueFixture(async f => {
    const application = resolve(process.cwd());
    const launcher = join(application, 'bin', 'continuum-embed-worker.mjs');
    const targetModule = pathToFileURL(join(application, 'dist', 'embeddings', 'target.js')).href;
    await readFile(launcher); // Missing compiled/package artifacts fail, no install/download/build fallback.
    const tempRoot = resolve(tmpdir());
    const privateDirectory = await mkdtemp(join(tempRoot, 'continuum-worker-startup-'));
    if (!isAbsolute(privateDirectory) || dirname(privateDirectory) !== tempRoot
      || !basename(privateDirectory).startsWith('continuum-worker-startup-')) throw new Error('Owned worker fixture directory identity unavailable');
    try {
    const modulePath = join(privateDirectory, 'composition.mjs');
    const schema = (await f.owner.query('SELECT current_schema() AS name')).rows[0].name as string;
    const workerConnection = f.worker.options.connectionString;
    if (typeof workerConnection !== 'string' || !workerConnection) throw new Error('Actual isolated worker URL unavailable');
    // Runtime module lives outside the app; absolute file URL resolves public
    // target helper in the exact built installation, independent of child cwd.
    const composition = `import { embeddingTarget } from ${JSON.stringify(targetModule)};
const expected = ${JSON.stringify(f.target)};
const target = embeddingTarget({space:expected.space,endpoint:'http://fixture.invalid/embedding',local:true});
if (target.fingerprint !== expected.fingerprint) throw new Error('Synthetic target identity mismatch');
const policy = ${JSON.stringify(f.policy)};
const profile = ${JSON.stringify(f.profile)};
const adapter = {
  id:target.space.provider, model:target.space.model, profile:target.space.profile, local:true,
  timeoutMs:1000, credentials:'not-required', responseBodyBytes:131072,
  enforceableCaps:true, cancellation:'cooperative', outputTokens:0, reasoningTokens:0, completionTokens:0,
  tokens:{kind:'exact',model:target.space.model,profile:target.space.profile,
    validationId:'synthetic-byte-only-v1',overheadTokens:0,count:value=>Buffer.byteLength(value)},
  price:{id:'local-zero-v1',currency:'USD',unitTokens:1,inputMicros:0,outputMicros:0,reasoningMicros:0},
  serialize:input=>({input}),
  invoke:async serialized=>{const input=JSON.parse(serialized).input;
    const value=input.map(()=>Array(768).fill(0.125));return {value,response:value};}
};
const provider={id:adapter.id,dim:768,local:true,target,batchSize:32,timeoutMs:1000,pipelineAdapter:adapter,
  embed:async()=>{throw new Error('Unaccounted provider path is forbidden');}};
export function createEmbeddingWorkerTargets(){return [{target,policy,profile,provider}];}
`;
    await writeFile(modulePath, composition, { encoding: 'utf8', mode: 0o600 });
    const accepted = await captureMemory(f.app, f.router, f.principal, {
      scope: { kind: f.scope.kind, name: f.scope.name }, type: 'fact', title: 'CLI startup source',
      body: 'Synthetic zero-priced local fixture; no hosted call or graph-quality claim.', source: 'manual',
    }, {}, { idempotencyKey: 'worker-startup-source' });
    expect(accepted.embeddingStatus).toBe('queued');
    const child = spawn(process.execPath, ['--max-old-space-size=384', launcher], {
      cwd: privateDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env,
        CONTINUUM_EMBEDDING_WORKER_DATABASE_URL: workerConnection,
        CONTINUUM_EMBEDDING_WORKER_COMPOSITION: modulePath,
        CONTINUUM_APPLICATION_SCHEMA: schema,
      },
    });
    let closed = false;
    let failure: Error | undefined;
    let stdout = '', stderr = '';
    child.stdout!.on('data', bytes => { stdout = (stdout + String(bytes)).slice(-32768); });
    child.stderr!.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-32768); });
    child.once('error', error => { failure = error; });
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    // Timeout observes the existing5s callback+5s pool cleanup bounds plus scheduling.
    // A forced cleanup cannot turn a graceful-shutdown failure into a passing result.
    const exitWithin = async (milliseconds: number) => {
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([completion, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned worker did not exit within the observation bound')), milliseconds);
      })]); } finally { if (timer) clearTimeout(timer); }
    };
    try {
      const deadline = Date.now() + 20000;
      let ready = false;
      while (Date.now() < deadline) {
        if (failure) throw new Error('Owned worker failed to start');
        if (closed) throw new Error('Owned worker exited before completing its source');
        const status = await readEmbeddingStatus(f.app, f.actorId, accepted.memory.id);
        if (status?.embeddingStatus === 'ready' && status.embedded) { ready = true; break; }
        await delay(50);
      }
      expect(ready).toBe(true);
      const vector = (await f.owner.query(`SELECT e.provider,e.dim,e.source_generation,e.space_fingerprint,
        s.generation FROM memory_embeddings e JOIN embedding_sources s ON s.memory_id=e.memory_id WHERE e.memory_id=$1`,
        [accepted.memory.id])).rows;
      expect(vector).toHaveLength(1);
      expect(vector[0]).toMatchObject({ provider: f.provider.id, dim: 768, space_fingerprint: f.target.spaceFingerprint });
      expect(vector[0].source_generation).toBe(vector[0].generation);
      const audit = async () => (await f.owner.query(`SELECT count(*)::int AS n FROM audit_log
        WHERE memory_id=$1 AND metadata->>'operation'='embedding_completed'`, [accepted.memory.id])).rows[0].n;
      expect(await audit()).toBe(1);
      expect(f.adapter.invoke).not.toHaveBeenCalled(); // Real CHILD composition, not the parent test's provider mock.
      expect(child.kill('SIGTERM')).toBe(true);
      expect(await exitWithin(12000)).toEqual({ code: 0, signal: null });
      // Boolean assertions avoid printing even an unexpected credential-bearing log.
      expect(stdout.includes(workerConnection) || stderr.includes(workerConnection)).toBe(false);
      expect(stderr.includes('embedding_shutdown_unsettled')).toBe(false);
      expect(stderr.includes('continuum_embedding_worker_failed')).toBe(false);
      expect(await audit()).toBe(1);
      expect((await f.owner.query('SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE usename=$1',
        [f.workerRole])).rows).toEqual([{ n: 0 }]);
    } finally {
      if (!closed) {
        child.kill('SIGTERM');
        try { await exitWithin(12000); }
        catch { child.kill('SIGKILL'); await exitWithin(5000); }
      }
    }
    } finally {
      // Generated identity checked above; never delete installation/runtime/config directories.
      await rm(privateDirectory, { recursive: true, force: true });
    }
  });
}, 60000);
