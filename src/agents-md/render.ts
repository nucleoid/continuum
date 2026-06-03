import type pg from 'pg';
import type { Memory, MemoryType, ScopeRef } from '../types.js';
import { getScopeByRef } from '../storage/scopes.js';
import { getScopesForPrincipal } from '../storage/memberships.js';

const SECTION_ORDER: Array<{ key: 'org' | 'role' | 'team' | 'project'; heading: string }> = [
  { key: 'org', heading: 'Org' },
  { key: 'role', heading: 'Role' },
  { key: 'team', heading: 'Team' },
  { key: 'project', heading: 'Project' },
];

// Per-section preference for which memory types lead. Context is excluded
// from AGENTS.md by default: it decays fast and is rarely useful as
// agent-bootstrap context.
const TYPE_ORDER: MemoryType[] = ['decision', 'playbook', 'fact', 'relationship'];

interface ResolvedScope {
  id: string;
  kind: ScopeRef['kind'];
  name: string;
  heading: string;
}

export interface RenderOptions {
  principalId: string;
  project?: string;
  team?: string;
  perScopeLimit?: number;
}

export async function renderAgentsMd(
  pool: pg.Pool,
  opts: RenderOptions,
): Promise<string> {
  const perScopeLimit = opts.perScopeLimit ?? 20;
  const memberships = await getScopesForPrincipal(pool, opts.principalId);
  const accessible = new Map<string, ResolvedScope>();

  const org = await getScopeByRef(pool, { kind: 'org', name: '' });
  if (org) {
    accessible.set(org.id, { id: org.id, kind: 'org', name: '', heading: 'org' });
  }
  for (const m of memberships) {
    accessible.set(m.id, {
      id: m.id,
      kind: m.kind,
      name: m.name,
      heading: m.kind === 'org' ? 'org' : `${m.kind}:${m.name}`,
    });
  }

  const targets: ResolvedScope[] = [];
  // Always include org if present.
  const orgScope = Array.from(accessible.values()).find((s) => s.kind === 'org');
  if (orgScope) targets.push(orgScope);
  // Role scopes the caller belongs to.
  for (const s of accessible.values()) {
    if (s.kind === 'role') targets.push(s);
  }
  if (opts.team) {
    const teamScope = Array.from(accessible.values()).find(
      (s) => s.kind === 'team' && s.name === opts.team,
    );
    if (teamScope) targets.push(teamScope);
  }
  if (opts.project) {
    const projectScope = Array.from(accessible.values()).find(
      (s) => s.kind === 'project' && s.name === opts.project,
    );
    if (projectScope) targets.push(projectScope);
  }

  const sections: string[] = [];
  sections.push('# AGENTS.md');
  sections.push('');
  sections.push(
    'Auto-generated context bundle from Continuum. Each section lists memories ' +
      'the calling principal can read in the named scope, filtered to ' +
      'high-signal types and capped per scope.',
  );
  sections.push('');

  // Stable section order: SECTION_ORDER then by name within kind.
  targets.sort((a, b) => {
    const orderA = SECTION_ORDER.findIndex((o) => o.key === a.kind);
    const orderB = SECTION_ORDER.findIndex((o) => o.key === b.kind);
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name);
  });

  for (const scope of targets) {
    const memories = await fetchSectionMemories(pool, scope.id, perScopeLimit);
    if (memories.length === 0) continue;

    sections.push(`## ${scope.heading}`);
    sections.push('');

    const byType = new Map<MemoryType, Memory[]>();
    for (const m of memories) {
      const list = byType.get(m.type) ?? [];
      list.push(m);
      byType.set(m.type, list);
    }
    for (const type of TYPE_ORDER) {
      const list = byType.get(type);
      if (!list || list.length === 0) continue;
      sections.push(`### ${capitalise(type)}s`);
      sections.push('');
      for (const m of list) {
        const trailer = m.sourceRef ? ` (source: ${m.sourceRef})` : '';
        sections.push(`- **${m.title}**${trailer}`);
        for (const line of m.body.split('\n')) {
          if (line.trim() === '') continue;
          sections.push(`  ${line}`);
        }
        sections.push('');
      }
    }
  }

  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

async function fetchSectionMemories(
  pool: pg.Pool,
  scopeId: string,
  limit: number,
): Promise<Memory[]> {
  const { rows } = await pool.query(
    `SELECT id, scope_id, type, title, body, metadata, tags, author_id,
            source, source_ref, state, supersedes_id, promoted_to_id,
            created_at, updated_at, expires_at, last_verified
       FROM memories
      WHERE scope_id = $1
        AND state = 'live'
        AND type = ANY($2::text[])
      ORDER BY array_position($2::text[], type),
               COALESCE(last_verified, updated_at) DESC,
               created_at DESC
      LIMIT $3`,
    [scopeId, TYPE_ORDER, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    scopeId: row.scope_id,
    type: row.type,
    title: row.title,
    body: row.body,
    metadata: row.metadata ?? {},
    tags: row.tags ?? [],
    authorId: row.author_id,
    source: row.source,
    sourceRef: row.source_ref ?? null,
    state: row.state,
    supersedesId: row.supersedes_id ?? null,
    promotedToId: row.promoted_to_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? null,
    lastVerified: row.last_verified ?? null,
  }));
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
