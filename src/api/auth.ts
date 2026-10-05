import { createHash } from 'node:crypto';
import type pg from 'pg';
import type express from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { getPrincipalByExternalId, upsertPrincipalByExternalId } from '../storage/principals.js';
import type { AuthenticatedPrincipal, Principal, PrincipalKind } from '../types.js';
import { isLifecyclePrincipal } from '../lifecycle/principal.js';

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
    authContext?: AuthenticatedPrincipal;
  }
}

export type AuthMode = 'dev' | 'entra';
export interface EntraAuthConfig { tenant: string; audience: string }
export interface Authenticator {
  authenticate(scheme: string, credential: string): Promise<AuthenticatedPrincipal | null>;
}

export function authModeFromEnv(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const mode = env.CONTINUUM_AUTH_MODE;
  if (mode !== 'dev' && mode !== 'entra') {
    throw new Error('CONTINUUM_AUTH_MODE must be explicitly set to dev or entra');
  }
  return mode;
}

export function entraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EntraAuthConfig {
  const tenant = env.CONTINUUM_ENTRA_TENANT?.trim() ?? '';
  const audience = env.CONTINUUM_ENTRA_AUDIENCE?.trim() ?? '';
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tenant)
    || audience.length === 0 || audience.length > 256) {
    throw new Error('Entra mode requires a tenant UUID and bounded audience');
  }
  return { tenant, audience };
}

async function authenticateApiKey(
  pool: pg.Pool,
  credential: string,
): Promise<AuthenticatedPrincipal | null> {
  if (!/^ctm_[A-Za-z0-9_-]{43}$/.test(credential)) return null;
  const hash = createHash('sha256').update(credential, 'utf8').digest();
  const { rows } = await pool.query(
    `SELECT p.id, p.external_id, p.kind, p.display_name, p.created_at, k.allowed_source
       FROM service_api_keys k JOIN principals p ON p.id = k.principal_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL
        AND COALESCE(k.rotated_at, k.created_at) > now() - interval '90 days'`,
    [hash],
  );
  const row = rows[0];
  if (!row || row.kind !== 'service') return null;
  return {
    principal: {
      id: row.id, externalId: row.external_id, kind: row.kind,
      displayName: row.display_name, createdAt: row.created_at,
    },
    credential: 'api-key',
    ...(row.allowed_source ? { allowedSource: row.allowed_source } : {}),
  };
}

export function createAuthenticator(
  pool: pg.Pool,
  mode: AuthMode,
  entra?: EntraAuthConfig,
): Authenticator {
  if (mode === 'dev') {
    return {
      async authenticate(scheme, credential) {
        if (scheme.toLowerCase() !== 'bearer') return null;
        const principal = await getPrincipalByExternalId(pool, credential);
        return principal ? { principal, credential: 'dev' } : null;
      },
    };
  }
  if (!entra) throw new Error('Entra auth configuration is required');
  const expectedIssuer = `https://login.microsoftonline.com/${entra.tenant}/v2.0`;
  let metadataPromise: Promise<{ issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> }> | undefined;
  const metadata = () => {
    metadataPromise ??= (async () => {
      const discoveryUrl = new URL(`${expectedIssuer}/.well-known/openid-configuration`);
      const response = await fetch(discoveryUrl);
      if (!response.ok) throw new Error('Entra discovery failed');
      const value = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
      if (value.issuer !== expectedIssuer || typeof value.jwks_uri !== 'string') {
        throw new Error('Entra discovery metadata is invalid');
      }
      const jwksUrl = new URL(value.jwks_uri);
      if (jwksUrl.protocol !== 'https:' || jwksUrl.hostname !== 'login.microsoftonline.com') {
        throw new Error('Entra JWKS URL is invalid');
      }
      return { issuer: value.issuer, jwks: createRemoteJWKSet(jwksUrl) };
    })();
    return metadataPromise;
  };
  return {
    async authenticate(scheme, credential) {
      if (scheme.toLowerCase() === 'apikey'
        || (scheme.toLowerCase() === 'bearer' && credential.startsWith('ctm_'))) {
        return authenticateApiKey(pool, credential);
      }
      if (scheme.toLowerCase() !== 'bearer') return null;
      const resolved = await metadata();
      const { payload } = await jwtVerify(credential, resolved.jwks, {
        issuer: resolved.issuer, audience: entra.audience,
      });
      return principalFromClaims(pool, payload);
    },
  };
}

export async function principalFromClaims(
  pool: pg.Pool,
  claims: JWTPayload,
): Promise<AuthenticatedPrincipal | null> {
  const oid = typeof claims.oid === 'string' ? claims.oid : '';
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(oid)) return null;
  const name = typeof claims.name === 'string' ? claims.name.trim().slice(0, 256) : '';
  const kind: PrincipalKind = claims.idtyp === 'app'
    || (typeof claims.scp !== 'string'
      && (typeof claims.azp === 'string' || typeof claims.appid === 'string'))
    ? 'service' : 'user';
  const principal = await upsertPrincipalByExternalId(pool, {
    externalId: oid, kind, displayName: name || oid,
  });
  return { principal, credential: 'entra' };
}

export function bearerAuth(pool: pg.Pool, authenticator?: Authenticator) {
  const selected = authenticator ?? createAuthenticator(pool, 'dev');
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const header = req.header('authorization') ?? '';
    const match = /^(Bearer|ApiKey)\s+([^\s]+)$/i.exec(header);
    if (!match) {
      res.status(401).json({ error: 'missing or malformed bearer token' });
      return;
    }
    try {
      const result = await selected.authenticate(match[1], match[2]);
      if (!result || isLifecyclePrincipal(result.principal)) {
        res.status(401).json({ error: 'invalid credential' });
        return;
      }
      req.principal = result.principal;
      req.authContext = result;
      next();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (typeof code === 'string' && /^(ERR_JWT|ERR_JWS|ERR_JOSE)/.test(code)) {
        res.status(401).json({ error: 'invalid credential' });
        return;
      }
      next(error);
    }
  };
}
