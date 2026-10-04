import type pg from 'pg';
import type { Principal } from '../types.js';
import { renderAgentsMdResult } from '../agents-md/render.js';
import { recordRead as recordReadAudit } from '../audit/log.js';
import { asServiceError } from './errors.js';

export interface AgentsMdInput {
  project?: string;
  team?: string;
  limit?: number;
}

export async function renderAgentsMdForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  input: AgentsMdInput,
  auditMetadata: Record<string, unknown> = {},
): Promise<string> {
  try {
    const { markdown, memories } = await renderAgentsMdResult(pool, {
      principalId: principal.id,
      project: input.project,
      team: input.team,
      perScopeLimit: input.limit,
    });
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
    return markdown;
  } catch (error) {
    throw asServiceError(error);
  }
}
