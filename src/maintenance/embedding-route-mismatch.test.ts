import { expect, it, vi } from 'vitest';
import { standupConsumerFixture } from '../standup/test-helpers.js';
import { registerEmbeddingTargetForTest, withSyntheticTargetForTest } from '../embeddings/test-helpers.js';
import { createMemory } from '../storage/memories.js';
import { runEmbeddingBackfill } from './embed-backfill.js';

it('reports a durable route mismatch as incomplete and retains the first denied cursor, then repairs after real approval', async () => {
  await standupConsumerFixture(async f => {
    const expected = withSyntheticTargetForTest({ id: 'synthetic:backfill-expected', dim: 768, local: true,
      embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.125) as number[])) });
    const other = withSyntheticTargetForTest({ id: 'synthetic:backfill-other', dim: 768, local: true,
      embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.25) as number[])) });
    await registerEmbeddingTargetForTest(f.owner, expected, [f.scopeId]);
    await registerEmbeddingTargetForTest(f.owner, other, [f.scopeId]); // Actual durable route now differs from requested target.
    const source = await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId,
      type: 'fact', title: 'Mismatched target', body: 'Synthetic source, no provider I/O yet.', source: 'manual' });
    const scope = { kind: 'user' as const, name: (await f.app.query('SELECT name FROM scopes WHERE id=$1', [f.scopeId])).rows[0].name as string };
    const report = await runEmbeddingBackfill(f.owner, expected, { scope, batchSize: 1, maxRows: 10 });
    expect(report).toMatchObject({ completed: false, embedded: 0, failed: 0, cursor: null });
    expect(report.errorCodes).toContain('BACKFILL_STORE');
    expect(expected.embed).not.toHaveBeenCalled(); expect(other.embed).not.toHaveBeenCalled();
    expect((await f.owner.query('SELECT 1 FROM embedding_backfill_failures WHERE memory_id=$1', [source.id])).rows).toEqual([]);
    expect((await f.owner.query('SELECT 1 FROM memory_embeddings WHERE memory_id=$1', [source.id])).rows).toEqual([]);
    expect((await f.owner.query('SELECT cursor FROM embedding_backfill_checkpoints WHERE provider=$1', [expected.id])).rows).toEqual([]);
    await registerEmbeddingTargetForTest(f.owner, expected, [f.scopeId]);
    expect(await runEmbeddingBackfill(f.owner, expected, { scope, batchSize: 1, maxRows: 10 }))
      .toMatchObject({ completed: true, embedded: 1 });
    expect(expected.embed).toHaveBeenCalledOnce();
  });
}, 60000);
