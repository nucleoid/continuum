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
): Promise<AgentsMdBundle> {
  try {
    const { markdown, memories } = await renderAgentsMdResult(pool, {
      principalId: principal.id,
      project: input.project,
      team: input.team,
      perScopeLimit: input.limit,
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
): Promise<string> {
  const bundle = await prepareAgentsMdForPrincipal(pool, principal, input);
  await auditAgentsMdRead(pool, principal, input, bundle, true, auditMetadata);
  return bundle.markdown;
}
