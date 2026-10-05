import type pg from 'pg';
import { defaultCaptureRegistry, type CaptureRegistry } from '../capture/index.js';
import { UnknownPluginError } from '../capture/plugin.js';
import type { CaptureContext, ExternalActorIdentity } from '../capture/plugin.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { resolveActorPrincipalId } from '../storage/actor-identities.js';
import type { Principal } from '../types.js';
import { captureMemory, type CaptureOptions, type CaptureResult } from './capture.js';

export interface PluginCaptureOptions extends CaptureOptions {
  registry?: CaptureRegistry;
  defaultProjectName?: string;
  resolveUserScope?: CaptureContext['resolveUserScope'];
  auditMetadata?: Record<string, unknown>;
}

function sameIdentity(
  left: ExternalActorIdentity,
  right: ExternalActorIdentity,
): boolean {
  return left.authority === right.authority && left.externalId === right.externalId;
}

export async function capturePluginEvent(
  pool: pg.Pool,
  embeddingProvider: EmbeddingProvider | null,
  ingestionPrincipal: Principal,
  pluginId: string,
  event: unknown,
  options: PluginCaptureOptions = {},
): Promise<CaptureResult[]> {
  const registry = options.registry ?? defaultCaptureRegistry();
  const plugin = registry.get(pluginId);
  if (!plugin) throw new UnknownPluginError(pluginId);

  const identity = plugin.actorIdentity?.(event) ?? null;
  const actorPrincipalId = identity
    ? await resolveActorPrincipalId(pool, identity)
    : null;
  const inputs = plugin.transform(event, {
    defaultProjectName: options.defaultProjectName,
    resolveUserScope: options.resolveUserScope,
    resolveActorPrincipalId: (candidate) => (
      identity && actorPrincipalId && sameIdentity(identity, candidate)
        ? actorPrincipalId
        : null
    ),
  });

  const results: CaptureResult[] = [];
  for (const input of inputs) {
    results.push(await captureMemory(
      pool,
      embeddingProvider,
      ingestionPrincipal,
      input,
      { plugin: pluginId, ...options.auditMetadata },
      { relationThreshold: options.relationThreshold },
    ));
  }
  return results;
}
