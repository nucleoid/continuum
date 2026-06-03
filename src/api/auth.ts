import type pg from 'pg';
import type express from 'express';
import { getPrincipalByExternalId } from '../storage/principals.js';
import type { Principal } from '../types.js';

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

export function bearerAuth(pool: pg.Pool) {
  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      res.status(401).json({ error: 'missing or malformed bearer token' });
      return;
    }
    // v0 placeholder: token == external_id. Replaced by Entra SSO in M4.
    const token = match[1].trim();
    const principal = await getPrincipalByExternalId(pool, token);
    if (!principal) {
      res.status(401).json({ error: 'unknown principal' });
      return;
    }
    req.principal = principal;
    next();
  };
}
