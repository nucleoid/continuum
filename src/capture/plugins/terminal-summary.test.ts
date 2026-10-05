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
      'terminal-session:6ccfbaa8-c912-4f3a-91b0-664d77a8c1aa',
    ]);
  });

  it('keeps a terminal thread open only when explicitly requested', () => {
    const out = terminalSummaryPlugin.transform(summary({ keepThreadOpen: true }));
    expect(out[0].metadata?.closes_thread_keys).toEqual([]);
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
    const out = terminalSummaryPlugin.transform(summary({ actor: 'github-cass' }), {
      resolveUserScope: (a) => (a === 'github-cass' ? 'entra-cass' : null),
    });
    expect(out[0].scope).toEqual({ kind: 'user', name: 'entra-cass' });
  });

  it('falls back to actor when resolver returns null', () => {
    const out = terminalSummaryPlugin.transform(summary(), {
      resolveUserScope: () => null,
    });
    expect(out[0].scope).toEqual({ kind: 'user', name: 'cass-exampleorg' });
  });
});
