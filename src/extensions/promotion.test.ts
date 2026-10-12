import { describe, expect, it, vi } from 'vitest';
import { PromotionWebhookRegistry } from './promotion.js';

describe('PromotionWebhookRegistry', () => {
  it('uses the same deterministic unique ID contract', () => {
    const registry = new PromotionWebhookRegistry();
    const bravo = { id: 'bravo', onPromoted: vi.fn() };
    const alpha = { id: 'alpha', onPromoted: vi.fn() };
    registry.register(bravo);
    registry.register(alpha);
    expect(registry.ids()).toEqual(['alpha', 'bravo']);
    expect(registry.all()).toEqual([alpha, bravo]);
    expect(() => registry.register(alpha)).toThrow(/duplicate/i);
  });
});
