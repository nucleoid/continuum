import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export function extractRuntimePackage(archive, destination, tar = 'tar') {
 const target = resolve(destination);
 if (!statSync(target).isDirectory()) throw new Error('Package inspection target must be an owned directory');
 const args = ['--force-local', '-tf', resolve(archive), 'opt/continuum'];
 const entries = execFileSync(tar, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
  .trim().split('\n');
 if (!entries.length || entries.some(path => path.startsWith('/') || path.split('/').includes('..')
  || !path.startsWith('opt/continuum/'))) throw new Error('Unsafe exported runtime package path');
 // Directory write permissions are restored after descendants have been read.
 // This affects only the inspection copy, never the image or serving package.
 execFileSync(tar, ['--force-local', '-xf', resolve(archive), '-C', target,
  '--strip-components=2', '--delay-directory-restore', '--no-same-owner', '--no-same-permissions',
  'opt/continuum'], { timeout: 120000, maxBuffer: 1024 * 1024 });
}
