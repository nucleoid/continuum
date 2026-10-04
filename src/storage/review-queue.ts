import type pg from 'pg';
import type { MemoryState, MemoryType } from '../types.js';

export type ReviewReason = 'stale' | 'playbook_review_due' | 'expiring_soon';

export interface ReviewQueueItem {
  id: string;
  scopeId: string;
  scope: string;
  type: MemoryType;
  title: string;
  state: MemoryState;
  reason: ReviewReason;
  due: Date;
  lastVerified: Date | null;
  author: { id: string; displayName: string };
  canVerify: boolean;
}

export interface ReviewQueueFilter {
  now?: Date;
  horizonDays?: number;
  scopeLabels?: string[];
  types?: MemoryType[];
  limit?: number;
  offset?: number;
}

interface ReviewQueueRow {
  id: string;
  scope_id: string;
  scope_label: string;
  type: MemoryType;
  title: string;
  state: MemoryState;
  reason: ReviewReason;
  due_at: Date;
  last_verified: Date | null;
  author_id: string;
  author_display_name: string;
  can_verify: boolean;
}

export async function listReviewQueue(
  pool: pg.Pool,
  principalId: string,
  filter: ReviewQueueFilter = {},
): Promise<ReviewQueueItem[]> {
  const now = filter.now ?? new Date();
  const horizonDays = filter.horizonDays ?? 14;
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  const { rows } = await pool.query<ReviewQueueRow>(
    `WITH candidates AS (
       SELECT m.id, m.scope_id,
              CASE WHEN s.kind = 'org' THEN 'org' ELSE s.kind || ':' || s.name END AS scope_label,
              m.type, m.title, m.state, m.last_verified, m.author_id,
              p.display_name AS author_display_name,
              COALESCE(membership.role IN ('writer', 'admin'), false) AS can_verify,
              CASE
                WHEN m.state = 'stale' THEN 'stale'
                WHEN m.type = 'playbook' THEN 'playbook_review_due'
                ELSE 'expiring_soon'
              END AS reason,
              CASE
                WHEN m.state = 'stale' THEN COALESCE(
                  m.expires_at,
                  COALESCE(m.last_verified, m.created_at)
                    + CASE WHEN m.type = 'relationship' THEN interval '180 days' ELSE interval '90 days' END
                )
                WHEN m.type = 'playbook' THEN COALESCE(m.last_verified, m.created_at) + interval '180 days'
                ELSE m.expires_at
              END AS due_at
         FROM memories m
         JOIN scopes s ON s.id = m.scope_id
         JOIN principals p ON p.id = m.author_id
         LEFT JOIN scope_memberships membership
           ON membership.scope_id = m.scope_id AND membership.principal_id = $1
        WHERE (s.kind = 'org' OR membership.role IS NOT NULL)
          AND (m.author_id = $1 OR membership.role IN ('writer', 'admin'))
          AND (
            (m.state = 'stale' AND m.type IN ('fact', 'relationship'))
            OR (m.state = 'live' AND m.type = 'playbook'
                AND COALESCE(m.last_verified, m.created_at) + interval '180 days' <= $2)
            OR (m.state = 'live' AND m.expires_at > $2
                AND m.expires_at <= $2 + ($3::double precision * interval '1 day'))
          )
     )
     SELECT id, scope_id, scope_label, type, title, state, reason, due_at,
            last_verified, author_id, author_display_name, can_verify
       FROM candidates
      WHERE ($4::text[] IS NULL OR scope_label = ANY($4::text[]))
        AND ($5::text[] IS NULL OR type = ANY($5::text[]))
      ORDER BY due_at ASC, id ASC
      LIMIT $6 OFFSET $7`,
    [principalId, now, horizonDays, filter.scopeLabels ?? null, filter.types ?? null, limit, offset],
  );
  return rows.map((row) => ({
    id: row.id,
    scopeId: row.scope_id,
    scope: row.scope_label,
    type: row.type,
    title: row.title,
    state: row.state,
    reason: row.reason,
    due: row.due_at,
    lastVerified: row.last_verified,
    author: { id: row.author_id, displayName: row.author_display_name },
    canVerify: row.can_verify,
  }));
}
