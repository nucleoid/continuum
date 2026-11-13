import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightOutput, writeOutputPair } from '../../scripts/evaluation-output.mjs';

it('rejects an occupied companion before writing JSON and confines reports to task artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-eval-output-'));
  try {
    await mkdir(join(root, '.fire-off'));
    await writeFile(join(root, '.fire-off/run.md'), 'prior report');
    await expect(preflightOutput(root, 'src/run.json')).rejects.toThrow(/output/i);
    await expect(writeOutputPair(root, '.fire-off/run.json', '{}', 'new report')).rejects.toThrow(/exists/i);
    expect(await readdir(join(root, '.fire-off'))).toEqual(['run.md']);
    expect(await readFile(join(root, '.fire-off/run.md'), 'utf8')).toBe('prior report');
    await writeOutputPair(root, '.fire-off/new/run.json', '{"ok":true}', 'report');
    expect(await readFile(join(root, '.fire-off/new/run.json'), 'utf8')).toBe('{"ok":true}');
    // A payload failure after reservations removes both files owned by this call.
    await expect(writeOutputPair(root, '.fire-off/failed.json', {} as string, 'report')).rejects.toThrow();
    expect((await readdir(join(root, '.fire-off'))).filter(name => name.startsWith('failed'))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
