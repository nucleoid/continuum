import { describe, expect, it } from 'vitest';
import { defaultCaptureRegistry } from './index.js';
import { captureSources, isCaptureSource } from './source.js';

describe('defaultCaptureRegistry', () => {
  it('registers all five v0 capture plugins', () => {
    const reg = defaultCaptureRegistry();
    expect(reg.ids()).toEqual([
      'ado-workitem',
      'deploy-event',
      'github-branch',
      'github-pr',
      'terminal-summary',
    ]);
  });

  it('derives valid capture sources from the default registry plus manual', () => {
    expect(captureSources).toEqual([
      'ado-workitem',
      'deploy-event',
      'github-branch',
      'github-pr',
      'terminal-summary',
      'manual',
    ]);
    for (const source of captureSources) expect(isCaptureSource(source)).toBe(true);
    expect(isCaptureSource('')).toBe(false);
    expect(isCaptureSource('unregistered-plugin')).toBe(false);
  });
});
