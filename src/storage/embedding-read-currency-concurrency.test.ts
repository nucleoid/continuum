import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { embeddingQueueFixture } from '../embeddings/test-helpers.js';
import { captureMemory } from '../services/capture.js';
import { processEmbeddingJobs } from '../workers/embedding-jobs.js';
import { SqlEmbeddingJobStore } from './embedding-jobs.js';
import { vectorSearchMemoryIds } from './embeddings.js';

it.each(['body', 'related-only'] as const)('does not let a read-only vector transaction reject an ordinary %s update', async kind => {
  await embeddingQueueFixture(async f => {
    const captured = await captureMemory(f.app, f.router, f.principal, {
      scope: { kind: f.scope.kind, name: f.scope.name }, type: 'fact',
      title: 'Read currency concurrency', body: 'Original published source.', source: 'manual',
    });
    await f.app.query('SELECT continuum_evidence_source($1,$2)', [f.actorId, captured.memory.id]);
    expect(await processEmbeddingJobs(new SqlEmbeddingJobStore(f.worker), f.target, f.policy,
      f.provider, f.profile, randomUUID())).toBe('processed');
    const before = (await f.owner.query('SELECT generation FROM embedding_sources WHERE memory_id=$1', [captured.memory.id])).rows[0];
    const reader = await f.app.connect();
    const writer = await f.app.connect();
    try {
      await reader.query('BEGIN');
      expect(await vectorSearchMemoryIds(reader, Array(768).fill(0.125), [f.scopeId], f.provider, 1))
        .toEqual([{ id: captured.memory.id, distance: 0 }]);
      await writer.query('BEGIN');
      let writeError: unknown;
      try {
        const result = kind === 'body'
          ? await writer.query('UPDATE memories SET body=body||$2 WHERE id=$1', [captured.memory.id, ' Revised.'])
          : await writer.query(`UPDATE memories SET metadata=jsonb_set(metadata,'{related}','[]'::jsonb) WHERE id=$1`, [captured.memory.id]);
        expect(result.rowCount).toBe(1);
        await writer.query('COMMIT');
      } catch (error) { writeError = error; await writer.query('ROLLBACK'); }
      // The real read has returned but its transaction remains open throughout
      // the write. No owner root locks, trigger bypass or timeout changes.
      expect(writeError).toBeUndefined();
      const after = (await f.owner.query('SELECT generation FROM embedding_sources WHERE memory_id=$1', [captured.memory.id])).rows[0];
      expect(after.generation === before.generation).toBe(kind === 'related-only');
      expect((await f.app.query('SELECT continuum_embedding_vector_is_current($1,$2,768) AS current',
        [captured.memory.id, f.provider.id])).rows[0].current).toBe(kind === 'related-only');
    } finally {
      await writer.query('ROLLBACK'); writer.release();
      await reader.query('ROLLBACK'); reader.release();
    }
  });
}, 60000);
