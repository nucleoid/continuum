import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// Source-only evaluation artifacts belong under the ignored task directory.
export async function preflightOutput(root, destination) {
  const directory = resolve(root, '.fire-off');
  const output = resolve(root, destination);
  const child = relative(directory, output);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !output.endsWith('.json')) throw new Error('Invalid report output');
  let current = directory;
  for (const part of ['', ...relative(directory, dirname(output)).split(sep).filter(Boolean)]) {
    current = resolve(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Invalid output directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const paths = [output, output.slice(0, -5) + '.md'];
  for (const path of paths) {
    try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Report output exists');
  }
  return paths;
}

export async function writeOutputPair(root, destination, json, markdown) {
  const paths = await preflightOutput(root, destination);
  await mkdir(dirname(paths[0]), { recursive: true });
  const owned = [];
  try {
    // Reserve both names exclusively before writing either payload.
    for (const path of paths) owned.push({ path, handle: await open(path, 'wx') });
    await owned[0].handle.writeFile(json);
    await owned[1].handle.writeFile(markdown);
    for (const entry of owned) await entry.handle.close();
  } catch (error) {
    for (const entry of owned) { await entry.handle.close().catch(() => {}); await unlink(entry.path).catch(() => {}); }
    throw error;
  }
  return paths;
}
