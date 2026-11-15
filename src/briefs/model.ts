import { createHash } from 'node:crypto';
import { z } from 'zod';
import { boundedJson } from '../pipeline/budget.js';

export const BRIEF_SCHEMA = 'project-brief-v1' as const;
export const BRIEF_PROMPT = 'brief-reference-v1' as const;
export const BRIEF_SECTIONS = ['purpose', 'decisions', 'implementation', 'unknowns', 'coverage'] as const;
export type BriefSection = typeof BRIEF_SECTIONS[number];
export interface BriefSource { id: string; version: string; family: string; kind: 'source-document-version' | 'extracted-assertion' | 'derived-observation'; text: string }
export interface BriefInput {
  schema: typeof BRIEF_SCHEMA; prompt: typeof BRIEF_PROMPT; sections: BriefSection[];
  referenceData: { trust: 'untrusted'; sources: BriefSource[] };
}
const claimSchema = z.object({ section: z.enum(BRIEF_SECTIONS), label: z.enum(['implemented_fact', 'recorded_intent', 'inference']),
  text: z.string().min(1).max(2000), unknown: z.boolean(), contradiction: z.boolean(),
  citations: z.array(z.object({ version: z.string().min(1).max(128), quote: z.string().min(1).max(1000) }).strict()).min(1).max(8) }).strict();
export type BriefClaim = z.infer<typeof claimSchema>;
export interface BriefOutput { claims: BriefClaim[] }
export interface BriefBlock extends BriefClaim { id: string }

/** Exact citations are necessary support, not a natural-language truth judge.
 * No repository audience proof is installed, so implemented_fact is unavailable. */
export function validateBriefOutput(value: unknown, input: BriefInput): BriefOutput {
  boundedJson(value, 65_536);
  const output = z.object({ claims: z.array(claimSchema).max(32) }).strict().parse(value);
  const seen = new Set<string>();
  for (const claim of output.claims) {
    if (!input.sections.includes(claim.section) || claim.label === 'implemented_fact'
      || (claim.section === 'implementation' && (claim.label !== 'inference' || !claim.unknown))) throw new TypeError('Unsupported brief claim');
    const versions = new Set<string>();
    for (const citation of claim.citations) {
      const source = input.referenceData.sources.find(s => s.version === citation.version);
      if (!source || !source.text.includes(citation.quote) || versions.has(citation.version)) throw new TypeError('Unsupported brief citation');
      versions.add(citation.version);
    }
    if (claim.contradiction && versions.size < 2) throw new TypeError('Unsupported brief contradiction');
    claim.citations.sort((a, b) => a.version.localeCompare(b.version));
    const key = JSON.stringify(claim);
    if (seen.has(key)) throw new TypeError('Duplicate brief claim');
    seen.add(key);
  }
  return output;
}
/** Previous prose is used only for byte-preserving reconciliation, never input. */
export function reconcileBlocks(output: BriefOutput, previous: readonly BriefBlock[], dirty: readonly BriefSection[]): BriefBlock[] {
  const blocks = previous.filter(b => !dirty.includes(b.section));
  for (const claim of output.claims) {
    if (!dirty.includes(claim.section)) throw new TypeError('Unexpected brief section');
    const id = createHash('sha256').update(JSON.stringify(claim)).digest('hex');
    blocks.push(previous.find(b => b.id === id) ?? { ...claim, id });
  }
  return blocks.sort((a, b) => BRIEF_SECTIONS.indexOf(a.section) - BRIEF_SECTIONS.indexOf(b.section) || a.id.localeCompare(b.id));
}
