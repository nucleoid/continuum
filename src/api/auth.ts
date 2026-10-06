import { createHash } from 'node:crypto';
import type pg from 'pg';
import type express from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
  getPrincipalByExternalId, PrincipalKindConflictError, upsertPrincipalByExternalId,
} from '../storage/principals.js';
import type { AuthenticatedPrincipal, Principal, PrincipalKind } from '../types.js';
import { isLifecyclePrincipal } from '../lifecycle/principal.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
    authContext?: AuthenticatedPrincipal;
  }
}

export type AuthMode = 'dev' | 'entra';
export interface EntraAuthConfig {
  tenant: string;
  audience: string;
  userScope: string;
  serviceAppRole: string;
  allowedClientIds: readonly string[];
  discoveryTimeoutMs?: number;
  jwksTimeoutMs?: number;
  fetcher?: typeof globalThis.fetch;
}
export interface Authenticator {
  readonly mode: AuthMode;
  authenticate(scheme: string, credential: string): Promise<AuthenticatedPrincipal | null>;
}

export function authModeFromEnv(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const mode = env.CONTINUUM_AUTH_MODE;
  if (mode !== 'dev' && mode !== 'entra') {
    throw new Error('CONTINUUM_AUTH_MODE must be explicitly set to dev or entra');
  }
  return mode;
}

export function warnOnDevAuthMode(
  mode: AuthMode,
  write: (message: string) => unknown = (message) => process.stderr.write(message),
): void {
  if (mode === 'dev') {
    write('continuum: WARNING: dev authentication accepts principal IDs as bearer credentials; never expose this process to an untrusted network\n');
  }
}

export function entraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EntraAuthConfig {
  const tenant = env.CONTINUUM_ENTRA_TENANT?.trim().toLowerCase() ?? '';
  const audience = env.CONTINUUM_ENTRA_AUDIENCE?.trim() ?? '';
  const userScope = env.CONTINUUM_ENTRA_USER_SCOPE?.trim() ?? '';
  const serviceAppRole = env.CONTINUUM_ENTRA_SERVICE_APP_ROLE?.trim() ?? '';
  const allowedClientIds = (env.CONTINUUM_ENTRA_ALLOWED_CLIENT_IDS ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tenant)
    || audience.length === 0 || audience.length > 256
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(userScope)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(serviceAppRole)
    || allowedClientIds.length === 0
    || allowedClientIds.some((value) => !UUID.test(value))) {
    throw new Error('Entra mode requires tenant, audience, user scope, service app role, and allowed client IDs');
  }
  return { tenant, audience, userScope, serviceAppRole, allowedClientIds: [...new Set(allowedClientIds)] };
}

async function authenticateApiKey(
  pool: pg.Pool,
  credential: string,
): Promise<AuthenticatedPrincipal | null> {
  if (!/^ctm_[A-Za-z0-9_-]{43}$/.test(credential)) return null;
  const hash = createHash('sha256').update(credential, 'utf8').digest();
  const { rows } = await pool.query(
    `SELECT p.id, p.external_id, p.kind, p.display_name, p.created_at, k.allowed_source
       , COALESCE(k.rotated_at, k.created_at) + interval '90 days' AS expires_at
       FROM service_api_keys k JOIN principals p ON p.id = k.principal_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL
        AND p.disabled_at IS NULL
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
    expiresAt: row.expires_at,
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
      mode,
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
      const response = await (entra.fetcher ?? globalThis.fetch)(discoveryUrl, {
        signal: AbortSignal.timeout(entra.discoveryTimeoutMs ?? 5_000),
      });
      if (!response.ok) throw new Error('Entra discovery failed');
      const value = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
      if (value.issuer !== expectedIssuer || typeof value.jwks_uri !== 'string') {
        throw new Error('Entra discovery metadata is invalid');
      }
      const jwksUrl = new URL(value.jwks_uri);
      if (jwksUrl.protocol !== 'https:' || jwksUrl.hostname !== 'login.microsoftonline.com'
        || !jwksUrl.pathname.toLowerCase().startsWith(`/${entra.tenant.toLowerCase()}/`)) {
        throw new Error('Entra JWKS URL is invalid');
      }
      return {
        issuer: value.issuer,
        jwks: createRemoteJWKSet(jwksUrl, { timeoutDuration: entra.jwksTimeoutMs ?? 5_000 }),
      };
    })();
    metadataPromise.catch(() => { metadataPromise = undefined; });
    return metadataPromise;
  };
  return {
    mode,
    async authenticate(scheme, credential) {
      if (scheme.toLowerCase() === 'apikey'
        || (scheme.toLowerCase() === 'bearer' && credential.startsWith('ctm_'))) {
        return authenticateApiKey(pool, credential);
      }
      if (scheme.toLowerCase() !== 'bearer') return null;
      try {
        const resolved = await metadata();
        const { payload, protectedHeader } = await jwtVerify(credential, resolved.jwks, {
          issuer: resolved.issuer,
          audience: entra.audience,
          algorithms: ['RS256'],
          requiredClaims: ['exp', 'iat', 'iss', 'aud', 'tid', 'oid'],
        });
        if (protectedHeader.alg !== 'RS256'
          || (protectedHeader.typ !== undefined && protectedHeader.typ !== 'JWT'
            && protectedHeader.typ !== 'at+jwt')) return null;
        return principalFromClaims(pool, payload, entra);
      } catch {
        return null;
      }
    },
  };
}

export async function principalFromClaims(
  pool: pg.Pool,
  claims: JWTPayload,
  contract: Pick<EntraAuthConfig, 'tenant' | 'userScope' | 'serviceAppRole' | 'allowedClientIds'>,
): Promise<AuthenticatedPrincipal | null> {
  const oid = typeof claims.oid === 'string' ? claims.oid.toLowerCase() : '';
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(oid)) return null;
  const name = typeof claims.name === 'string' ? claims.name.trim().slice(0, 256) : '';
  const clientId = typeof claims.azp === 'string' ? claims.azp
    : typeof claims.appid === 'string' ? claims.appid : '';
  let kind: PrincipalKind;
  if (claims.tid !== contract.tenant || claims.ver !== '2.0'
    || !UUID.test(clientId)
    || !contract.allowedClientIds.some((allowed) => allowed.toLowerCase() === clientId.toLowerCase())) {
    return null;
  }
  if (claims.idtyp === 'user') {
    const scopes = typeof claims.scp === 'string' ? claims.scp.split(/\s+/) : [];
    if (!scopes.includes(contract.userScope)
      || (claims.acct !== undefined && claims.acct !== 0 && claims.acct !== 1)) return null;
    kind = 'user';
  } else if (claims.idtyp === 'app') {
    const roles = Array.isArray(claims.roles)
      ? claims.roles.filter((value): value is string => typeof value === 'string') : [];
    if (typeof claims.scp === 'string' || !roles.includes(contract.serviceAppRole)
      || !UUID.test(clientId)) return null;
    kind = 'service';
  } else return null;
  const existing = await getPrincipalByExternalId(pool, oid);
  if (existing && existing.kind !== kind) return null;
  if (!existing) return null;
  let principal: Principal;
  if (kind === 'user') {
    if (!existing) return null;
    const membership = await pool.query(
      `SELECT 1 FROM scope_memberships
        WHERE principal_id = $1 AND active
          AND continuum_membership_is_effective(active, source_kind)
        LIMIT 1`,
      [existing.id],
    );
    if (!membership.rowCount) return null;
    principal = existing;
  } else principal = existing;
  if (principal.displayName !== (name || oid)) {
    try {
      principal = await upsertPrincipalByExternalId(pool, {
        externalId: oid, kind, displayName: name || oid,
      });
    } catch (error) {
      if (error instanceof PrincipalKindConflictError) return null;
      throw error;
    }
  }
  return {
    principal,
    credential: 'entra',
    ...(typeof claims.exp === 'number' ? { expiresAt: new Date(claims.exp * 1000) } : {}),
  };
}

export function bearerAuth(pool: pg.Pool, authenticator?: Authenticator) {
  const selected = authenticator
    ?? (process.env.NODE_ENV === 'test' ? createAuthenticator(pool, 'dev') : undefined);
  if (!selected) throw new Error('an explicit authenticator is required');
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
      next(error);
    }
  };
}
