import { describe, expect, it } from 'vitest';
import { defaultCaptureRegistry } from './index.js';

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
});
