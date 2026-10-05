import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('controlled-tag mixed-version operations', () => {
  it('documents a pause, drain, migrate, compatible deploy, and idempotent replay sequence', async () => {
    const documentation = await readFile(
      join(process.cwd(), 'docs/tag-vocabularies.md'),
      'utf8',
    );

    const orderedSteps = [
      /pause webhook intake/i,
      /drain in-flight/i,
      /continuum-migrate/i,
      /deploy the vocabulary-aware application/i,
      /resume webhook intake/i,
      /replay[\s\S]+original delivery identit/i,
    ];
    let previous = -1;
    for (const step of orderedSteps) {
      const match = step.exec(documentation.slice(previous + 1));
      expect(match, `missing rollout step ${step}`).not.toBeNull();
      previous += 1 + match!.index;
    }
    expect(documentation).toMatch(/replay(?:ed|ing)?[\s\S]+idempotent/i);
  });

  it('ships an exact pre-rollback trigger procedure for legacy ADO and deploy writers', async () => {
    const procedure = await readFile(
      join(process.cwd(), 'scripts/enable-tag-legacy-writer-compat.sql'),
      'utf8',
    );
    const documentation = await readFile(
      join(process.cwd(), 'docs/tag-vocabularies.md'),
      'utf8',
    );

    expect(procedure).toContain('CREATE OR REPLACE FUNCTION enforce_memory_tag_vocabulary()');
    expect(procedure).toMatch(/NEW\.source\s+IN\s+\('ado-workitem',\s*'deploy-event'\)/i);
    expect(procedure).toContain('continuum_legacy_tags');
    expect(procedure).toContain('FOR KEY SHARE');
    expect(documentation).toContain('scripts/enable-tag-legacy-writer-compat.sql');
    expect(documentation).toMatch(/pause webhook intake[\s\S]+drain in-flight[\s\S]+application rollback/i);
  });
});
