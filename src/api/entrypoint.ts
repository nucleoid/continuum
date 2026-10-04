import { pathToFileURL } from 'node:url';

export function isDirectEntrypoint(
  importMetaUrl: string,
  argvPath: string | undefined = process.argv[1],
): boolean {
  return Boolean(argvPath) && importMetaUrl === pathToFileURL(argvPath).href;
}
