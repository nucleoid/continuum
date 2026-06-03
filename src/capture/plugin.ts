import type { CaptureInput } from '../types.js';

export interface CaptureContext {
  defaultProjectName?: string;
  resolveUserScope?: (externalActor: string) => string | null;
  now?: () => Date;
}

export interface CapturePlugin<TEvent = unknown> {
  readonly id: string;
  transform(event: TEvent, ctx?: CaptureContext): CaptureInput[];
}

export class UnknownPluginError extends Error {
  constructor(id: string) {
    super(`unknown capture plugin: ${id}`);
    this.name = 'UnknownPluginError';
  }
}

export class CaptureRegistry {
  private plugins = new Map<string, CapturePlugin>();

  register(plugin: CapturePlugin): void {
    this.plugins.set(plugin.id, plugin);
  }

  get(id: string): CapturePlugin | undefined {
    return this.plugins.get(id);
  }

  ids(): string[] {
    return [...this.plugins.keys()].sort();
  }

  run(id: string, event: unknown, ctx: CaptureContext = {}): CaptureInput[] {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new UnknownPluginError(id);
    return plugin.transform(event, ctx);
  }
}
