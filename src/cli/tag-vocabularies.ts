#!/usr/bin/env node
import { isDirectEntrypoint } from '../api/entrypoint.js';

type Fetch = typeof fetch;

export interface TagVocabularyCliOptions {
  fetch?: Fetch;
  apiUrl?: string;
  token?: string;
  stdout?: (text: string) => void;
}

const USAGE = 'Usage: continuum-tags <list|add|update|remove> <scope-kind> [tag] [description]';
const SCOPE_KINDS = new Set(['org', 'team', 'project', 'user', 'role']);

export async function runTagVocabularyCli(
  args: readonly string[],
  options: TagVocabularyCliOptions = {},
): Promise<void> {
  const [command, scopeKind, tag, description, ...extra] = args;
  if (!['list', 'add', 'update', 'remove'].includes(command ?? '')
    || !SCOPE_KINDS.has(scopeKind ?? '')
    || extra.length > 0
    || (command === 'list' && (tag !== undefined || description !== undefined))
    || (command === 'add' && tag === undefined)
    || (command === 'update' && (tag === undefined || description === undefined))
    || (command === 'remove' && (tag === undefined || description !== undefined))) {
    throw new Error(USAGE);
  }

  const token = options.token ?? process.env.CONTINUUM_BEARER;
  if (!token) throw new Error('CONTINUUM_BEARER is required');
  const base = new URL(options.apiUrl ?? process.env.CONTINUUM_API_URL ?? 'http://localhost:4000');
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('CONTINUUM_API_URL must use http or https');
  }
  const root = base.href.replace(/\/$/, '');
  let url = `${root}/api/v0/tag-vocabularies`;
  let method = 'GET';
  let body: Record<string, string> | undefined;

  if (command === 'list') {
    url += `?scopeKind=${encodeURIComponent(scopeKind!)}`;
  } else if (command === 'add') {
    method = 'POST';
    body = { scopeKind: scopeKind!, tag: tag! };
    if (description !== undefined) body.description = description;
  } else {
    url += `/${encodeURIComponent(scopeKind!)}/${encodeURIComponent(tag!)}`;
    if (command === 'update') {
      method = 'PATCH';
      body = { description: description! };
    } else {
      method = 'DELETE';
    }
  }

  const response = await (options.fetch ?? fetch)(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = `Continuum API returned HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (typeof parsed.error === 'string') {
        const safe = parsed.error.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);
        message += `: ${safe}`;
      }
    } catch {
      // Keep the bounded status-only message for non-JSON failures.
    }
    throw new Error(message);
  }
  (options.stdout ?? ((value) => process.stdout.write(value)))(
    text ? `${text}\n` : 'OK\n',
  );
}

if (isDirectEntrypoint(import.meta.url)) {
  void runTagVocabularyCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`continuum-tags: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
