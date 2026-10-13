import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMcpHttpController } from './mcp-http.js';
import { mcpHttpConfigFromEnv } from './mcp-http-config.js';
const config = mcpHttpConfigFromEnv({ CONTINUUM_MCP_HTTP_ENABLED: 'true',
  CONTINUUM_MCP_PUBLIC_URL: 'http://localhost:4000/mcp', CONTINUUM_MCP_HTTP_LOOPBACK_DEV: 'true' }, 'dev')!;
describe('authenticated remote MCP boundary', () => {
  it('authenticates every method and never treats a session ID as authority', async () => {
    let checks = 0;
    const controller = createMcpHttpController(config, {
      pool: {} as never, embeddingProvider: null,
      authenticator: { mode: 'dev', authenticate: async () => { checks++; return null; } },
    });
    const app = express(); app.use('/mcp', controller.router);
    for (const method of ['post', 'get', 'delete'] as const) {
      const response = await request(app)[method]('/mcp').set('Host', 'localhost:4000')
        .set('Authorization', 'Bearer absent').set('Mcp-Session-Id', 'unknown');
      expect(response.status).toBe(401);
      expect(response.text).not.toContain('absent');
    }
    expect(checks).toBe(3);
    await controller.stop('test');
  });
});
