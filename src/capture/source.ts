import { defaultCaptureRegistry } from './index.js';

export const captureSources = Object.freeze([
  ...defaultCaptureRegistry().ids(),
  'manual',
]);

const captureSourceSet: ReadonlySet<string> = new Set(captureSources);

export function isCaptureSource(source: string): boolean {
  return captureSourceSet.has(source);
}
