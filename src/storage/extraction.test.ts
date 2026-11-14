import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { standupProducerFixture } from '../standup/test-helpers.js';
import { createMemory } from './memories.js';
import { starterProfile } from '../pipeline/budget.js';
import { captureMemory } from '../services/capture.js';
import { getPrincipal } from './principals.js';

it('preserves the original capture audit boundary when extraction is not configured', async () => {
  await standupProducerFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!;
    const scope = (await f.app.query('SELECT name FROM scopes WHERE id=$1', [f.scopeId])).rows[0].name;
    const result = await captureMemory(f.app, null, actor, { scope: { kind: 'user', name: scope },
      type: 'decision', title: 'Ordinary capture', body: 'Original source', source: 'manual' });
    expect(result.extraction).toEqual({ status: 'not-configured' });
    expect((await f.owner.query('SELECT action FROM audit_log WHERE memory_id=$1 ORDER BY id', [result.memory.id])).rows).toEqual([{ action: 'write' }]);
  });
}, 120_000);

it('requires operator installation plus scope-admin opt-in and atomically enqueues exact captured sources', async () => {
  await standupProducerFixture(async f => {
    const descriptor = { id: 'synthetic-v1', version: 'v1', adapter: 'synthetic', model: 'synthetic', adapterProfile: 'synthetic',
      locality: 'local', schema: 'extraction-v1', prompt: 'source-reference-v1', chunkBytes: 1024, maxChunks: 4,
      budget: { ...starterProfile, overallMs: 20_000 }, responseBodyBytes: 8192, outputTokens: 2048,
      reasoningTokens: 0, completionTokens: 2048, accounting: { kind: 'exact', validationId: 'synthetic-v1', model: 'synthetic', profile: 'synthetic', overheadTokens: 0 },
      price: { id: 'local-zero-v1', currency: 'USD', unitTokens: 1, inputMicros: 0, outputMicros: 0, reasoningMicros: 0 }, hash: '0'.repeat(64) };
    const capture = () => createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'decision', title: 'Preserved source', body: 'This exact source remains authoritative.', source: 'manual' });
    const disabled = await capture();
    expect((await f.owner.query('SELECT count(*)::int AS n FROM extraction_runs WHERE memory_id=$1', [disabled.id])).rows[0].n).toBe(0);
    await expect(f.app.query('SELECT continuum_operator_install_extractor($1,$2,TRUE)', [f.adminId, descriptor])).rejects.toMatchObject({ code: '42501' });
    await f.operator.query('SELECT continuum_operator_install_extractor($1,$2,TRUE)', [f.adminId, descriptor]);
    await expect(f.app.query('SELECT continuum_extraction_configure($1,$2,$3,$4,TRUE)', [f.actorId, f.scopeId, 'synthetic-v1', ['manual']])).rejects.toMatchObject({ code: '42501' });
    await f.owner.query("UPDATE scope_memberships SET role='admin' WHERE principal_id=$1 AND scope_id=$2", [f.actorId, f.scopeId]);
    await f.app.query('SELECT continuum_extraction_configure($1,$2,$3,$4,TRUE)', [f.actorId, f.scopeId, 'synthetic-v1', ['manual']]);
    const memory = await capture();
    const run = (await f.owner.query('SELECT * FROM extraction_runs WHERE memory_id=$1', [memory.id])).rows[0];
    expect(run.state).toBe('queued'); expect(run.source_version).toEqual(expect.any(String));
    expect((await f.owner.query('SELECT body FROM memories WHERE id=$1', [memory.id])).rows[0].body).toBe(memory.body);
    const client = await f.app.connect();
    try {
      await client.query('BEGIN');
      const rolled = await createMemory(client, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
        type: 'decision', title: 'Rollback', body: 'Never committed', source: 'manual' });
      await client.query('ROLLBACK');
      expect((await f.owner.query('SELECT count(*)::int AS n FROM extraction_runs WHERE memory_id=$1', [rolled.id])).rows[0].n).toBe(0);
    } finally { client.release(); }
    const reader = randomUUID();
    await expect(f.app.query('SELECT continuum_extraction_status($1,$2,FALSE)', [reader, memory.id])).rejects.toMatchObject({ code: '42501' });
  });
}, 120_000);
