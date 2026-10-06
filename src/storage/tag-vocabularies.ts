import type { ScopeKind, TagVocabulary } from '../types.js';
import type { Queryable } from './queryable.js';

const COLUMNS = 'scope_kind, tag, description, created_by, is_system, created_at, updated_at';

function rowToVocabulary(row: Record<string, unknown>): TagVocabulary {
  return {
    scopeKind: row.scope_kind as ScopeKind,
    tag: row.tag as string,
    description: row.description as string,
    createdBy: row.created_by as string | null,
    isSystem: row.is_system as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function listTagVocabulary(
  queryable: Queryable,
  scopeKind: ScopeKind,
): Promise<TagVocabulary[]> {
  const { rows } = await queryable.query(
    `SELECT ${COLUMNS}
       FROM tag_vocabularies
      WHERE scope_kind = $1
      ORDER BY tag`,
    [scopeKind],
  );
  return rows.map(rowToVocabulary);
}

export async function lockRequestedTags(
  queryable: Queryable,
  scopeKind: ScopeKind,
  tags: readonly string[],
): Promise<string[]> {
  if (tags.length === 0) return [];
  const { rows } = await queryable.query(
    `SELECT tag
       FROM tag_vocabularies
      WHERE scope_kind = $1 AND tag = ANY($2::text[])
      ORDER BY tag
      FOR KEY SHARE`,
    [scopeKind, tags],
  );
  return rows.map((row) => row.tag as string);
}

export async function findRequestedTags(
  queryable: Queryable,
  scopeKind: ScopeKind,
  tags: readonly string[],
): Promise<string[]> {
  if (tags.length === 0) return [];
  const { rows } = await queryable.query(
    `SELECT tag
       FROM tag_vocabularies
      WHERE scope_kind = $1 AND tag = ANY($2::text[])
      ORDER BY tag`,
    [scopeKind, tags],
  );
  return rows.map((row) => row.tag as string);
}

export async function lockTagVocabulary(
  queryable: Queryable,
  scopeKind: ScopeKind,
  tag: string,
): Promise<TagVocabulary | null> {
  const { rows } = await queryable.query(
    `SELECT ${COLUMNS}
       FROM tag_vocabularies
      WHERE scope_kind = $1 AND tag = $2
      FOR UPDATE`,
    [scopeKind, tag],
  );
  return rows[0] ? rowToVocabulary(rows[0]) : null;
}

export async function createTagVocabulary(
  queryable: Queryable,
  input: { scopeKind: ScopeKind; tag: string; description: string; createdBy: string },
): Promise<TagVocabulary | null> {
  const { rows } = await queryable.query(
    `INSERT INTO tag_vocabularies (scope_kind, tag, description, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope_kind, tag) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.scopeKind, input.tag, input.description, input.createdBy],
  );
  return rows[0] ? rowToVocabulary(rows[0]) : null;
}

export async function updateTagVocabulary(
  queryable: Queryable,
  scopeKind: ScopeKind,
  tag: string,
  description: string,
): Promise<{ before: TagVocabulary; after: TagVocabulary } | null> {
  const beforeResult = await queryable.query(
    `SELECT ${COLUMNS}
       FROM tag_vocabularies
      WHERE scope_kind = $1 AND tag = $2
      FOR NO KEY UPDATE`,
    [scopeKind, tag],
  );
  if (!beforeResult.rows[0]) return null;
  const { rows } = await queryable.query(
    `UPDATE tag_vocabularies
        SET description = $3, updated_at = now()
      WHERE scope_kind = $1 AND tag = $2
      RETURNING ${COLUMNS}`,
    [scopeKind, tag, description],
  );
  return { before: rowToVocabulary(beforeResult.rows[0]), after: rowToVocabulary(rows[0]) };
}

export async function deleteTagVocabulary(
  queryable: Queryable,
  scopeKind: ScopeKind,
  tag: string,
): Promise<TagVocabulary | null> {
  const { rows } = await queryable.query(
    `DELETE FROM tag_vocabularies
      WHERE scope_kind = $1 AND tag = $2
      RETURNING ${COLUMNS}`,
    [scopeKind, tag],
  );
  return rows[0] ? rowToVocabulary(rows[0]) : null;
}

export async function tagIsInUse(
  queryable: Queryable,
  scopeKind: ScopeKind,
  tag: string,
): Promise<boolean> {
  const { rowCount } = await queryable.query(
    `SELECT 1
       FROM memories AS memory
       JOIN scopes AS scope ON scope.id = memory.scope_id
      WHERE scope.kind = $1 AND memory.tags @> ARRAY[$2]::text[]
      LIMIT 1`,
    [scopeKind, tag],
  );
  return (rowCount ?? 0) > 0;
}
