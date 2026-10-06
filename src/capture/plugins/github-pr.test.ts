import { describe, expect, it } from 'vitest';
import { githubPrPlugin, type GitHubPrEvent } from './github-pr.js';

function mergedEvent(overrides: Partial<GitHubPrEvent['pull_request']> = {}): GitHubPrEvent {
  return {
    action: 'closed',
    pull_request: {
      number: 4421,
      title: 'Add checkout v2 retry policy',
      body: 'Implements the new exponential backoff for payment retries.',
      html_url: 'https://github.com/exampleorg/booking-engine/pull/4421',
      state: 'closed',
      merged: true,
      merged_at: '2026-06-03T01:11:00Z',
      merged_by: { id: 1002, login: 'scott-exampleorg' },
      user: { id: 1001, login: 'cass-exampleorg' },
      base: { ref: 'main' },
      head: { ref: 'feature/checkout-v2' },
      ...overrides,
    },
    repository: { id: 987654321, full_name: 'exampleorg/booking-engine', name: 'booking-engine' },
  };
}

describe('github-pr plugin', () => {
  it('uses the immutable numeric repository id in PR and branch closure keys', () => {
    const event = mergedEvent();
    (event.repository as typeof event.repository & { id: number }).id = 987654321;
    const [memory] = githubPrPlugin.transform(event, {
      activityNamespace: 'github',
      resolveActorPrincipalId: () => '11111111-1111-4111-8111-111111111111',
    });

    expect(memory.metadata?.thread_key).toBe('github:repo:987654321:pr:4421');
    expect(memory.metadata?.closes_thread_keys).toContain(
      'github:repo:987654321:branch:feature/checkout-v2',
    );
  });

  it('emits one context memory at project scope for a merged PR', () => {
    const out = githubPrPlugin.transform(mergedEvent());
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.scope).toEqual({ kind: 'project', name: 'booking-engine' });
    expect(m.type).toBe('context');
    expect(m.title).toBe('PR #4421: Add checkout v2 retry policy');
    expect(m.source).toBe('github-pr');
    expect(m.sourceRef).toBe('https://github.com/exampleorg/booking-engine/pull/4421');
    expect(m.tags).toEqual(['pr', 'merged']);
  });

  it('includes merge metadata in body and metadata block', () => {
    const out = githubPrPlugin.transform(mergedEvent());
    expect(out[0].body).toContain('Merged feature/checkout-v2 into main');
    expect(out[0].body).toContain('Merged by: scott-exampleorg');
    expect(out[0].body).toContain('Author: cass-exampleorg');
    expect(out[0].metadata).toMatchObject({
      repo: 'exampleorg/booking-engine',
      number: 4421,
      actor: 'cass-exampleorg',
      merged_by: 'scott-exampleorg',
      thread_key: 'github:repo:987654321:pr:4421',
      closes_thread_keys: [
        'github:repo:987654321:pr:4421',
        'github:repo:987654321:branch:feature/checkout-v2',
      ],
      baseRef: 'main',
      headRef: 'feature/checkout-v2',
    });
  });

  it('keeps the PR author as actor and merger/reviewers separate', () => {
    const ev = mergedEvent({ requested_reviewers: [{ login: 'reviewer-exampleorg' }] });
    ev.reviews = [{ user: { login: 'actual-reviewer-exampleorg' } }];
    const out = githubPrPlugin.transform(ev, {
      resolveActorPrincipalId: (identity) => (
        identity.authority === 'github' && identity.externalId === '1001'
      )
        ? '11111111-1111-4111-8111-111111111111'
        : null,
    });
    expect(out[0].metadata).toMatchObject({
      actor: 'cass-exampleorg',
      actor_principal_id: '11111111-1111-4111-8111-111111111111',
      thread_owner_principal_id: '11111111-1111-4111-8111-111111111111',
      merged_by: 'scott-exampleorg',
      reviewers: ['actual-reviewer-exampleorg'],
      requested_reviewers: ['reviewer-exampleorg'],
    });
  });

  it('uses the immutable GitHub user id when a login is renamed', () => {
    const renamed = mergedEvent({ user: { id: 1001, login: 'cass-renamed' } });
    const identities: Array<{ authority: string; externalId: string }> = [];
    const out = githubPrPlugin.transform(renamed, {
      resolveActorPrincipalId: (identity) => {
        identities.push(identity);
        return identity.externalId === '1001'
          ? '11111111-1111-4111-8111-111111111111'
          : null;
      },
    });
    expect(githubPrPlugin.actorIdentity?.(renamed)).toEqual({
      authority: 'github', externalId: '1001',
    });
    expect(identities).toEqual([{ authority: 'github', externalId: '1001' }]);
    expect(out[0].metadata).toMatchObject({
      actor: 'cass-renamed',
      actor_principal_id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('skips PRs that closed without merging', () => {
    const ev = mergedEvent({ merged: false, merged_at: null, merged_by: null });
    expect(githubPrPlugin.transform(ev)).toEqual([]);
  });

  it('skips PR events with non-closed actions', () => {
    const ev = mergedEvent();
    ev.action = 'opened';
    expect(githubPrPlugin.transform(ev)).toEqual([]);
  });

  it('handles PRs with empty body', () => {
    const out = githubPrPlugin.transform(mergedEvent({ body: '' }));
    expect(out[0].body).not.toContain('Implements the new');
    expect(out[0].body).toContain('Merged feature/checkout-v2 into main');
  });

  it('uses defaultProjectName from context when supplied', () => {
    const out = githubPrPlugin.transform(mergedEvent(), { defaultProjectName: 'override-name' });
    expect(out[0].scope).toEqual({ kind: 'project', name: 'override-name' });
  });
});
