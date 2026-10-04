import type pg from 'pg';
import type { Principal } from '../types.js';
import { renderAgentsMd } from '../agents-md/render.js';
import { record as recordAudit } from '../audit/log.js';
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
    const markdown = await renderAgentsMd(pool, {
      principalId: principal.id,
      project: input.project,
      team: input.team,
      perScopeLimit: input.limit,
    });
    await recordAudit(pool, {
      principalId: principal.id,
      action: 'read',
      metadata: {
        view: 'agents-md',
        project: input.project ?? null,
        team: input.team ?? null,
        ...auditMetadata,
      },
    });
    return markdown;
  } catch (error) {
    throw asServiceError(error);
  }
}
