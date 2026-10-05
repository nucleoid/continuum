import type { CaptureInput } from '../../types.js';
import type { CapturePlugin, CaptureContext } from '../plugin.js';

export type DeployStatus = 'success' | 'failure' | 'rollback';

export interface DeployEventPayload {
  project: string;
  environment: string;
  version: string;
  status: DeployStatus;
  commit?: string;
  pr?: number;
  url?: string;
  actor?: string;
  actorAuthority?: string;
  actorExternalId?: string;
  threadKey?: string;
  closesThreadKeys?: string[];
  startedAt?: string;
  finishedAt?: string;
  notes?: string;
}

const STATUS_VERB: Record<DeployStatus, string> = {
  success: 'deployed',
  failure: 'failed to deploy',
  rollback: 'rolled back',
};

function deployActorIdentity(event: DeployEventPayload) {
  return event.actorExternalId
    ? { authority: 'deploy-event', externalId: event.actorExternalId }
    : null;
}

export const deployEventPlugin: CapturePlugin<DeployEventPayload> = {
  id: 'deploy-event',
  trustedActivityMetadata: true,
  activityIdentityAuthority: 'deploy-event',

  actorIdentity: deployActorIdentity,

  transform(event, ctx: CaptureContext = {}): CaptureInput[] {
    const verb = STATUS_VERB[event.status];
    const identity = deployActorIdentity(event);
    const actorPrincipalId = identity
      ? ctx.resolveActorPrincipalId?.(identity) ?? null
      : null;

    const lines = [`${event.version} ${verb} on ${event.environment}.`];
    if (event.commit) lines.push(`Commit: ${event.commit}`);
    if (event.pr !== undefined) lines.push(`PR: #${event.pr}`);
    if (event.actor) lines.push(`Triggered by: ${event.actor}`);
    if (event.startedAt) lines.push(`Started: ${event.startedAt}`);
    if (event.finishedAt) lines.push(`Finished: ${event.finishedAt}`);
    if (event.notes) {
      lines.push('');
      lines.push(event.notes);
    }

    const threadKey = `${ctx.activityNamespace ?? 'deploy-event'}:deploy:${event.project}:${event.environment}:${event.version}`;
    return [
      {
        scope: { kind: 'project', name: event.project },
        type: 'fact',
        title: `${event.version} ${verb} on ${event.environment}`,
        body: lines.join('\n'),
        tags: ['deploy', event.environment, event.status],
        source: 'deploy-event',
        sourceRef: event.url ?? undefined,
        metadata: {
          project: event.project,
          environment: event.environment,
          version: event.version,
          status: event.status,
          commit: event.commit ?? null,
          pr: event.pr ?? null,
          ...(event.actor ? { actor: event.actor } : {}),
          ...(actorPrincipalId ? { actor_principal_id: actorPrincipalId } : {}),
          ...(actorPrincipalId ? { thread_owner_principal_id: actorPrincipalId } : {}),
          thread_key: threadKey,
          closes_thread_keys: [],
          startedAt: event.startedAt ?? null,
          finishedAt: event.finishedAt ?? null,
        },
      },
    ];
  },
};
