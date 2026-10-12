import { expect, it } from 'vitest';
import type { RecallResult } from '../types.js';
import { applyRetrievalEnrichers, RetrievalEnricherRegistry } from './retrieval.js';

it('keeps one enricher Date mutation from changing a sibling ranked input or core result', async () => {
  const created = '2026-01-01T00:00:00.000Z';
  const base: RecallResult = {
    memory: { id: '00000000-0000-4000-8000-000000000001',
      scopeId: '00000000-0000-4000-8000-000000000002',
      authorId: '00000000-0000-4000-8000-000000000003',
      type: 'fact', title: 'Reference', body: 'Small body', metadata: {}, tags: [],
      source: 'manual', sourceRef: null, state: 'live', supersedesId: null, promotedToId: null,
      createdAt: new Date(created), updatedAt: new Date(created), expiresAt: null, lastVerified: null },
    score: 0.5, excerpt: 'Small body', bodyTruncated: false,
  };
  const registry = new RetrievalEnricherRegistry();
  registry.register({ id: 'alpha', enrich: async (results) => {
    // An immutable wrapper may reject this attempt; either way a sibling's
    // authorized ranked snapshot and the original core record must be stable.
    try { results[0].memory.createdAt.setTime(0); } catch {}
    return [{ attempted: true }];
  } });
  registry.register({ id: 'beta', enrich: async (results) =>
    [{ observed: results[0].memory.createdAt.toISOString() }] });
  const result = await applyRetrievalEnrichers([base], base.memory.authorId, registry,
    { timeoutMs: 100, maxBytes: 1024 });
  expect(base.memory.createdAt.toISOString()).toBe(created);
  expect(result[0].memory.createdAt.toISOString()).toBe(created);
  expect(result[0].enrichments?.beta).toEqual({ observed: created });
});
