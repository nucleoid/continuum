import type pg from 'pg';
import { defaultCaptureRegistry, type CaptureRegistry } from '../capture/index.js';
import { UnknownPluginError } from '../capture/plugin.js';
import type { CaptureContext, ExternalActorIdentity } from '../capture/plugin.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { resolveActorIdentityMapping } from '../storage/actor-identities.js';
import type { Principal } from '../types.js';
import { stripTrustedActivityMetadata } from '../capture/metadata.js';
import {
  captureMappedPluginMemory,
  captureMemory,
  type CaptureOptions,
  type CaptureResult,
} from './capture.js';

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

export function authenticatedActorAuthority(pluginId: string, principalId: string): string {
  return `${pluginId}.${principalId}`;
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

  const claimedIdentity = plugin.actorIdentity?.(event) ?? null;
  const activityNamespace = plugin.trustedActivityMetadata
    ? authenticatedActorAuthority(
        plugin.activityIdentityAuthority ?? pluginId,
        ingestionPrincipal.id,
      )
    : undefined;
  const identity = claimedIdentity && activityNamespace
    ? { authority: activityNamespace, externalId: claimedIdentity.externalId }
    : claimedIdentity;
  const actorMapping = identity
    ? await resolveActorIdentityMapping(pool, identity)
    : null;
  const actorPrincipalId = actorMapping?.principalId ?? null;
  const inputs = plugin.transform(event, {
    defaultProjectName: options.defaultProjectName,
    activityNamespace,
    resolveUserScope: (candidate) => (
      identity && claimedIdentity && sameIdentity(claimedIdentity, candidate)
        ? options.resolveUserScope?.(identity) ?? null
        : null
    ),
    resolveActorPrincipalId: (candidate) => (
      identity && claimedIdentity && actorPrincipalId && sameIdentity(claimedIdentity, candidate)
        ? actorPrincipalId
        : null
    ),
  });

  const results: CaptureResult[] = [];
  for (const transformedInput of inputs) {
    const sourceActorLabel = transformedInput.metadata?.actor;
    const metadata = plugin.trustedActivityMetadata && actorPrincipalId
      ? { ...transformedInput.metadata }
      : stripTrustedActivityMetadata(transformedInput.metadata ?? {});
    if (!actorPrincipalId && typeof sourceActorLabel === 'string' && sourceActorLabel.length > 0) {
      metadata.source_actor_label = sourceActorLabel;
    }
    if (plugin.trustedActivityMetadata && actorPrincipalId) {
      delete metadata.actor_principal_id;
      delete metadata.thread_owner_principal_id;
      metadata.actor_principal_id = actorPrincipalId;
      metadata.thread_owner_principal_id = actorPrincipalId;
    }
    const input = { ...transformedInput, metadata };
    const auditMetadata = { plugin: pluginId, ...options.auditMetadata };
    const captureOptions = { relationThreshold: options.relationThreshold };
    results.push(plugin.trustedActivityMetadata && identity && actorPrincipalId
      ? await captureMappedPluginMemory(
          pool,
          embeddingProvider,
          ingestionPrincipal,
          input,
          {
            identity,
            mappingId: actorMapping!.mappingId,
            authority: actorMapping!.authority,
            principalId: actorPrincipalId,
          },
          auditMetadata,
          captureOptions,
        )
      : await captureMemory(
          pool,
          embeddingProvider,
          ingestionPrincipal,
          input,
          auditMetadata,
          captureOptions,
        ));
  }
  return results;
}
