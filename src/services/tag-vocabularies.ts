import type pg from 'pg';
import type { Principal, ScopeKind, TagVocabulary } from '../types.js';
import { record as recordAudit } from '../audit/log.js';
import { hasExplicitRoleForMutation } from '../scopes/access.js';
import { getScopeByRef } from '../storage/scopes.js';
import {
  createTagVocabulary as createTagVocabularyRow,
  deleteTagVocabulary as deleteTagVocabularyRow,
  listTagVocabulary as listTagVocabularyRows,
  lockAllowedTags,
  lockTagVocabulary,
  tagIsInUse,
  updateTagVocabulary as updateTagVocabularyRow,
} from '../storage/tag-vocabularies.js';
import type { Queryable } from '../storage/queryable.js';
import { asServiceError, dependencyUnavailable, ServiceError } from './errors.js';

export const TAG_MAX_COUNT = 32;
export const TAG_MAX_LENGTH = 64;
export const TAG_DESCRIPTION_MAX_LENGTH = 500;
export const TAG_ERROR_ALLOWED_LIMIT = 100;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOPE_KINDS = new Set<ScopeKind>(['org', 'team', 'project', 'user', 'role']);

function assertScopeKind(value: ScopeKind): void {
  if (!SCOPE_KINDS.has(value)) throw new ServiceError('INVALID_INPUT', 'Invalid scope kind');
}

export function normalizeTag(tag: string): string {
  if (typeof tag !== 'string') throw new ServiceError('INVALID_INPUT', 'Tags must be strings');
  const normalized = tag.trim().toLowerCase();
  if (!normalized || normalized.length > TAG_MAX_LENGTH || !TAG_PATTERN.test(normalized)) {
    throw new ServiceError(
      'INVALID_INPUT',
      `Tags must be 1 to ${TAG_MAX_LENGTH} lowercase letters, numbers, or hyphen-separated words`,
    );
  }
  return normalized;
}

export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  if (!Array.isArray(tags) || tags.length > TAG_MAX_COUNT) {
    throw new ServiceError('INVALID_INPUT', `At most ${TAG_MAX_COUNT} tags are allowed`);
  }
  const normalized = tags.map(normalizeTag);
  if (new Set(normalized).size !== normalized.length) {
    throw new ServiceError('INVALID_INPUT', 'Tags must be unique after normalization');
  }
  return normalized;
}

function validateDescription(description: string): string {
  if (typeof description !== 'string' || description.length > TAG_DESCRIPTION_MAX_LENGTH) {
    throw new ServiceError(
      'INVALID_INPUT',
      `Tag descriptions must be at most ${TAG_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return description;
}

export async function validateTagsForScopeKind(
  queryable: Queryable,
  scopeKind: ScopeKind,
  tags: readonly string[],
  lock = false,
): Promise<void> {
  if (tags.length === 0) return;
  const allowed = lock
    ? await lockAllowedTags(queryable, scopeKind)
    : (await listTagVocabularyRows(queryable, scopeKind)).map((entry) => entry.tag);
  const allowedSet = new Set(allowed);
  const unknown = [...new Set(tags.filter((tag) => !allowedSet.has(tag)))].sort();
  if (unknown.length > 0) {
    throw new ServiceError(
      'UNKNOWN_TAGS',
      'One or more tags are not in the vocabulary for this scope kind',
      {
        details: {
          scopeKind,
          unknownTags: unknown,
          allowedTags: allowed.slice(0, TAG_ERROR_ALLOWED_LIMIT),
        },
      },
    );
  }
}

export async function listTagVocabulary(
  queryable: Queryable,
  scopeKind: ScopeKind,
): Promise<TagVocabulary[]> {
  assertScopeKind(scopeKind);
  return listTagVocabularyRows(queryable, scopeKind);
}

async function requireLockedOrgAdmin(queryable: Queryable, principalId: string): Promise<string> {
  const org = await getScopeByRef(queryable, { kind: 'org', name: '' });
  if (!org || !await hasExplicitRoleForMutation(queryable, principalId, org.id, 'admin')) {
    throw new ServiceError('FORBIDDEN', 'Principal lacks admin role on org scope');
  }
  return org.id;
}

async function inMutationTransaction<T>(pool: pg.Pool, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw dependencyUnavailable(error);
  }
  let destroy = false;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}

function auditValue(entry: TagVocabulary): Record<string, unknown> {
  return { description: entry.description, isSystem: entry.isSystem };
}

export async function addTagVocabulary(
  pool: pg.Pool,
  principal: Principal,
  input: { scopeKind: ScopeKind; tag: string; description?: string },
): Promise<TagVocabulary> {
  try {
    assertScopeKind(input.scopeKind);
    const tag = normalizeTag(input.tag);
    const description = validateDescription(input.description ?? '');
    return await inMutationTransaction(pool, async (client) => {
      const orgId = await requireLockedOrgAdmin(client, principal.id);
      const created = await createTagVocabularyRow(client, {
        scopeKind: input.scopeKind, tag, description, createdBy: principal.id,
      });
      if (!created) throw new ServiceError('CONFLICT', 'Tag already exists for this scope kind');
      await recordAudit(client, {
        principalId: principal.id, action: 'write', scopeId: orgId,
        metadata: {
          operation: 'create_tag_vocabulary', scopeKind: input.scopeKind, tag,
          before: null, after: auditValue(created),
        },
      });
      return created;
    });
  } catch (error) {
    throw asServiceError(error);
  }
}

export async function changeTagVocabulary(
  pool: pg.Pool,
  principal: Principal,
  input: { scopeKind: ScopeKind; tag: string; description: string },
): Promise<TagVocabulary> {
  try {
    assertScopeKind(input.scopeKind);
    const tag = normalizeTag(input.tag);
    const description = validateDescription(input.description);
    return await inMutationTransaction(pool, async (client) => {
      const orgId = await requireLockedOrgAdmin(client, principal.id);
      const changed = await updateTagVocabularyRow(client, input.scopeKind, tag, description);
      if (!changed) throw new ServiceError('TAG_NOT_FOUND', 'Tag vocabulary entry not found');
      await recordAudit(client, {
        principalId: principal.id, action: 'write', scopeId: orgId,
        metadata: {
          operation: 'update_tag_vocabulary', scopeKind: input.scopeKind, tag,
          before: auditValue(changed.before), after: auditValue(changed.after),
        },
      });
      return changed.after;
    });
  } catch (error) {
    throw asServiceError(error);
  }
}

export async function removeTagVocabulary(
  pool: pg.Pool,
  principal: Principal,
  input: { scopeKind: ScopeKind; tag: string },
): Promise<void> {
  try {
    assertScopeKind(input.scopeKind);
    const tag = normalizeTag(input.tag);
    await inMutationTransaction(pool, async (client) => {
      const orgId = await requireLockedOrgAdmin(client, principal.id);
      const locked = await lockTagVocabulary(client, input.scopeKind, tag);
      if (!locked) throw new ServiceError('TAG_NOT_FOUND', 'Tag vocabulary entry not found');
      if (await tagIsInUse(client, input.scopeKind, tag)) {
        throw new ServiceError('CONFLICT', 'Tag is in use by memories in this scope kind');
      }
      const deleted = await deleteTagVocabularyRow(client, input.scopeKind, tag);
      if (!deleted) throw new ServiceError('TAG_NOT_FOUND', 'Tag vocabulary entry not found');
      await recordAudit(client, {
        principalId: principal.id, action: 'write', scopeId: orgId,
        metadata: {
          operation: 'delete_tag_vocabulary', scopeKind: input.scopeKind, tag,
          before: auditValue(deleted), after: null,
        },
      });
    });
  } catch (error) {
    throw asServiceError(error);
  }
}
