import { describe, expect, it } from 'vitest';
import { validateCaptureMetadata } from './metadata.js';

describe('capture activity metadata', () => {
  it('accepts the explicit actor and thread contract', () => {
    expect(() => validateCaptureMetadata({
      actor_principal_id: '11111111-1111-4111-8111-111111111111',
      actor: 'pr-author',
      thread_key: 'github-pr:org/repo#14',
      closes_thread_keys: ['github-branch:org/repo:feature/standup'],
      merged_by: 'merger',
      reviewers: ['reviewer'],
    })).not.toThrow();
  });

  it.each([
    { actor_principal_id: 'display-name' },
    { actor_principal_id: '11111111-1111-4111-8111-111111111111' },
    { actor: '' },
    { thread_key: 'thread-without-actor' },
    { thread_key: '' },
    { closes_thread_keys: ['same', 'same'] },
    { closes_thread_keys: 'thread' },
    { reviewers: [1] },
  ])('rejects malformed reserved metadata %#', (metadata) => {
    expect(() => validateCaptureMetadata(metadata)).toThrow();
  });
});
