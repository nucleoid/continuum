import type pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getPrincipalByExternalId } from '../storage/principals.js';
import { getOrCreateScope, getScopeByRef } from '../storage/scopes.js';
import { getScopesForPrincipal, hasRole } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { recall } from '../storage/recall.js';
import { storeMemoryEmbedding } from '../storage/embeddings.js';
import { promoteMemory, verifyMemory, PromoteError } from '../storage/promote.js';
import { record as recordAudit } from '../audit/log.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { Principal, ScopeKind } from '../types.js';
import { getPool } from '../storage/pool.js';
import { makeEmbeddingProviderFromEnv } from '../embeddings/factory.js';

const SCOPE_KINDS = ['org', 'team', 'project', 'user', 'role'] as const;
const MEMORY_TYPES = ['fact', 'decision', 'context', 'playbook', 'relationship'] as const;

export interface McpDeps {
  pool: pg.Pool;
  embeddingProvider: EmbeddingProvider | null;
  principal: Principal;
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

export function buildMcpServer(deps: McpDeps): McpServer {
  const { pool, embeddingProvider, principal } = deps;

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
      const memberships = await getScopesForPrincipal(pool, principal.id);
      const org = await getScopeByRef(pool, { kind: 'org', name: '' });
      const list = memberships.map((m) => ({
        scope: m.kind === 'org' ? 'org' : `${m.kind}:${m.name}`,
        role: m.role,
      }));
      if (org && !memberships.some((m) => m.id === org.id)) {
        list.push({ scope: 'org', role: 'reader' });
      }
      return jsonResult(list);
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
      },
    },
    async (args) => {
      const ref = { kind: args.scope_kind as ScopeKind, name: args.scope_name };
      const scope = await getScopeByRef(pool, ref);
      if (!scope) return textResult(`error: scope not found: ${ref.kind}:${ref.name}`);
      if (!(await hasRole(pool, principal.id, scope.id, 'writer'))) {
        return textResult('error: principal lacks writer role on scope');
      }
      const memory = await createMemory(pool, {
        scopeId: scope.id,
        scopeKind: scope.kind,
        type: args.type,
        title: args.title,
        body: args.body,
        authorId: principal.id,
        source: args.source,
        sourceRef: args.source_ref ?? null,
        tags: args.tags,
      });
      let embedded = false;
      if (embeddingProvider) {
        try {
          await storeMemoryEmbedding(
            pool,
            memory.id,
            `${memory.title}\n\n${memory.body}`,
            embeddingProvider,
          );
          embedded = true;
        } catch {
          embedded = false;
        }
      }
      await recordAudit(pool, {
        principalId: principal.id,
        action: 'write',
        memoryId: memory.id,
        scopeId: scope.id,
        metadata: { source: args.source, type: args.type, transport: 'mcp' },
      });
      return jsonResult({
        id: memory.id,
        scope: ref.kind === 'org' ? 'org' : `${ref.kind}:${ref.name}`,
        expires_at: memory.expiresAt,
        embedded,
      });
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
      const memberships = await getScopesForPrincipal(pool, principal.id);
      const accessible = new Map<string, string>(
        memberships.map((m) => [m.id, m.kind === 'org' ? 'org' : `${m.kind}:${m.name}`]),
      );
      const org = await getScopeByRef(pool, { kind: 'org', name: '' });
      if (org) accessible.set(org.id, 'org');

      let scopeIds: string[];
      if (args.scopes && args.scopes.length > 0) {
        const ids: string[] = [];
        for (const s of args.scopes) {
          const ref = s === 'org'
            ? { kind: 'org' as const, name: '' }
            : (() => {
                const i = s.indexOf(':');
                if (i < 0) return null;
                return { kind: s.slice(0, i) as ScopeKind, name: s.slice(i + 1) };
              })();
          if (!ref) continue;
          const scope = await getScopeByRef(pool, ref);
          if (!scope) continue;
          if (!accessible.has(scope.id)) continue;
          ids.push(scope.id);
        }
        scopeIds = ids;
      } else {
        scopeIds = Array.from(accessible.keys());
      }

      const results = await recall(pool, {
        query: args.query,
        scopeIds,
        types: args.types,
        limit: args.limit,
        embeddingProvider,
      });

      await recordAudit(pool, {
        principalId: principal.id,
        action: 'read',
        query: args.query,
        metadata: { hits: results.length, transport: 'mcp' },
      });

      return jsonResult(
        results.map((r) => ({
          id: r.memory.id,
          score: r.score,
          scope: accessible.get(r.memory.scopeId) ?? null,
          type: r.memory.type,
          title: r.memory.title,
          excerpt: r.excerpt,
          source_ref: r.memory.sourceRef,
          created_at: r.memory.createdAt,
        })),
      );
    },
  );

  server.registerTool(
    'continuum.promote',
    {
      description:
        'Promote a memory to a higher scope. Creates a new memory in the target scope, marks the source as promoted.',
      inputSchema: {
        memory_id: z.string().uuid(),
        target_scope_kind: z.enum(SCOPE_KINDS),
        target_scope_name: z.string(),
      },
    },
    async (args) => {
      try {
        const { source, destination } = await promoteMemory(
          pool,
          principal.id,
          args.memory_id,
          { kind: args.target_scope_kind as ScopeKind, name: args.target_scope_name },
        );
        await recordAudit(pool, {
          principalId: principal.id,
          action: 'promote',
          memoryId: source.id,
          scopeId: destination.scopeId,
          metadata: { destination_id: destination.id, transport: 'mcp' },
        });
        return jsonResult({
          source_id: source.id,
          destination_id: destination.id,
          destination_scope_id: destination.scopeId,
        });
      } catch (err) {
        if (err instanceof PromoteError) return textResult(`error (${err.status}): ${err.message}`);
        throw err;
      }
    },
  );

  server.registerTool(
    'continuum.verify',
    {
      description:
        'Verify a memory: mark it confirmed (still_true=true) or stale (still_true=false). Requires reader role.',
      inputSchema: {
        memory_id: z.string().uuid(),
        still_true: z.boolean(),
        note: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const memory = await verifyMemory(
          pool,
          principal.id,
          args.memory_id,
          args.still_true,
        );
        await recordAudit(pool, {
          principalId: principal.id,
          action: 'verify',
          memoryId: memory.id,
          scopeId: memory.scopeId,
          metadata: { still_true: args.still_true, note: args.note, transport: 'mcp' },
        });
        return jsonResult({
          id: memory.id,
          state: memory.state,
          last_verified: memory.lastVerified,
        });
      } catch (err) {
        if (err instanceof PromoteError) return textResult(`error (${err.status}): ${err.message}`);
        throw err;
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
      const scope = await getOrCreateScope(pool, {
        kind: args.kind as ScopeKind,
        name: args.name,
      });
      return jsonResult({
        id: scope.id,
        scope: scope.kind === 'org' ? 'org' : `${scope.kind}:${scope.name}`,
      });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`continuum-mcp fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
