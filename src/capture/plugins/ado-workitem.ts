import type { CaptureInput, MemoryType } from '../../types.js';
import type { CapturePlugin, CaptureContext } from '../plugin.js';

export interface AdoWorkItemEvent {
  id: number;
  fields: {
    'System.Title': string;
    'System.Description'?: string;
    'System.State': string;
    'System.WorkItemType': string;
    'System.AreaPath'?: string;
    'System.Tags'?: string;
    'System.AssignedTo'?: { uniqueName?: string; displayName?: string } | string;
  };
  _links?: { html?: { href?: string } };
  comments?: Array<{ text: string; createdBy?: { displayName?: string }; createdDate?: string }>;
}

function projectFromAreaPath(areaPath: string | undefined, fallback: string): string {
  if (!areaPath) return fallback;
  const slash = areaPath.indexOf('\\');
  return slash === -1 ? areaPath : areaPath.slice(0, slash);
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean);
}

export const adoWorkItemPlugin: CapturePlugin<AdoWorkItemEvent> = {
  id: 'ado-workitem',

  transform(event, ctx: CaptureContext = {}): CaptureInput[] {
    const f = event.fields;
    const adoTags = parseTags(f['System.Tags']);
    const isDecision = adoTags.some((t) => t.toLowerCase() === 'decision');
    const type: MemoryType = isDecision ? 'decision' : 'context';

    const project =
      ctx.defaultProjectName ?? projectFromAreaPath(f['System.AreaPath'], 'unknown');

    const lines: string[] = [];
    if (f['System.Description']) lines.push(stripHtml(f['System.Description']).trim());
    lines.push('');
    lines.push(`State: ${f['System.State']}`);
    lines.push(`Type: ${f['System.WorkItemType']}`);
    if (f['System.AssignedTo']) {
      const assignee =
        typeof f['System.AssignedTo'] === 'string'
          ? f['System.AssignedTo']
          : f['System.AssignedTo'].displayName ?? f['System.AssignedTo'].uniqueName ?? 'unknown';
      lines.push(`Assigned: ${assignee}`);
    }
    if (event.comments && event.comments.length > 0) {
      const latest = event.comments[event.comments.length - 1];
      lines.push('');
      lines.push(`Latest comment (${latest.createdBy?.displayName ?? 'unknown'}):`);
      lines.push(stripHtml(latest.text).trim());
    }

    return [
      {
        scope: { kind: 'project', name: project },
        type,
        title: `${f['System.WorkItemType']} ${event.id}: ${f['System.Title']}`,
        body: lines.join('\n').trim(),
        tags: isDecision ? ['ado', 'decision'] : ['ado'],
        source: 'ado-workitem',
        sourceRef: event._links?.html?.href ?? undefined,
        metadata: {
          id: event.id,
          state: f['System.State'],
          type: f['System.WorkItemType'],
          areaPath: f['System.AreaPath'] ?? null,
          adoTags,
        },
      },
    ];
  },
};

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>(?:\s*)/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
