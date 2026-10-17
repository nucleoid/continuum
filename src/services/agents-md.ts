import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Memory, Principal } from '../types.js';
import { renderAgentsMdResult } from '../agents-md/render.js';
import { recordRead as recordReadAudit } from '../audit/log.js';
import { asServiceError } from './errors.js';

export interface AgentsMdInput {
  project?: string;
  team?: string;
  limit?: number;
}

export interface AgentsMdBundle {
  markdown: string;
  hash: string;
  etag: string;
  memories: Memory[];
}

export async function prepareAgentsMdForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  input: AgentsMdInput,
  readBudgetBytes?: number,
): Promise<AgentsMdBundle> {
  try {
    // This transport deliberately uses the scoped text renderer, not ranked
    // RecallResult objects. Optional retrieval enrichments never enter generated
    // bytes, selection, the digest, or the required generator read audit.
    // Personal standup attribution and closure tables are a separate reader;
    // they do not enter this bundle or expand its scoped selection.
    const { markdown, memories } = await renderAgentsMdResult(pool, {
      principalId: principal.id,
      project: input.project,
      team: input.team,
      perScopeLimit: input.limit,
      readBudgetBytes,
    });
    const hash = createHash('sha256').update(markdown, 'utf8').digest('hex');
    return { markdown, hash, etag: `"${hash}"`, memories };
  } catch (error) {
    throw asServiceError(error);
  }
}

export async function auditAgentsMdRead(
  pool: pg.Pool,
  principal: Principal,
  input: AgentsMdInput,
  bundle: AgentsMdBundle,
  delivered: boolean,
  auditMetadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const memories = delivered ? bundle.memories : [];
    await recordReadAudit(pool, {
      principalId: principal.id,
      metadata: {
        view: 'agents-md',
        // AGENTS.md uses deterministic scoped selection, not hybrid recall.
        vector_status: 'not_applicable',
        project: input.project ?? null,
        team: input.team ?? null,
        hits: memories.length,
        ...auditMetadata,
      },
      memories: memories.map((memory, index) => ({
        memoryId: memory.id,
        scopeId: memory.scopeId,
        metadata: { rank: index + 1, delivery: 'agents-md' },
      })),
    });
  } catch (error) {
    throw asServiceError(error);
  }
}

export async function renderAgentsMdForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  input: AgentsMdInput,
  auditMetadata: Record<string, unknown> = {},
  readBudgetBytes?: number,
): Promise<string> {
  const bundle = await prepareAgentsMdForPrincipal(pool, principal, input, readBudgetBytes);
  await auditAgentsMdRead(pool, principal, input, bundle, true, auditMetadata);
  return bundle.markdown;
}
