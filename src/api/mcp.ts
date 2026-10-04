import type pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getPrincipalByExternalId } from '../storage/principals.js';
import { getOrCreateScope } from '../storage/scopes.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { Principal, ScopeKind } from '../types.js';
import { getPool } from '../storage/pool.js';
import { makeEmbeddingProviderFromEnv } from '../embeddings/factory.js';
import { isDirectEntrypoint } from './entrypoint.js';
import { accessibleScopes } from '../services/access.js';
import { captureMemory } from '../services/capture.js';
import { recallForPrincipal } from '../services/recall.js';
import {
  asServiceError,
  logInternalServiceError,
  serviceErrorBody,
  type ServiceLogger,
} from '../services/errors.js';
import { promoteForPrincipal, verifyForPrincipal } from '../services/lifecycle.js';
import { renderAgentsMdForPrincipal } from '../services/agents-md.js';
import { validateScopeRef } from '../services/scopes.js';

const SCOPE_KINDS = ['org', 'team', 'project', 'user', 'role'] as const;
const MEMORY_TYPES = ['fact', 'decision', 'context', 'playbook', 'relationship'] as const;

export interface McpDeps {
  pool: pg.Pool;
  embeddingProvider: EmbeddingProvider | null;
  principal: Principal;
  logger?: ServiceLogger;
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
  const logger = deps.logger ?? console;
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
        );
        return jsonResult({
          id: result.memory.id,
          scope: ref.kind === 'org' ? 'org' : `${ref.kind}:${ref.name}`,
          expires_at: result.memory.expiresAt,
          embedded: result.embedded,
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
        'Verify a memory: mark it confirmed (still_true=true) or stale (still_true=false). Requires an explicit writer or admin role on the memory scope; implicit org access and reader roles are read-only.',
      inputSchema: {
        memory_id: z.string().uuid(),
        still_true: z.boolean(),
        note: z.string().optional(),
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
        project: z.string().optional(),
        team: z.string().optional(),
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

  // Helper: create a scope on demand. Useful before promotion or first capture.
  server.registerTool(
    'continuum.ensure_scope',
    {
      description:
        'Get or create a scope. Returns the scope id. Does not grant any memberships.',
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
        const scope = await getOrCreateScope(pool, ref);
        return jsonResult({
          id: scope.id,
          scope: scope.kind === 'org' ? 'org' : `${scope.kind}:${scope.name}`,
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
  if (!principal) {
    process.stderr.write(`continuum-mcp: unknown principal ${tokenEnv}\n`);
    process.exit(1);
  }
  const embeddingProvider = makeEmbeddingProviderFromEnv();
  const server = buildMcpServer({ pool, embeddingProvider, principal });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isDirectEntrypoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`continuum-mcp fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
