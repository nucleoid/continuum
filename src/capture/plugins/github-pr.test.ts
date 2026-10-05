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
    repository: { full_name: 'exampleorg/booking-engine', name: 'booking-engine' },
  };
}

describe('github-pr plugin', () => {
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
      author: '1001',
      authorLogin: 'cass-exampleorg',
      mergedBy: '1002',
      mergedByLogin: 'scott-exampleorg',
      actor: '1001',
      merged_by: 'scott-exampleorg',
      thread_key: 'github-pr:exampleorg/booking-engine#4421',
      closes_thread_keys: [
        'github-pr:exampleorg/booking-engine#4421',
        'github-branch:exampleorg/booking-engine:feature/checkout-v2',
      ],
      baseRef: 'main',
      headRef: 'feature/checkout-v2',
    });
  });

  it('keeps the PR author as actor and merger/reviewers separate', () => {
    const ev = mergedEvent({ requested_reviewers: [{ login: 'reviewer-exampleorg' }] });
    ev.reviews = [{ user: { login: 'actual-reviewer-exampleorg' } }];
    const out = githubPrPlugin.transform(ev, {
      resolveActorPrincipalId: (actor) => actor === '1001'
        ? '11111111-1111-4111-8111-111111111111'
        : null,
    });
    expect(out[0].metadata).toMatchObject({
      actor: '1001',
      actor_principal_id: '11111111-1111-4111-8111-111111111111',
      merged_by: 'scott-exampleorg',
      reviewers: ['actual-reviewer-exampleorg'],
      requested_reviewers: ['reviewer-exampleorg'],
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
