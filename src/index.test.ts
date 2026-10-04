import { describe, expect, it } from 'vitest';
import { PromoteError, promoteMemory, verifyMemory } from './index.js';

describe('@continuum/core lifecycle compatibility exports', () => {
  it('retains the established public symbols', () => {
    expect(promoteMemory).toBeTypeOf('function');
    expect(verifyMemory).toBeTypeOf('function');
    expect(new PromoteError('example', 409)).toMatchObject({
      message: 'example',
      status: 409,
    });
  });
});
