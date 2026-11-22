import { describe, expect, test } from 'bun:test';
import { createProposalDocumentFixture } from './proposal-document-fixtures.js';

async function openFixture(options) {
  const fixture = createProposalDocumentFixture(options);
  const handler = await fixture.handler();
  const request = (path, cookie) => handler(new Request(fixture.ownerOrigin + path, {
    headers: { Host: new URL(fixture.ownerOrigin).host, ...(cookie ? { Cookie: cookie } : {}) },
  }));
  const login = await request(`/owner/bootstrap?token=${handler.bootstrapToken}`);
  expect(login.status).toBe(303);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  return {
    async page(key, { view = 'review', query = '' } = {}) {
      const path = key ? `/owner/${view}/${fixture.cases.get(key).queueId}${query}` : '/owner/review';
      const response = await request(path, cookie);
      return { status: response.status, html: await response.text(), location: response.headers.get('location') };
    },
  };
}

function visibleDocument(html) {
  return html.match(/<article class="publication-reviewed-document"[^>]*>([\s\S]*?)<\/article>/u)?.[1];
}

function reviewDetails(html) {
  return html.match(/<section id="publication-review-details">([\s\S]*)<\/details>\s*<\/div><\/div>/u)?.[1];
}

describe('document-first proposal review pages', () => {
  test('the inbox links to all three carriers and pending pages show a full note before a decision', async () => {
    const { page } = await openFixture();
    const inbox = await page();
    expect(inbox.status).toBe(200);
    expect(inbox.html).toContain('Needs review');
    expect(inbox.html).toContain('Decided');
    for (const [key, byline, count] of [
      ['folder-agent', 'From Workspace Draft Agent, an agent', '1 change'],
      ['long-three-visitor', 'From a visitor', '3 changes'],
      ['list-code-pull-request', 'From pull request #42 on your forge', '2 changes'],
    ]) {
      expect(inbox.html).toContain(byline);
      expect(inbox.html).toContain(`<span class="proposal-row-count">${count}</span>`);
      const { html, status } = await page(key);
      expect(status).toBe(200);
      expect(html.indexOf('aria-label="Proposed document"')).toBeLessThan(html.indexOf('aria-label="Your decision"'));
      expect(html).toContain('id="publication-toggle-details"');
      expect(html).toContain('id="decision-reason"');
      expect(html).not.toContain('data-apply');
    }
    const { html: agent } = await page('folder-agent');
    expect(agent).toContain('From Workspace Draft Agent, an agent');
    expect(visibleDocument(agent)).toContain('The next person should be able to find the decision without asking.');
    expect(visibleDocument(agent)).toMatch(/<del[^>]*>blue folder<\/del><ins[^>]*>green binder<\/ins>/u);
    expect(reviewDetails(agent)).toContain('green bin</pre>');
    expect(reviewDetails(agent)).toContain('Source binding');
    const { html: visitor } = await page('long-three-visitor');
    expect(visitor).toContain('From a visitor');
    expect(visibleDocument(visitor)).toContain('Keys and cleanup');
    expect([...visitor.matchAll(/data-change="(\d+)"/gu)].map((match) => match[1])).toEqual(['1', '2', '3']);
    expect(visitor).toContain('id="publication-change-count">1 / 3');
    const { html: forge } = await page('list-code-pull-request');
    expect(forge).toContain('pull request #42</a> on your forge');
    expect(forge).toContain('href="https://forge.example/owner/workshop/pulls/42"');
    expect(visibleDocument(forge)).toContain('md-codeblock');
    expect(visibleDocument(forge)).toContain('Ask the host before changing shared settings.');
  });

  test('approved, rejected, stale, unapplicable, expired and missing-base states do not offer decision controls', async () => {
    const { page } = await openFixture();
    const redirect = await page('already-approved');
    expect(redirect.status).toBe(303);
    expect(redirect.location).toMatch(/^\/owner\/decisions\/Q-/u);
    for (const [key, text, apply] of [
      ['already-approved', 'You approved this suggestion', true],
      ['already-rejected', 'You rejected this suggestion', false],
      ['approved-stale', 'Cannot be applied as it is', false],
      ['properties-unapplicable', 'The page pipeline cannot apply this yet', false],
    ]) {
      const { status, html } = await page(key, { view: 'decisions' });
      expect(status).toBe(200);
      expect(html).toContain(text);
      expect(html).not.toContain('id="review-decision-form"');
      expect(html.includes('data-apply>Apply to page')).toBe(apply);
    }
    for (const [key, text] of [['expired', 'This proposal expired'], ['base-unreachable', 'This proposal’s base is no longer available']]) {
      const { status, html } = await page(key);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(html).toContain(text);
      expect(html).not.toContain('id="review-decision-form"');
    }
    const pending = await page('properties-pending');
    expect(pending.html).toContain('This changes page properties.');
    expect(pending.html).toContain('id="review-decision-form"');
    expect(pending.html).not.toContain('data-apply');
  });

  test('markup in draft content, exact evidence and signed display names remains inert', async () => {
    const { page } = await openFixture({ hostileLabel: true });
    const { html } = await page('markup-and-hidden');
    expect(html).toContain('From &lt;em&gt;Draft Agent&lt;/em&gt;, an agent');
    expect(html).not.toContain('<em>Draft Agent</em>');
    expect(html).not.toContain('<em>binder</em>');
    expect(reviewDetails(html)).toContain('&lt;em&gt;binder&lt;/em&gt;');
    expect(visibleDocument(html)).toContain('A visible line');
  });

  test('hidden comment canaries never appear in the proposal HTML, including Details, context and source fallback', async () => {
    const { page } = await openFixture({ extraHiddenCases: true });
    for (const key of ['markup-and-hidden', 'marked-hidden-delimiters', 'obsidian-hidden', 'added-hidden-delimiters']) {
      for (const query of ['', '?mode=current', '?mode=proposed']) {
        const { status, html } = await page(key, { query });
        expect(status).toBe(200);
        expect(html.includes('_CANARY')).toBe(false);
        expect(visibleDocument(html)).toContain('Hidden content · source not shown');
        expect(visibleDocument(html)).toContain('The ending stays.');
        expect(reviewDetails(html)).toContain('Source binding');
        expect(reviewDetails(html)).not.toContain('Compare full versions');
      }
    }
    const unavailable = await page('replay-unavailable');
    expect(unavailable.status).toBe(200);
    expect(unavailable.html.includes('_CANARY')).toBe(false);
    expect(visibleDocument(unavailable.html)).toContain('Hidden content · source not shown');
    expect(reviewDetails(unavailable.html)).not.toContain('amended');
  });
});
