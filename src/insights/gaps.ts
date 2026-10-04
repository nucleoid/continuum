import type { GapReport } from '../services/gaps.js';
import { escapeAgentsMdData } from '../agents-md/render.js';

export interface GapConfig {
  threshold: number;
  candidateLimit: number;
  scanLimit: number;
  maxQueryChars: number;
  defaultLimit: number;
  maxLimit: number;
  defaultMinFrequency: number;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function gapConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GapConfig {
  const thresholdRaw = env.CONTINUUM_GAPS_SIMILARITY_THRESHOLD;
  const threshold = thresholdRaw === undefined ? 0.85 : Number(thresholdRaw);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('CONTINUUM_GAPS_SIMILARITY_THRESHOLD must be between 0 and 1');
  }
  const candidateLimit = integerEnv(env, 'CONTINUUM_GAPS_CANDIDATE_LIMIT', 500, 1, 2_000);
  const scanLimit = integerEnv(env, 'CONTINUUM_GAPS_SCAN_LIMIT', 5_000, candidateLimit, 50_000);
  const maxQueryChars = integerEnv(env, 'CONTINUUM_GAPS_MAX_QUERY_CHARS', 2_000, 1, 10_000);
  const maxLimit = integerEnv(env, 'CONTINUUM_GAPS_MAX_RESULTS', 100, 1, 100);
  const defaultLimit = integerEnv(env, 'CONTINUUM_GAPS_DEFAULT_RESULTS', 20, 1, maxLimit);
  const defaultMinFrequency = integerEnv(
    env, 'CONTINUUM_GAPS_MIN_FREQUENCY', 1, 1, candidateLimit,
  );
  return {
    threshold, candidateLimit, scanLimit, maxQueryChars,
    defaultLimit, maxLimit, defaultMinFrequency,
  };
}

function markdownText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu,
      (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+.!|>-])/g, '\\$1');
}

export function renderGapMarkdown(report: GapReport): string {
  const lines = [
    '# Continuum knowledge gaps',
    '',
    `Generated: ${report.generatedAt}`,
    `Window: ${report.window.days} days since ${report.window.since}`,
    `Semantic clustering: ${report.semanticClustering ? 'enabled' : 'disabled'}`,
    `Scope fidelity: ${report.scopeFidelity}`,
    `Candidates: ${report.candidateCount}${report.truncated ? ' (truncated)' : ''}`,
    '',
  ];
  if (report.gaps.length === 0) lines.push('No qualifying knowledge gaps found.', '');
  report.gaps.forEach((gap, index) => {
    lines.push(
      `## ${index + 1}. ${markdownText(gap.representative)}`,
      '',
      `- Score: ${gap.score}`,
      `- Frequency: ${gap.frequency}`,
      `- Distinct principals: ${gap.distinctPrincipals}`,
      `- First seen: ${gap.firstSeen}`,
      `- Last seen: ${gap.lastSeen}`,
      `- Resolution: ${gap.resolution.status} (scope fidelity: ${gap.resolution.scopeFidelity})`,
      '- Variants:',
      ...gap.variants.map((variant) => `  - ${markdownText(variant)}`),
      '- Capture input data:',
      '> [BEGIN CONTINUUM GAP CAPTURE DATA]',
      ...JSON.stringify(gap.capture, null, 2).split('\n')
        .map((line) => `> DATA: ${escapeAgentsMdData(line)}`),
      '> [END CONTINUUM GAP CAPTURE DATA]',
      '',
    );
  });
  return `${lines.join('\n').trimEnd()}\n`;
}
