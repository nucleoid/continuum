import type { CaptureInput, ScopeRef } from '../../types.js';
import type { CapturePlugin, CaptureContext } from '../plugin.js';

export interface TerminalSummaryPayload {
  actor: string;
  sessionId: string;
  summary: string;
  decisions?: string[];
  workingDir?: string;
  startedAt?: string;
  finishedAt?: string;
  transcriptHash?: string;
  scopeOverride?: ScopeRef;
  actorPrincipalId?: string;
  actorAuthority?: string;
  actorExternalId?: string;
  threadKey?: string;
  closesThreadKeys?: string[];
  keepThreadOpen?: boolean;
}

export const terminalSummaryPlugin: CapturePlugin<TerminalSummaryPayload> = {
  id: 'terminal-summary',

  transform(event, ctx: CaptureContext = {}): CaptureInput[] {
    const baseScope: ScopeRef =
      event.scopeOverride ?? {
        kind: 'user',
        name: ctx.resolveUserScope?.(event.actor) ?? event.actor,
      };

    const explicitIdentity = event.actorAuthority && event.actorExternalId
      ? { authority: event.actorAuthority, externalId: event.actorExternalId }
      : null;
    const actorPrincipalId = event.actorPrincipalId
      ?? (explicitIdentity ? ctx.resolveActorPrincipalId?.(explicitIdentity) : null)
      ?? null;
    const threadKey = event.threadKey ?? `terminal-session:${event.sessionId}`;
    const metadata = {
      actor: event.actor,
      ...(actorPrincipalId ? { actor_principal_id: actorPrincipalId } : {}),
      ...(actorPrincipalId ? { thread_owner_principal_id: actorPrincipalId } : {}),
      thread_key: threadKey,
      closes_thread_keys: event.closesThreadKeys
        ?? (event.keepThreadOpen ? [] : [threadKey]),
      sessionId: event.sessionId,
      workingDir: event.workingDir ?? null,
      startedAt: event.startedAt ?? null,
      finishedAt: event.finishedAt ?? null,
      transcriptHash: event.transcriptHash ?? null,
    };

    const sourceRef = `session://${event.sessionId}`;

    const lines = [event.summary.trim()];
    if (event.workingDir) lines.push('', `Working dir: ${event.workingDir}`);
    if (event.transcriptHash) lines.push(`Transcript: ${event.transcriptHash}`);

    const out: CaptureInput[] = [
      {
        scope: baseScope,
        type: 'context',
        title: `Session ${event.sessionId.slice(0, 8)} summary`,
        body: lines.join('\n').trim(),
        tags: ['session', 'terminal'],
        source: 'terminal-summary',
        sourceRef,
        metadata,
      },
    ];

    for (const [i, decision] of (event.decisions ?? []).entries()) {
      out.push({
        scope: baseScope,
        type: 'decision',
        title: deriveDecisionTitle(decision),
        body: decision.trim(),
        tags: ['session', 'decision'],
        source: 'terminal-summary',
        sourceRef,
        metadata: { ...metadata, decisionIndex: i },
      });
    }

    return out;
  },
};

function deriveDecisionTitle(decision: string): string {
  const firstLine = decision.split('\n')[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77).trimEnd() + '...';
}
