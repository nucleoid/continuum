import type { StandupMemory } from '../storage/standup.js';
import type { StandupResult } from '../services/standup.js';

function safe(value: string): string {
  return value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
      (char) => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`)
    .replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, '\\$1');
}

function group(memory: StandupMemory): string {
  if (memory.scope.startsWith('project:')) return memory.scope.slice('project:'.length);
  if (memory.source === 'terminal-summary') return 'Sessions';
  if (memory.source === 'deploy-event') return 'Deploys';
  if (memory.source === 'github-branch') return 'Branches';
  return memory.source;
}

function citation(memory: StandupMemory): string {
  const ref = memory.sourceRef ? `; ref ${safe(memory.sourceRef)}` : '';
  return `[source: ${safe(memory.source)}; memory ${safe(memory.id)}${ref}]`;
}

export function renderStandupMarkdown(result: StandupResult): string {
  const lines = [
    '# Standup digest',
    '',
    `Window: ${result.window.start.toISOString()} to ${result.window.end.toISOString()}`,
    '',
    '## Activity',
  ];
  if (result.activity.length === 0) lines.push('- No attributed activity found.');
  const groups = new Map<string, StandupMemory[]>();
  for (const memory of result.activity) {
    const key = group(memory);
    groups.set(key, [...(groups.get(key) ?? []), memory]);
  }
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`- **${safe(key)}**`);
    for (const memory of groups.get(key)!) {
      lines.push(`  - ${safe(memory.title)} ${citation(memory)}`);
    }
  }
  lines.push('', '## Open threads');
  if (result.openThreads.length === 0) lines.push('- No open threads found.');
  for (const memory of result.openThreads) {
    lines.push(`- ${safe(memory.title)} (${safe(memory.scope)}) ${citation(memory)}`);
  }
  if (result.page.nextOffset !== null) {
    lines.push('', `More activity is available at offset ${result.page.nextOffset}.`);
  }
  return `${lines.join('\n')}\n`;
}
