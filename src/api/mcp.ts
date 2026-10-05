import type pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getPrincipalByExternalId } from '../storage/principals.js';
import { asEmbeddingRouter, type EmbeddingRouting } from '../embeddings/router.js';
import type { Principal, ScopeKind } from '../types.js';
import { getPool } from '../storage/pool.js';
import { makeEmbeddingRouterFromEnv } from '../embeddings/factory.js';
import { isDirectEntrypoint } from './entrypoint.js';
import { accessibleScopes } from '../services/access.js';
import { captureMemory } from '../services/capture.js';
import { recallForPrincipal } from '../services/recall.js';
import {
  asServiceError,
  logInternalServiceError,
  ServiceError,
  serviceErrorBody,
  type ServiceLogger,
} from '../services/errors.js';
import {
  promoteForPrincipal,
  VERIFICATION_NOTE_MAX_LENGTH,
  verifyForPrincipal,
} from '../services/lifecycle.js';
import {
  auditAgentsMdRead,
  prepareAgentsMdForPrincipal,
  renderAgentsMdForPrincipal,
} from '../services/agents-md.js';
import { ensureScopeForPrincipal, validateScopeRef } from '../services/scopes.js';
import { assertEmbeddingProviderDimension } from '../storage/schema.js';
import {
  configuredReviewHorizonDays,
  reviewQueueForPrincipal,
} from '../services/review-queue.js';
import { isLifecyclePrincipal } from '../lifecycle/principal.js';
import { gapConfigFromEnv, renderGapMarkdown, type GapConfig } from '../insights/gaps.js';
import { getKnowledgeGaps } from '../services/gaps.js';
import {
  DEFAULT_RELATION_THRESHOLD,
  relationThresholdFromEnv,
  validateRelationThreshold,
} from '../services/relations.js';

const SCOPE_KINDS = ['org', 'team', 'project', 'user', 'role'] as const;
const MEMORY_TYPES = ['fact', 'decision', 'context', 'playbook', 'relationship'] as const;

export interface McpDeps {
  pool: pg.Pool;
  embeddingProvider: EmbeddingRouting;
  principal: Principal;
  logger?: ServiceLogger;
  reviewHorizonDays?: number;
  gapConfig?: GapConfig;
  now?: () => Date;
  relationThreshold?: number;
}

function textResult(text: string): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return textResult(JSON.stringify(value, null, 2));
}

function serviceErrorResult(error: unknown, logger: ServiceLogger): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const mapped = asServiceError(error);
  logInternalServiceError(logger, 'MCP', mapped);
  return { ...jsonResult(serviceErrorBody(mapped)), isError: true };
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const { pool, embeddingProvider, principal } = deps;
  const relationThreshold = validateRelationThreshold(
    deps.relationThreshold ?? DEFAULT_RELATION_THRESHOLD,
  );
  if (isLifecyclePrincipal(principal)) {
    throw new Error('The internal lifecycle principal cannot start an MCP session');
  }
  for (const provider of asEmbeddingRouter(embeddingProvider).providers()) {
    assertEmbeddingProviderDimension(provider);
  }
  const logger = deps.logger ?? console;
  const gapConfig = deps.gapConfig ?? gapConfigFromEnv();
  const now = deps.now ?? (() => new Date());
  const errorResult = (error: unknown) => serviceErrorResult(error, logger);

  const server = new McpServer({
    name: 'continuum',
    version: '0.1.0',
  });

  server.registerTool(
    'continuum.list_scopes',
    {
      description:
        'List all scopes the calling principal can read, including the global org scope.',
      inputSchema: {},
    },
    async () => {
      try {
        const scopes = await accessibleScopes(pool, principal.id);
        return jsonResult([...scopes.values()].map((scope) => ({
          scope: scope.label,
          role: scope.role,
        })));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'continuum.capture',
    {
      description:
        'Capture a memory in a specific scope. Requires writer role on the target scope.',
      inputSchema: {
        scope_kind: z.enum(SCOPE_KINDS),
        scope_name: z.string().describe('Empty string for org scope.'),
        type: z.enum(MEMORY_TYPES),
        title: z.string().min(1).max(500),
        body: z.string().min(1),
        source: z.string().min(1).default('manual'),
        source_ref: z.string().optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    async (args) => {
      try {
        const ref = { kind: args.scope_kind as ScopeKind, name: args.scope_name };
        const result = await captureMemory(
          pool,
          embeddingProvider,
          principal,
          {
            scope: ref,
            type: args.type,
            title: args.title,
            body: args.body,
            source: args.source,
            sourceRef: args.source_ref,
            tags: args.tags,
            metadata: args.metadata,
          },
          { transport: 'mcp' },
          { relationThreshold },
        );
        return jsonResult({
          id: result.memory.id,
          scope: ref.kind === 'org' ? 'org' : `${ref.kind}:${ref.name}`,
          expires_at: result.memory.expiresAt,
          embedded: result.embedded,
          related: result.related,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'continuum.recall',
    {
      description:
        'Recall memories from the principal\'s accessible scopes. Hybrid vector + full-text search with RRF.',
      inputSchema: {
        query: z.string().min(1).max(2000),
        scopes: z
          .array(z.string())
          .optional()
          .describe(
            'Optional scope filter as ["org", "team:payments", ...]. Unauthorised scopes are silently dropped.',
          ),
        types: z.array(z.enum(MEMORY_TYPES)).optional(),
        limit: z.number().int().min(1).max(100).default(10),
      },
    },
    async (args) => {
      try {
        const { results, accessible } = await recallForPrincipal(
          pool,
          embeddingProvider,
          principal,
          args,
          { transport: 'mcp' },
        );
        return jsonResult(
          results.map((r) => ({
            id: r.memory.id,
            score: r.score,
            scope: accessible.get(r.memory.scopeId)?.label ?? null,
            type: r.memory.type,
            title: r.memory.title,
            excerpt: r.excerpt,
            source_ref: r.memory.sourceRef,
            created_at: r.memory.createdAt,
          })),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'continuum.review_queue',
    {
      description:
        'List readable memories that the caller authored or can explicitly verify and that need review.',
      inputSchema: {
        scopes: z.array(z.string()).optional(),
        types: z.array(z.enum(MEMORY_TYPES)).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(10_000).optional(),
        horizon_days: z.number().int().min(0).max(365).optional(),
      },
    },
    async (args) => {
      try {
        const result = await reviewQueueForPrincipal(pool, principal, {
          scopes: args.scopes,
          types: args.types,
          limit: args.limit,
          offset: args.offset,
          horizonDays: args.horizon_days,
        }, {
          defaultHorizonDays: deps.reviewHorizonDays,
          auditMetadata: { transport: 'mcp' },
        });
        return jsonResult({
          items: result.items.map((item) => ({
            id: item.id,
            scope: item.scope,
            type: item.type,
            title: item.title,
            state: item.state,
            reason: item.reason,
            due: item.due,
            last_verified: item.lastVerified,
            author: item.author,
            can_verify: item.canVerify,
          })),
          limit: result.limit,
          offset: result.offset,
          horizon_days: result.horizonDays,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'continuum.promote',
    {
      description:
        'Promote a memory to a higher scope. Requires writer or admin on the source; the destination requires admin for org or writer/admin otherwise. Creates a new memory in the target scope and marks the source as promoted.',
      inputSchema: {
        memory_id: z.string().uuid(),
        target_scope_kind: z.enum(SCOPE_KINDS),
        target_scope_name: z.string(),
      },
    },
    async (args) => {
      try {
        const { source, destination } = await promoteForPrincipal(
          pool,
          principal,
          args.memory_id,
          { kind: args.target_scope_kind as ScopeKind, name: args.target_scope_name },
          { transport: 'mcp' },
        );
        return jsonResult({
          source_id: source.id,
          destination_id: destination.id,
          destination_scope_id: destination.scopeId,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'continuum.verify',
    {
      description:
        'Verify a memory: mark it confirmed (still_true=true) or stale (still_true=false). Requires an explicit writer or admin role on the memory scope. Authorship and read access do not grant mutation authority.',
      inputSchema: {
        memory_id: z.string().uuid(),
        still_true: z.boolean(),
        note: z.string()
          .describe(
            `Optional verification note; maximum ${VERIFICATION_NOTE_MAX_LENGTH} UTF-16 code units, valid Unicode only, and no unsupported control characters.`,
          )
          .optional(),
      },
    },
    async (args) => {
      try {
        const memory = await verifyForPrincipal(
          pool,
          principal,
          args.memory_id,
          args.still_true,
          args.note,
          { transport: 'mcp' },
        );
        return jsonResult({
          id: memory.id,
          state: memory.state,
          last_verified: memory.lastVerified,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'continuum.agents_md',
    {
      description:
        'Render the AGENTS.md bootstrap bundle for the calling principal. Always includes org and any role scopes; optionally includes a specific project and/or team scope.',
      inputSchema: {
        project: z.string().max(500).optional(),
        team: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      try {
        const md = await renderAgentsMdForPrincipal(pool, principal, {
          project: args.project,
          team: args.team,
          limit: args.limit,
        }, { transport: 'mcp' });
        return textResult(md);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'continuum.agents_md_fresh',
    {
      description:
        'Check whether a stored AGENTS.md SHA-256 hash matches the current bundle for the calling principal and selected scopes.',
      inputSchema: {
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        project: z.string().max(500).optional(),
        team: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      try {
        const input = {
          project: args.project,
          team: args.team,
          limit: args.limit,
        };
        const bundle = await prepareAgentsMdForPrincipal(pool, principal, input);
        const fresh = bundle.hash === args.hash;
        await auditAgentsMdRead(pool, principal, input, bundle, false, {
          transport: 'mcp',
          view: 'agents-md-freshness',
          fresh,
        });
        return jsonResult({ fresh });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'continuum.gaps',
    {
      description:
        'Render an organization knowledge-gap report from zero-hit recall audits. Requires explicit org admin.',
      inputSchema: {
        since: z.string().regex(/^([1-9]\d{0,2})d$/).default('30d'),
        limit: z.number().int().min(1).max(gapConfig.maxLimit).default(gapConfig.defaultLimit),
        min_frequency: z.number().int().min(1).max(gapConfig.candidateLimit)
          .default(gapConfig.defaultMinFrequency),
        threshold: z.number().min(0).max(1).default(gapConfig.threshold),
      },
    },
    async (args) => {
      try {
        const sinceDays = Number(args.since.slice(0, -1));
        if (sinceDays > 365) {
          throw new ServiceError('INVALID_INPUT', 'since must not exceed 365d');
        }
        const report = await getKnowledgeGaps(
          pool,
          embeddingProvider,
          principal,
          {
            sinceDays,
            limit: args.limit,
            minFrequency: args.min_frequency,
            threshold: args.threshold,
            candidateLimit: gapConfig.candidateLimit,
            scanLimit: gapConfig.scanLimit,
            maxQueryChars: gapConfig.maxQueryChars,
            embeddingTimeoutMs: gapConfig.embeddingTimeoutMs,
            now: now(),
            transport: 'mcp',
          },
        );
        return textResult(renderGapMarkdown(report));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // Helper: create a scope on demand. Useful before promotion or first capture.
  server.registerTool(
    'continuum.ensure_scope',
    {
      description:
        'Get or create a scope. Requires explicit org admin. Returns the scope id and does not grant memberships.',
      inputSchema: {
        kind: z.enum(SCOPE_KINDS),
        name: z.string(),
      },
    },
    async (args) => {
      try {
        const ref = validateScopeRef({
          kind: args.kind as ScopeKind,
          name: args.name,
        });
        const result = await ensureScopeForPrincipal(
          pool,
          principal,
          ref,
          { transport: 'mcp' },
        );
        return jsonResult({
          id: result.scope.id,
          scope: result.scope.kind === 'org'
            ? 'org'
            : `${result.scope.kind}:${result.scope.name}`,
          created: result.created,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const tokenEnv =
    process.env.CONTINUUM_PRINCIPAL_EXTERNAL_ID ?? process.env.CONTINUUM_BEARER;
  if (!tokenEnv) {
    process.stderr.write(
      'continuum-mcp: set CONTINUUM_PRINCIPAL_EXTERNAL_ID (or CONTINUUM_BEARER) to the calling principal external_id\n',
    );
    process.exit(1);
  }
  const pool = getPool();
  const principal = await getPrincipalByExternalId(pool, tokenEnv);
  if (!principal || isLifecyclePrincipal(principal)) {
    process.stderr.write('continuum-mcp: unknown principal\n');
    process.exit(1);
  }
  const embeddingProvider = makeEmbeddingRouterFromEnv();
  const server = buildMcpServer({
    pool,
    embeddingProvider,
    principal,
    reviewHorizonDays: configuredReviewHorizonDays(),
    relationThreshold: relationThresholdFromEnv(),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isDirectEntrypoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`continuum-mcp fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
