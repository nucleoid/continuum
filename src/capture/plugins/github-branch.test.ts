import { describe, expect, it } from 'vitest';
import { githubBranchPlugin, type GitHubBranchEvent } from './github-branch.js';

function event(overrides: Partial<GitHubBranchEvent> = {}): GitHubBranchEvent {
  return {
    ref: 'feature/checkout-v2',
    ref_type: 'branch',
    master_branch: 'main',
    repository: {
      full_name: 'exampleorg/booking-engine',
      name: 'booking-engine',
      html_url: 'https://github.com/exampleorg/booking-engine',
    },
    sender: { id: 1001, login: 'cass-exampleorg' },
    ...overrides,
  };
}

describe('github-branch plugin', () => {
  it('emits a user-scoped context memory for a new branch', () => {
    const out = githubBranchPlugin.transform(event());
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.scope).toEqual({ kind: 'user', name: 'cass-exampleorg' });
    expect(m.type).toBe('context');
    expect(m.title).toBe('Started branch feature/checkout-v2 (booking-engine)');
    expect(m.source).toBe('github-branch');
    expect(m.sourceRef).toBe(
      'https://github.com/exampleorg/booking-engine/tree/feature/checkout-v2',
    );
    expect(m.tags).toEqual(['branch', 'github']);
  });

  it('records repo, ref, base, and actor in metadata', () => {
    const out = githubBranchPlugin.transform(event());
    expect(out[0].metadata).toEqual({
      repo: 'exampleorg/booking-engine',
      ref: 'feature/checkout-v2',
      base: 'main',
      actor: 'cass-exampleorg',
      thread_key: 'github-branch:exampleorg/booking-engine:feature/checkout-v2',
      closes_thread_keys: [],
    });
  });

  it('skips tag creation events', () => {
    const ev = event({ ref: 'v1.0.0', ref_type: 'tag' });
    expect(githubBranchPlugin.transform(ev)).toEqual([]);
  });

  it('resolves user scope via context when supplied', () => {
    const ev = event({ sender: { id: 1001, login: 'github-cass' } });
    const out = githubBranchPlugin.transform(ev, {
      resolveUserScope: (identity) => (
        identity.authority === 'github' && identity.externalId === '1001'
          ? 'entra-cass'
          : null
      ),
      resolveActorPrincipalId: () => '11111111-1111-4111-8111-111111111111',
    });
    expect(out[0].scope).toEqual({ kind: 'user', name: 'entra-cass' });
    expect(out[0].metadata).toMatchObject({
      actor: 'github-cass',
      actor_principal_id: '11111111-1111-4111-8111-111111111111',
      thread_owner_principal_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(githubBranchPlugin.actorIdentity?.(ev)).toEqual({
      authority: 'github', externalId: '1001',
    });
  });

  it('falls back to actor login when resolveUserScope returns null', () => {
    const out = githubBranchPlugin.transform(event(), {
      resolveUserScope: () => null,
    });
    expect(out[0].scope).toEqual({ kind: 'user', name: 'cass-exampleorg' });
  });
});
