import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server } from 'node:http';

const entrypointMocks = vi.hoisted(() => ({
  isDirectEntrypoint: vi.fn(() => false),
  stdioTransportConstructed: vi.fn(),
}));

vi.mock('./entrypoint.js', () => ({
  isDirectEntrypoint: entrypointMocks.isDirectEntrypoint,
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      entrypointMocks.stdioTransportConstructed();
    }
  },
}));

describe('production entrypoint callers', () => {
  beforeEach(() => {
    vi.resetModules();
    entrypointMocks.isDirectEntrypoint.mockClear();
    entrypointMocks.stdioTransportConstructed.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('server delegates its production guard to the shared helper and is import-inert', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen');

    await import('./server.js');

    expect(entrypointMocks.isDirectEntrypoint).toHaveBeenCalledOnce();
    expect(entrypointMocks.isDirectEntrypoint).toHaveBeenCalledWith(
      expect.stringMatching(/\/server\.(?:ts|js)$/),
    );
    expect(listen).not.toHaveBeenCalled();
  });

  it('mcp delegates its production guard to the shared helper and is import-inert', async () => {
    await import('./mcp.js');

    expect(entrypointMocks.isDirectEntrypoint).toHaveBeenCalledOnce();
    expect(entrypointMocks.isDirectEntrypoint).toHaveBeenCalledWith(
      expect.stringMatching(/\/mcp\.(?:ts|js)$/),
    );
    expect(entrypointMocks.stdioTransportConstructed).not.toHaveBeenCalled();
  });
});
