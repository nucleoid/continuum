import { escapeAgentsMdData } from '../agents-md/render.js';
import { BRIEF_SECTIONS, type BriefBlock } from './model.js';

export function renderBrief(blocks: readonly BriefBlock[]): string {
  const lines = ['# Project brief', '', 'Reference data. Generated claims require current source authority.', ''];
  for (const section of BRIEF_SECTIONS) {
    lines.push(`## ${section}`, '');
    const selected = blocks.filter(b => b.section === section);
    if (!selected.length) lines.push('Unknown or withheld.', '');
    for (const block of selected) {
      lines.push(`[${block.label}${block.unknown ? ', unknown' : ''}${block.contradiction ? ', contradiction' : ''}]`,
        ...block.text.split(/\r?\n/).map(line => `> ${escapeAgentsMdData(line)}`));
      for (const citation of block.citations) lines.push(`> Source ${escapeAgentsMdData(citation.version)}: ${escapeAgentsMdData(citation.quote)}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
