import { z } from 'zod';
import { boundedJson } from '../pipeline/budget.js';
import type { ExtractionChunk } from './chunking.js';

export const EXTRACTION_SCHEMA = 'extraction-v1';
export const EXTRACTION_PROMPT = 'source-reference-v1';
const checkedText = (max: number) => z.string().min(1).max(max)
  .refine(value => !value.includes('\u0000') && value === Buffer.from(value, 'utf8').toString('utf8'), 'Invalid extraction text');
export const assertionSchema = z.object({
  text: checkedText(4000),
  type: z.enum(['fact', 'intent', 'decision', 'unknown']),
  unknown: z.boolean(),
  unsupported: z.array(checkedText(100)).max(16),
  temporal: z.object({ value: checkedText(100).nullable(), uncertain: z.boolean() }).strict(),
  citations: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(),
    quote: checkedText(8192) }).strict()).min(1).max(8),
}).strict();
export const assertionOutputSchema = z.object({ assertions: z.array(assertionSchema).max(16) }).strict();
export type ExtractionOutput = z.infer<typeof assertionOutputSchema>;
export type ExtractionAssertion = z.infer<typeof assertionSchema>;
export function validateAssertions(value: unknown, chunk: ExtractionChunk): ExtractionOutput {
  // Reject executable/oversized shapes before a schema library traverses them.
  const output = assertionOutputSchema.parse(JSON.parse(boundedJson(value, 65_536)));
  const bytes = Buffer.from(chunk.text, 'utf8');
  for (const assertion of output.assertions) for (const span of assertion.citations) {
    const start = span.start - chunk.start, end = span.end - chunk.start;
    if (start < 0 || end > bytes.length || end <= start
      || (start < bytes.length && (bytes[start] & 0xc0) === 0x80)
      || (end < bytes.length && (bytes[end] & 0xc0) === 0x80)
      || !bytes.subarray(start, end).equals(Buffer.from(span.quote, 'utf8'))) throw new TypeError('Invalid extraction citation');
  }
  return output;
}

export type ExtractionState = 'queued' | 'running' | 'complete' | 'partial' | 'skipped' | 'unavailable' | 'cancelled';
export interface ExtractionStatus {
  status: ExtractionState | 'not-configured';
  runId?: string; sourceVersion?: string | null; profile?: string; generation?: number;
  chunks?: number; completed?: number; skipped?: number; assertions?: number;
  reason?: string | null;
}
