import { describe, expect, it } from 'vitest';
import { CaptureRegistry, UnknownPluginError } from './plugin.js';
import type { CapturePlugin } from './plugin.js';
import type { CaptureInput } from '../types.js';

const echoPlugin: CapturePlugin<{ title: string }> = {
  id: 'echo',
  transform(event): CaptureInput[] {
    return [
      {
        scope: { kind: 'org', name: '' },
        type: 'fact',
        title: event.title,
        body: event.title,
        source: 'echo',
      },
    ];
  },
};

describe('CaptureRegistry', () => {
  it('registers and resolves plugins by id', () => {
    const reg = new CaptureRegistry();
    reg.register(echoPlugin);
    expect(reg.get('echo')).toBe(echoPlugin);
    expect(reg.ids()).toEqual(['echo']);
  });

  it('runs a registered plugin and returns its CaptureInput[]', () => {
    const reg = new CaptureRegistry();
    reg.register(echoPlugin);
    const out = reg.run('echo', { title: 'hello' });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('hello');
    expect(out[0].source).toBe('echo');
  });

  it('throws UnknownPluginError for unregistered ids', () => {
    const reg = new CaptureRegistry();
    expect(() => reg.run('nope', {})).toThrow(UnknownPluginError);
  });

  it('lists ids alphabetically', () => {
    const reg = new CaptureRegistry();
    reg.register({ id: 'zeta', transform: () => [] });
    reg.register({ id: 'alpha', transform: () => [] });
    reg.register({ id: 'mu', transform: () => [] });
    expect(reg.ids()).toEqual(['alpha', 'mu', 'zeta']);
  });
});
