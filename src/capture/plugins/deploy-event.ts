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
  startedAt?: string;
  finishedAt?: string;
  notes?: string;
}

const STATUS_VERB: Record<DeployStatus, string> = {
  success: 'deployed',
  failure: 'failed to deploy',
  rollback: 'rolled back',
};

export const deployEventPlugin: CapturePlugin<DeployEventPayload> = {
  id: 'deploy-event',

  transform(event, _ctx: CaptureContext = {}): CaptureInput[] {
    const verb = STATUS_VERB[event.status];

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
          actor: event.actor ?? null,
          startedAt: event.startedAt ?? null,
          finishedAt: event.finishedAt ?? null,
        },
      },
    ];
  },
};
