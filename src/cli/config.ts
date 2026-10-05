import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './http.js';

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
  if (url.search || url.hash) {
    throw new CliError('API URL must not contain a query or fragment', 2);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = isIP(hostname);
  const loopback = hostname === 'localhost'
    || (ipVersion === 4 && hostname.startsWith('127.'))
    || (ipVersion === 6 && hostname === '::1');
  if (url.protocol !== 'https:' && !loopback) {
    throw new CliError('API URL must use HTTPS except for loopback hosts', 2);
  }
  return url.href.replace(/\/$/, '');
}

function cleanToken(value: string | undefined): string {
  if (!value?.trim()) throw new CliError('Continuum bearer token is required', 2);
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CliError('Continuum bearer token must not contain control characters', 2);
  }
  return value;
}

export function resolveConfig(
  flags: ConfigFlags,
  env: Record<string, string | undefined>,
  file: FileConfig | null,
): ResolvedConfig {
  const validated = file === null ? null : validateFileConfig(file);
  const hasFlagApiUrl = flags.apiUrl !== undefined;
  const hasFlagToken = flags.token !== undefined;
  const hasCredentialFlag = hasFlagApiUrl || hasFlagToken;
  if (flags.profile !== undefined && hasCredentialFlag) {
    throw new CliError('A profile cannot be combined with --api-url or --token', 2);
  }
  const profileName = flags.profile ?? (hasCredentialFlag ? undefined : validated?.defaultProfile);
  const profiles = validated?.profiles;
  const profile = profileName === undefined || profiles === undefined
    || !Object.hasOwn(profiles, profileName)
    ? undefined
    : profiles[profileName];
  if (profileName !== undefined && profile === undefined) {
    throw new CliError(`Unknown profile: ${profileName}`, 2);
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
  let apiUrl: string;
  let token: string;
  if (profile !== undefined) {
    apiUrl = profile.apiUrl!;
    token = cleanToken(env[tokenEnv!]);
  } else if (hasCredentialFlag) {
    if (!hasFlagApiUrl || !hasFlagToken) {
      throw new CliError('--api-url and --token must be provided together', 2);
    }
    apiUrl = flags.apiUrl!;
    token = cleanToken(flags.token);
  } else {
    const hasEnvApiUrl = env.CONTINUUM_API_URL !== undefined;
    const hasEnvToken = env.CONTINUUM_TOKEN !== undefined;
    if (hasEnvApiUrl !== hasEnvToken) {
      throw new CliError('CONTINUUM_API_URL and CONTINUUM_TOKEN must be provided together', 2);
    }
    if (!hasEnvApiUrl) throw new CliError('Continuum bearer token is required', 2);
    apiUrl = env.CONTINUUM_API_URL!;
    token = cleanToken(env.CONTINUUM_TOKEN);
  }
  const timeoutMs = flags.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new CliError('Timeout must be between 1 and 120000 milliseconds', 2);
  }
  return {
    apiUrl: cleanUrl(apiUrl),
    token,
    timeoutMs,
    ...(profileName === undefined ? {} : { profile: profileName }),
  };
}
