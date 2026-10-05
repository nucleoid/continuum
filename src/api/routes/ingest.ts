import { Router } from 'express';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { EmbeddingRouting } from '../../embeddings/router.js';
import { defaultCaptureRegistry } from '../../capture/index.js';
import type { CaptureContext, CaptureRegistry } from '../../capture/plugin.js';
import type { CaptureInput } from '../../types.js';
import { authenticateIngest } from '../../ingest/auth.js';
import type { IngestConfig, IngestPluginId } from '../../ingest/config.js';
import { ServiceError } from '../../services/errors.js';
import { captureOne, embedCapturedMemory } from '../../services/capture.js';
import { DEFAULT_RELATION_THRESHOLD } from '../../services/relations.js';
import {
  processIngestDelivery,
  resolvePrincipalAlias,
} from '../../storage/ingest-deliveries.js';

const text = (max: number) => z.string().min(1).max(max);
const optionalText = (max: number) => z.string().max(max).optional();
const timestamp = z.string().max(100).datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const optionalTimestamp = timestamp.optional();
const actor = z.object({
  id: z.number().int().nonnegative().safe(),
  login: text(200),
});

const githubPrSchema = z.object({
  action: text(100),
  pull_request: z.object({
    number: z.number().int().nonnegative(),
    title: text(500),
    body: z.string().max(500_000).nullable().optional(),
    html_url: text(2_000),
    state: text(100),
    merged: z.boolean(),
    merged_at: timestamp.nullable().optional(),
    merged_by: actor.nullable().optional(),
    user: actor,
    base: z.object({ ref: text(500) }),
    head: z.object({ ref: text(500) }),
  }),
  repository: z.object({ full_name: text(500), name: text(300) }),
});

const githubBranchSchema = z.object({
  ref: text(500),
  ref_type: z.enum(['branch', 'tag']),
  master_branch: optionalText(500),
  repository: z.object({ full_name: text(500), name: text(300), html_url: text(2_000) }),
  sender: actor,
});

const adoResourceSchema = z.object({
  id: z.number().int().nonnegative(),
  fields: z.object({
    'System.Title': text(500),
    'System.Description': optionalText(500_000),
    'System.State': text(100),
    'System.WorkItemType': text(100),
    'System.AreaPath': optionalText(500),
    'System.Tags': optionalText(10_000),
    'System.AssignedTo': z.union([
      z.string().max(500),
      z.object({ uniqueName: optionalText(500), displayName: optionalText(500) }),
    ]).optional(),
  }),
  _links: z.object({ html: z.object({ href: optionalText(2_000) }).optional() }).optional(),
  comments: z.array(z.object({
    text: z.string().max(100_000),
    createdBy: z.object({ displayName: optionalText(500) }).optional(),
    createdDate: optionalTimestamp,
  })).max(100).optional(),
});

const adoEnvelopeSchema = z.object({
  id: z.union([text(200), z.number().int().nonnegative()]),
  eventType: text(200),
  resource: z.union([adoResourceSchema, z.object({ revision: adoResourceSchema })]),
});

const deploySchema = z.object({
  project: text(300), environment: text(200), version: text(300),
  status: z.enum(['success', 'failure', 'rollback']),
  commit: optionalText(500), pr: z.number().int().nonnegative().optional(),
  url: optionalText(2_000), actor: optionalText(500),
  startedAt: optionalTimestamp, finishedAt: optionalTimestamp, notes: optionalText(500_000),
});

const scopeSchema = z.object({
  kind: z.enum(['org', 'team', 'project', 'user', 'role']),
  name: z.string().max(300),
});
const terminalSchema = z.object({
  actor: text(500), sessionId: text(500), summary: text(500_000),
  decisions: z.array(text(100_000)).max(50).optional(),
  workingDir: optionalText(2_000), startedAt: optionalTimestamp, finishedAt: optionalTimestamp,
  transcriptHash: optionalText(500), scopeOverride: scopeSchema.optional(),
});

const schemas: Record<IngestPluginId, z.ZodTypeAny> = {
  'github-pr': githubPrSchema,
  'github-branch': githubBranchSchema,
  'ado-workitem': adoEnvelopeSchema,
  'deploy-event': deploySchema,
  'terminal-summary': terminalSchema,
};

const deliveryPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function payloadHash(rawBody: Buffer | undefined): string {
  if (!rawBody) throw new ServiceError('INVALID_INPUT', 'A request payload is required');
  return createHash('sha256').update(rawBody).digest('hex');
}

function deliveryId(
  pluginId: IngestPluginId,
  body: unknown,
  header: (name: string) => string | undefined,
  hash: string,
): string {
  let value: unknown;
  if (pluginId === 'github-pr' || pluginId === 'github-branch') value = header('x-github-delivery');
  else if (pluginId === 'ado-workitem') value = (body as { id?: unknown }).id;
  else value = header('idempotency-key');
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !deliveryPattern.test(normalized)) {
    throw new ServiceError('INVALID_INPUT', 'A valid delivery identifier is required');
  }
  // GitHub signs the body, not X-GitHub-Delivery. Keying GitHub deliveries by
  // the signed bytes keeps identity stable if that unsigned header is changed.
  return pluginId === 'github-pr' || pluginId === 'github-branch'
    ? `sha256:${hash}`
    : normalized;
}

async function captureContext(
  pool: pg.Pool,
  pluginId: IngestPluginId,
  event: unknown,
): Promise<CaptureContext> {
  let provider: string | undefined;
  let externalActor: string | undefined;
  if (pluginId === 'github-branch') {
    if ((event as z.infer<typeof githubBranchSchema>).ref_type !== 'branch') return {};
    provider = 'github';
    externalActor = String((event as z.infer<typeof githubBranchSchema>).sender.id);
  } else if (pluginId === 'terminal-summary') {
    provider = 'terminal';
    externalActor = (event as z.infer<typeof terminalSchema>).actor;
  }
  if (!provider || !externalActor) return {};
  const resolved = await resolvePrincipalAlias(pool, provider, externalActor);
  if (!resolved || resolved.kind !== 'user') {
    throw new ServiceError('INVALID_INPUT', 'External actor alias is not configured');
  }
  return { resolveUserScope: () => resolved.externalId };
}

export function ingestRouter(
  pool: pg.Pool,
  embeddingRouting: EmbeddingRouting,
  config: IngestConfig,
  registry: CaptureRegistry = defaultCaptureRegistry(),
  relationThreshold = DEFAULT_RELATION_THRESHOLD,
): Router {
  const router = Router();
  router.post('/ingest/:pluginId', async (req, res) => {
    const pluginId = req.params.pluginId as IngestPluginId;
    const pluginConfig = config.plugins[pluginId];
    if (!Object.hasOwn(schemas, pluginId) || !pluginConfig?.enabled) {
      throw new ServiceError('NOT_FOUND', 'Ingestion plugin not found');
    }

    const principal = await authenticateIngest(pool, req, pluginConfig);
    req.principal = principal;
    const parsed = schemas[pluginId].safeParse(req.body);
    if (!parsed.success) throw new ServiceError('INVALID_INPUT', 'Invalid webhook payload');
    const hash = payloadHash(req.rawBody);
    const id = deliveryId(pluginId, parsed.data, (name) => req.header(name), hash);
    if (pluginId === 'ado-workitem'
      && (parsed.data as z.infer<typeof adoEnvelopeSchema>).eventType !== 'workitem.updated') {
      throw new ServiceError('INVALID_INPUT', 'Unexpected ADO event');
    }
    const adoResource = pluginId === 'ado-workitem'
      ? (parsed.data as z.infer<typeof adoEnvelopeSchema>).resource
      : undefined;
    const event = adoResource
      ? ('revision' in adoResource ? adoResource.revision : adoResource)
      : parsed.data;
    const context = await captureContext(pool, pluginId, event);
    let inputs: CaptureInput[];
    try {
      inputs = registry.run(pluginId, event, context).map((input) => ({ ...input, source: pluginId }));
    } catch {
      throw new ServiceError('INVALID_INPUT', 'Invalid webhook payload');
    }
    const result = await processIngestDelivery(pool, pluginId, id, hash, async (client) => {
      const captures = [];
      for (let index = 0; index < inputs.length; index += 1) {
        captures.push(await captureOne(
          client, embeddingRouting, principal, inputs[index],
          { transport: 'ingest' },
        ));
      }
      return captures;
    });
    if (!result.replayed) {
      await Promise.allSettled(
        result.captures.map((capture) => embedCapturedMemory(
          pool,
          embeddingRouting,
          capture,
          { relationThreshold },
        )),
      );
    }

    if (result.replayed) {
      res.status(200).json({ replayed: true, memoryIds: result.memoryIds });
    } else if (result.memoryIds.length === 0) {
      res.status(204).send();
    } else {
      res.status(202).json({ replayed: false, memoryIds: result.memoryIds });
    }
  });
  return router;
}
