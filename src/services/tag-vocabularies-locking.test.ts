import { describe, expect, it, vi } from 'vitest';
import { ServiceError } from './errors.js';
import { validateTagsForScopeKind } from './tag-vocabularies.js';

describe('locked tag validation', () => {
  it('queries only requested tags without locking during preflight validation', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ tag: 'deploy' }] });

    await validateTagsForScopeKind({ query } as never, 'project', ['deploy']);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('tag = ANY($2::text[])');
    expect(query.mock.calls[0][0]).not.toContain('FOR KEY SHARE');
    expect(query.mock.calls[0][1]).toEqual(['project', ['deploy']]);
  });

  it('locks only requested tags and does not fetch the full vocabulary on success', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ tag: 'deploy' }] });

    await validateTagsForScopeKind({ query } as never, 'project', ['deploy'], true);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('tag = ANY($2::text[])');
    expect(query.mock.calls[0][0]).toContain('FOR KEY SHARE');
    expect(query.mock.calls[0][1]).toEqual(['project', ['deploy']]);
  });

  it('fetches the full allowed list only when requested tags are missing', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ tag: 'deploy' }] })
      .mockResolvedValueOnce({ rows: [{
        scope_kind: 'project', tag: 'deploy', description: '', created_by: null,
        is_system: true, created_at: new Date(0), updated_at: new Date(0),
      }] });

    const error = await validateTagsForScopeKind(
      { query } as never,
      'project',
      ['deploy', 'missing'],
      true,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject<ServiceError>({
      code: 'UNKNOWN_TAGS',
      details: { unknownTags: ['missing'], allowedTags: ['deploy'] },
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).not.toContain('FOR KEY SHARE');
  });

  it('does not query the vocabulary when no tags were requested', async () => {
    const query = vi.fn();
    await validateTagsForScopeKind({ query } as never, 'project', [], true);
    expect(query).not.toHaveBeenCalled();
  });
});
