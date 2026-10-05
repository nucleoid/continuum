import { describe, expect, it } from 'vitest';
import { terminalSummaryPlugin, type TerminalSummaryPayload } from './terminal-summary.js';

function summary(overrides: Partial<TerminalSummaryPayload> = {}): TerminalSummaryPayload {
  return {
    actor: 'cass-exampleorg',
    sessionId: '6ccfbaa8-c912-4f3a-91b0-664d77a8c1aa',
    summary: 'Investigated COApi Node 22 pin. Reproduced locally, opened PR #4421.',
    workingDir: '/home/cass/projects/coapi',
    startedAt: '2026-06-03T00:00:00Z',
    finishedAt: '2026-06-03T01:10:00Z',
    transcriptHash: 'sha256:deadbeef',
    ...overrides,
  };
}

describe('terminal-summary plugin', () => {
  it('emits a user-scoped context memory when no decisions are present', () => {
    const out = terminalSummaryPlugin.transform(summary());
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.scope).toEqual({ kind: 'user', name: 'cass-exampleorg' });
    expect(m.type).toBe('context');
    expect(m.title).toBe('Session 6ccfbaa8 summary');
    expect(m.body).toContain('Investigated COApi Node 22 pin.');
    expect(m.sourceRef).toBe('session://6ccfbaa8-c912-4f3a-91b0-664d77a8c1aa');
    expect(m.tags).toEqual(['session', 'terminal']);
    expect(m.metadata?.closes_thread_keys).toEqual([
      'terminal-summary:terminal-session:6ccfbaa8-c912-4f3a-91b0-664d77a8c1aa',
    ]);
  });

  it('keeps a terminal thread open only when explicitly requested', () => {
    const out = terminalSummaryPlugin.transform(summary({ keepThreadOpen: true }));
    expect(out[0].metadata?.closes_thread_keys).toEqual([]);
  });

  it('hash-bounds oversized terminal thread keys deterministically', () => {
    const sessionId = 'session/'.repeat(100);
    const first = terminalSummaryPlugin.transform(summary({ sessionId }))[0];
    const second = terminalSummaryPlugin.transform(summary({ sessionId }))[0];
    expect(first.metadata?.thread_key).toBe(second.metadata?.thread_key);
    expect(String(first.metadata?.thread_key)).toMatch(
      /^terminal-summary:terminal-session:sha256:[0-9a-f]{64}$/,
    );
    expect(String(first.metadata?.thread_key).length).toBeLessThanOrEqual(500);
    expect(first.metadata?.closes_thread_keys).toEqual([first.metadata?.thread_key]);
  });

  it('emits one extra decision memory per decision bullet', () => {
    const out = terminalSummaryPlugin.transform(
      summary({
        decisions: [
          'Pin Node to 22.x in CI; 23 breaks the pg native bindings.',
          'Move retry policy out of COApi into the booking-engine middleware.',
        ],
      }),
    );
    expect(out).toHaveLength(3);
    expect(out[1].type).toBe('decision');
    expect(out[1].title).toBe('Pin Node to 22.x in CI; 23 breaks the pg native bindings.');
    expect(out[1].metadata).toMatchObject({ decisionIndex: 0 });
    expect(out[2].type).toBe('decision');
    expect(out[2].metadata).toMatchObject({ decisionIndex: 1 });
  });

  it('truncates long decision titles to 80 chars', () => {
    const long = 'a'.repeat(200);
    const out = terminalSummaryPlugin.transform(summary({ decisions: [long] }));
    expect(out[1].title.length).toBeLessThanOrEqual(80);
    expect(out[1].title.endsWith('...')).toBe(true);
    expect(out[1].body).toBe(long);
  });

  it('routes to the scope override when provided', () => {
    const out = terminalSummaryPlugin.transform(
      summary({
        scopeOverride: { kind: 'team', name: 'payments' },
        decisions: ['Adopt RRF in recall.'],
      }),
    );
    expect(out[0].scope).toEqual({ kind: 'team', name: 'payments' });
    expect(out[1].scope).toEqual({ kind: 'team', name: 'payments' });
  });

  it('resolves user scope via context when no override is given', () => {
    const out = terminalSummaryPlugin.transform(summary({
      actor: 'github-cass', actorAuthority: 'github', actorExternalId: '1001',
    }), {
      resolveUserScope: (identity) => identity.externalId === '1001' ? 'entra-cass' : null,
    });
    expect(out[0].scope).toEqual({ kind: 'user', name: 'entra-cass' });
  });

  it('falls back to actor when resolver returns null', () => {
    const out = terminalSummaryPlugin.transform(summary(), {
      resolveUserScope: () => null,
    });
    expect(out[0].scope).toEqual({ kind: 'user', name: 'cass-exampleorg' });
  });

  it('ignores a supplied principal UUID and resolves only an external identity', () => {
    const event = {
      ...summary(),
      actorPrincipalId: '22222222-2222-4222-8222-222222222222',
      actorAuthority: 'terminal', actorExternalId: 'immutable-terminal-user-7',
    } as TerminalSummaryPayload & { actorPrincipalId: string };
    const out = terminalSummaryPlugin.transform({
      ...event,
      threadKey: 'github-pr:other/repo#1',
      closesThreadKeys: ['github-pr:other/repo#2'],
    }, {
      activityNamespace: 'terminal-summary.authenticated-service',
      resolveActorPrincipalId: (identity) => identity.externalId === 'immutable-terminal-user-7'
        ? '11111111-1111-4111-8111-111111111111'
        : null,
    });
    expect(terminalSummaryPlugin.actorIdentity?.(event)).toEqual({
      authority: 'terminal-summary', externalId: 'immutable-terminal-user-7',
    });
    expect(out[0].metadata).toMatchObject({
      actor_principal_id: '11111111-1111-4111-8111-111111111111',
      thread_owner_principal_id: '11111111-1111-4111-8111-111111111111',
      thread_key: 'terminal-summary.authenticated-service:terminal-session:6ccfbaa8-c912-4f3a-91b0-664d77a8c1aa',
      closes_thread_keys: [
        'terminal-summary.authenticated-service:terminal-session:6ccfbaa8-c912-4f3a-91b0-664d77a8c1aa',
      ],
    });
  });
});
