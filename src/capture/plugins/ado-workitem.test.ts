import { describe, expect, it } from 'vitest';
import { adoWorkItemPlugin, type AdoWorkItemEvent } from './ado-workitem.js';

function workItem(overrides: Partial<AdoWorkItemEvent['fields']> = {}, extras: Partial<AdoWorkItemEvent> = {}): AdoWorkItemEvent {
  return {
    id: 88231,
    fields: {
      'System.Title': 'Pin Node 22 in COApi build',
      'System.Description': '<p>The COApi build is failing on Node 23.</p>',
      'System.State': 'Closed',
      'System.WorkItemType': 'Bug',
      'System.AreaPath': 'booking-engine\\platform',
      'System.AssignedTo': { displayName: 'Cass ExampleOrg', uniqueName: 'user@example.com' },
      ...overrides,
    },
    _links: { html: { href: 'https://dev.azure.com/exampleorg/_workitems/edit/88231' } },
    ...extras,
  };
}

describe('ado-workitem plugin', () => {
  it('emits a project-scoped context memory from a standard bug', () => {
    const out = adoWorkItemPlugin.transform(workItem());
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.scope).toEqual({ kind: 'project', name: 'booking-engine' });
    expect(m.type).toBe('context');
    expect(m.title).toBe('Bug 88231: Pin Node 22 in COApi build');
    expect(m.source).toBe('ado-workitem');
    expect(m.sourceRef).toBe('https://dev.azure.com/exampleorg/_workitems/edit/88231');
  });

  it('strips HTML from description and includes assignee + state', () => {
    const out = adoWorkItemPlugin.transform(workItem());
    expect(out[0].body).toContain('The COApi build is failing on Node 23.');
    expect(out[0].body).not.toContain('<p>');
    expect(out[0].body).toContain('State: Closed');
    expect(out[0].body).toContain('Assigned: Cass ExampleOrg');
  });

  it('upgrades type to decision when "decision" tag is present', () => {
    const ev = workItem({ 'System.Tags': 'release; Decision; reviewed' });
    const out = adoWorkItemPlugin.transform(ev);
    expect(out[0].type).toBe('decision');
    expect(out[0].tags).toEqual(['ado', 'decision']);
    expect(out[0].metadata).toMatchObject({
      state: 'Closed',
      adoTags: ['release', 'Decision', 'reviewed'],
    });
  });

  it('includes the latest comment when comments are supplied', () => {
    const out = adoWorkItemPlugin.transform(
      workItem({}, {
        comments: [
          { text: 'Initial triage.', createdBy: { displayName: 'Security Reviewer' } },
          { text: 'Confirmed by deploy on PROD.', createdBy: { displayName: 'Mitch' } },
        ],
      }),
    );
    expect(out[0].body).toContain('Latest comment (Mitch):');
    expect(out[0].body).toContain('Confirmed by deploy on PROD.');
    expect(out[0].body).not.toContain('Initial triage.');
  });

  it('decodes description entities once after removing real HTML tags', () => {
    const out = adoWorkItemPlugin.transform(
      workItem({
        'System.Description':
          '<p>Use List&amp;lt;T&amp;gt; here</p><p>Single: List&lt;T&gt;<br>Real <strong>tag</strong>; encoded: &lt;strong&gt;text&lt;/strong&gt;&nbsp;&amp;</p>',
      }),
    );

    expect(out[0].body).toContain(
      'Use List&lt;T&gt; here\nSingle: List<T>\nReal tag; encoded: <strong>text</strong> &',
    );
    expect(out[0].body).not.toContain('<p>');
    expect(out[0].body).not.toContain('<strong>tag</strong>');
  });

  it('decodes latest-comment entities once while preserving line breaks', () => {
    const out = adoWorkItemPlugin.transform(
      workItem({}, {
        comments: [
          {
            text:
              '<p>Use List&amp;lt;T&amp;gt; here</p><p>Single: List&lt;T&gt;<br>Real <em>tag</em>; encoded: &lt;em&gt;text&lt;/em&gt;&nbsp;&amp;</p>',
            createdBy: { displayName: 'Mitch' },
          },
        ],
      }),
    );

    expect(out[0].body).toContain(
      'Latest comment (Mitch):\nUse List&lt;T&gt; here\nSingle: List<T>\nReal tag; encoded: <em>text</em> &',
    );
    expect(out[0].body).not.toContain('<p>');
    expect(out[0].body).not.toContain('<em>tag</em>');
  });

  it('falls back to defaultProjectName when AreaPath is missing', () => {
    const ev = workItem({ 'System.AreaPath': undefined });
    const out = adoWorkItemPlugin.transform(ev, { defaultProjectName: 'manual-fallback' });
    expect(out[0].scope).toEqual({ kind: 'project', name: 'manual-fallback' });
  });

  it('uses "unknown" project name when no AreaPath and no fallback', () => {
    const ev = workItem({ 'System.AreaPath': undefined });
    const out = adoWorkItemPlugin.transform(ev);
    expect(out[0].scope).toEqual({ kind: 'project', name: 'unknown' });
  });
});
