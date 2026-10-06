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
      thread_owner_principal_id: '11111111-1111-4111-8111-111111111111',
    })).not.toThrow();
  });

  it('does not require an untrusted display label for mapped attribution', () => {
    expect(() => validateCaptureMetadata({
      actor_principal_id: '11111111-1111-4111-8111-111111111111',
      thread_owner_principal_id: '11111111-1111-4111-8111-111111111111',
      thread_key: 'deploy:continuum:prod:v1',
      closes_thread_keys: [],
    })).not.toThrow();
  });

  it('accepts well-formed non-standup plugin metadata when actor resolution is unavailable', () => {
    expect(() => validateCaptureMetadata({
      actor: 'unmapped-github-user',
      thread_key: 'github-pr:org/repo#14',
      closes_thread_keys: ['github-branch:org/repo:feature/standup'],
    })).not.toThrow();
    expect(() => validateCaptureMetadata({
      thread_key: 'deploy:continuum:prod:v1',
      closes_thread_keys: [],
    })).not.toThrow();
  });

  it.each([
    { _continuum_activity_provenance: 'capture-v1' },
    { actor_principal_id: 'display-name' },
    { actor_principal_id: '11111111-1111-4111-8111-111111111111' },
    {
      actor_principal_id: '11111111-1111-4111-8111-111111111111',
      thread_owner_principal_id: '22222222-2222-4222-8222-222222222222',
      thread_key: 'mismatched-owner',
    },
    { _continuum_actor_mapping_id: '11111111-1111-4111-8111-111111111111' },
    { thread_owner_principal_id: '11111111-1111-4111-8111-111111111111' },
    { actor: '' },
    { thread_key: '' },
    { closes_thread_keys: ['same', 'same'] },
    { closes_thread_keys: 'thread' },
    { reviewers: [1] },
  ])('rejects malformed reserved metadata %#', (metadata) => {
    expect(() => validateCaptureMetadata(metadata)).toThrow();
  });
});
