import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './http.js';

export const DEFAULT_API_URL = 'http://127.0.0.1:4000';
export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CONFIG_BYTES = 64 * 1024;

export interface ConfigFlags {
  apiUrl?: string;
  token?: string;
  profile?: string;
  timeoutMs?: number;
}

export interface FileConfig {
  defaultProfile?: string;
  profiles?: Record<string, {
    apiUrl?: string;
    tokenEnv?: string;
    token?: unknown;
  }>;
}

export interface ResolvedConfig {
  apiUrl: string;
  token: string;
  timeoutMs: number;
  profile?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateFileConfig(value: unknown): FileConfig {
  if (!record(value)) throw new CliError('Config file must contain a JSON object', 2);
  if (Object.hasOwn(value, 'defaultProfile')
    && (typeof value.defaultProfile !== 'string' || !value.defaultProfile.trim())) {
    throw new CliError('Config defaultProfile must be a non-empty string', 2);
  }
  if (Object.hasOwn(value, 'profiles') && !record(value.profiles)) {
    throw new CliError('Config profiles must be an object', 2);
  }
  for (const [name, candidate] of Object.entries(value.profiles ?? {})) {
    if (!record(candidate)) throw new CliError(`Profile ${name} must be an object`, 2);
    if (Object.hasOwn(candidate, 'token')) {
      throw new CliError('Profile token values are forbidden; use tokenEnv', 2);
    }
    if (Object.hasOwn(candidate, 'apiUrl') && typeof candidate.apiUrl !== 'string') {
      throw new CliError(`Profile ${name} apiUrl must be a string`, 2);
    }
    if (Object.hasOwn(candidate, 'tokenEnv') && typeof candidate.tokenEnv !== 'string') {
      throw new CliError(`Profile ${name} tokenEnv must be a string`, 2);
    }
  }
  return value as FileConfig;
}

export function defaultConfigPath(): string {
  return join(homedir(), '.continuum', 'config.json');
}

export async function readConfigFile(
  path = defaultConfigPath(),
  required = false,
): Promise<FileConfig | null> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_CONFIG_BYTES) {
      throw new CliError('Config file exceeds 64 KiB', 2);
    }
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return validateFileConfig(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (required) throw new CliError('Config file does not exist', 2);
      return null;
    }
    if (error instanceof CliError) throw error;
    throw new CliError('Unable to read config file', 2);
  }
}

function cleanUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError('API URL is invalid', 2); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CliError('API URL must be HTTP(S) without credentials', 2);
  }
  return url.href.replace(/\/$/, '');
}

export function resolveConfig(
  flags: ConfigFlags,
  env: Record<string, string | undefined>,
  file: FileConfig | null,
): ResolvedConfig {
  const validated = file === null ? null : validateFileConfig(file);
  const profileName = flags.profile ?? validated?.defaultProfile;
  const profiles = validated?.profiles;
  const profile = profileName === undefined || profiles === undefined
    || !Object.hasOwn(profiles, profileName)
    ? undefined
    : profiles[profileName];
  if (profileName !== undefined && profile === undefined) {
    throw new CliError(`Unknown profile: ${profileName}`, 2);
  }
  if (profile !== undefined && (flags.apiUrl !== undefined || flags.token !== undefined)) {
    throw new CliError('A profile cannot be combined with --api-url or --token', 2);
  }
  if (profile !== undefined && (typeof profile.apiUrl !== 'string' || !profile.apiUrl.trim())) {
    throw new CliError(`Profile ${profileName} apiUrl is required`, 2);
  }
  if (profile !== undefined && (typeof profile.tokenEnv !== 'string' || !profile.tokenEnv.trim())) {
    throw new CliError(`Profile ${profileName} tokenEnv is required`, 2);
  }
  const tokenEnv = profile?.tokenEnv;
  if (tokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new CliError('Profile tokenEnv is invalid', 2);
  }
  const token = profile === undefined
    ? flags.token ?? env.CONTINUUM_TOKEN
    : env[tokenEnv!];
  if (!token?.trim()) throw new CliError('Continuum bearer token is required', 2);
  const timeoutMs = flags.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new CliError('Timeout must be between 1 and 120000 milliseconds', 2);
  }
  return {
    apiUrl: cleanUrl(profile === undefined
      ? flags.apiUrl ?? env.CONTINUUM_API_URL ?? DEFAULT_API_URL
      : profile.apiUrl!),
    token,
    timeoutMs,
    ...(profileName === undefined ? {} : { profile: profileName }),
  };
}
