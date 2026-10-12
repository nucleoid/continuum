import type { Queryable } from '../storage/queryable.js';
import type { IngestPluginId } from '../ingest/config.js';
import { ServiceError } from '../services/errors.js';

export interface ProducerContext { principal_id: string; authority: string; source_family: string }
export async function producerContext(db: Queryable): Promise<ProducerContext | null> {
  return (await db.query<{ producer: ProducerContext | null }>('SELECT continuum_standup_producer_context() AS producer')).rows[0]?.producer ?? null;
}

/** Only the authenticated, validated webhook payload supplies source artifacts. */
export function activityProof(plugin: IngestPluginId, event: unknown, deliveryId: string,
  configuredActor?: string): Record<string, unknown> | null {
  const input = event as Record<string, any>;
  if (plugin === 'github-pr' || plugin === 'github-branch') {
    const repository = input.repository?.id;
    const actor = plugin === 'github-pr' ? input.pull_request?.user?.id : input.sender?.id;
    if (!Number.isSafeInteger(repository) || repository <= 0 || !Number.isSafeInteger(actor) || actor <= 0) return null;
    return plugin === 'github-pr' ? { external_actor_id: String(actor), repository_id: String(repository),
      pull_request_number: String(input.pull_request.number), branch: input.pull_request.head.ref,
      ...(Number.isSafeInteger(input.pull_request.head.repo?.id) && input.pull_request.head.repo.id > 0
        ? { head_repository_id: String(input.pull_request.head.repo.id) } : {}),
      merged: input.pull_request.merged, ...(input.pull_request.merged_at ? { event_time: input.pull_request.merged_at } : {}) }
      : { external_actor_id: String(actor), repository_id: String(repository), branch: input.ref };
  }
  if (!configuredActor || (plugin !== 'deploy-event' && plugin !== 'terminal-summary')) return null;
  return { external_actor_id: configuredActor,
    artifact_id: plugin === 'terminal-summary' ? input.sessionId : deliveryId,
    finished: Boolean(input.finishedAt), ...(input.finishedAt || input.startedAt
      ? { event_time: input.finishedAt ?? input.startedAt } : {}) };
}

export async function recordActivity(db: Queryable, memoryId: string, proof: Record<string, unknown>): Promise<boolean> {
  return (await db.query<{ recorded: boolean }>('SELECT continuum_record_standup_activity($1::uuid,$2::jsonb) AS recorded',
    [memoryId, proof])).rows[0]?.recorded === true;
}

export function requireProducerMatch(context: ProducerContext | null, principalId: string, plugin: IngestPluginId): void {
  const family = plugin === 'github-pr' || plugin === 'github-branch' ? 'github' : plugin;
  if (!context || context.principal_id !== principalId || context.source_family !== family) {
    throw new ServiceError('DEPENDENCY_UNAVAILABLE', 'The configured standup producer identity is unavailable');
  }
}
