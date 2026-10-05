import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type pg from 'pg';
import type { Principal } from '../types.js';
import { getPrincipalByExternalId } from '../storage/principals.js';
import { ServiceError } from '../services/errors.js';
import type { IngestPluginConfig } from './config.js';
import { isLifecyclePrincipal } from '../lifecycle/principal.js';
import type { Authenticator } from '../api/auth.js';

function equalSecret(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function unauthorized(): never {
  throw new ServiceError('INVALID_INPUT', 'Webhook authentication failed', { status: 401 });
}

async function configuredPrincipal(
  pool: pg.Pool,
  externalId: string,
): Promise<Principal> {
  const principal = await getPrincipalByExternalId(pool, externalId);
  if (!principal || principal.kind !== 'service' || isLifecyclePrincipal(principal)) unauthorized();
  return principal;
}

export async function authenticateIngest(
  pool: pg.Pool,
  req: Request,
  config: IngestPluginConfig,
  pluginId: string,
  authenticator?: Authenticator,
): Promise<Principal> {
  const auth = config.auth;
  if (auth.kind === 'github-hmac') {
    const signature = req.header('x-hub-signature-256') ?? '';
    if (!/^sha256=[0-9a-f]{64}$/i.test(signature) || !req.rawBody) unauthorized();
    const expected = `sha256=${createHmac('sha256', auth.secret).update(req.rawBody).digest('hex')}`;
    if (!equalSecret(signature.toLowerCase(), expected)) unauthorized();
    if (req.header('x-github-event') !== auth.event) {
      throw new ServiceError('INVALID_INPUT', 'Unexpected GitHub event');
    }
    return configuredPrincipal(pool, config.principalExternalId);
  }

  if (auth.kind === 'ado-basic') {
    const header = req.header('authorization') ?? '';
    const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    if (!match) unauthorized();
    let decoded: string;
    try {
      decoded = Buffer.from(match[1], 'base64').toString('utf8');
    } catch {
      unauthorized();
    }
    if (!equalSecret(decoded, `${auth.username}:${auth.password}`)) unauthorized();
    return configuredPrincipal(pool, config.principalExternalId);
  }

  const header = req.header('authorization') ?? '';
  const match = /^(Bearer|ApiKey)\s+([^\s]+)$/i.exec(header);
  if (!match) unauthorized();
  if (authenticator) {
    // Opaque principal IDs were the legacy bearer credential. Production
    // authentication accepts only a signed Entra JWT or a hashed ctm_ key.
    if (authenticator.mode === 'entra' && match[1].toLowerCase() === 'bearer'
      && !match[2].startsWith('ctm_') && !match[2].includes('.')) unauthorized();
    const authenticated = await authenticator.authenticate(match[1], match[2]);
    if (!authenticated || authenticated.principal.kind !== 'service'
      || isLifecyclePrincipal(authenticated.principal)) unauthorized();
    if (authenticated.principal.externalId !== config.principalExternalId) {
      throw new ServiceError('FORBIDDEN', 'Principal is not authorized for this plugin');
    }
    if (authenticated.allowedSource !== undefined && authenticated.allowedSource !== pluginId) {
      throw new ServiceError('FORBIDDEN', 'API key is not authorized for this plugin');
    }
    return authenticated.principal;
  }
  const principal = await getPrincipalByExternalId(pool, match[2].trim());
  if (!principal || principal.kind !== 'service' || isLifecyclePrincipal(principal)) unauthorized();
  if (principal.externalId !== config.principalExternalId) {
    throw new ServiceError('FORBIDDEN', 'Principal is not authorized for this plugin');
  }
  return principal;
}
