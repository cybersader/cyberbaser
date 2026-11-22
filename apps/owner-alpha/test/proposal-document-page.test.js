import { describe, expect, test } from 'bun:test';
import { FRAME_CSP } from '../src/proposal-review-page.js';
import { createProposalDocumentFixture } from './proposal-document-fixtures.js';

async function openFixture(options) {
  const fixture = createProposalDocumentFixture(options);
  const handler = await fixture.handler();
  const host = new URL(fixture.ownerOrigin).host;
  const request = (path, cookie, init = {}) => handler(new Request(fixture.ownerOrigin + path, {
    ...init, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
  }));
  const login = await request(`/owner/bootstrap?token=${handler.bootstrapToken}`);
  expect(login.status).toBe(303);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  return {
    fixture,
    async page(key, { view = 'review', query = '' } = {}) {
      const path = key ? `/owner/${view}/${fixture.cases.get(key).queueId}${query}` : '/owner/review';
      const response = await request(path, cookie);
      return { status: response.status, html: await response.text(), location: response.headers.get('location'), headers: response.headers };
    },
    async frame(key, view = 'review') {
      const response = await request(`/owner/${view}/${fixture.cases.get(key).queueId}/page`, cookie);
      return { status: response.status, html: await response.text(), headers: response.headers };
    },
    async decide(key, body) {
      const { queueId } = fixture.cases.get(key);
      const shell = await request(`/owner/review/${queueId}`, cookie);
      const csrf = /data-csrf="([^"]+)"/u.exec(await shell.text())[1];
      const response = await request(`/api/review/${queueId}/decision`, cookie, {
        method: 'POST',
        headers: { Origin: fixture.ownerOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueId, reviewEvidenceDigest: fixture.cases.get(key).entry.summary.reviewEvidenceDigest, reason: 'Checked.', csrf, ...body }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

function panel(html) {
  return html.match(/<section class="rv-sheet"[^>]*>([\s\S]*?)<details class="rv-details"/u)?.[1];
}

function reviewDetails(html) {
  return html.match(/<details class="rv-details"[^>]*>([\s\S]*?)<\/details>\s*<\/div>\s*<\/section>/u)?.[1];
}

describe('proposal review: site frame and private panel', () => {
  test('the inbox names every sender plainly and each pending page frames the full note beside the panel', async () => {
    const { page, frame } = await openFixture();
    const inbox = await page();
    expect(inbox.status).toBe(200);
    expect(inbox.html).toContain('Needs review');
    expect(inbox.html).toContain('Decided');
    for (const [key, byline, count] of [
      ['folder-agent', 'From Workspace Draft Agent, one of your agents', '1 change'],
      ['long-three-visitor', 'From a visitor', '3 changes'],
      ['list-code-pull-request', 'From pull request #42 on your forge', '2 changes'],
    ]) {
      expect(inbox.html).toContain(byline);
      expect(inbox.html).toContain(`<span class="proposal-row-count">${count}</span>`);
      const { html, status } = await page(key);
      expect(status).toBe(200);
      expect(html.indexOf('<iframe')).toBeLessThan(html.indexOf('class="rv-sheet"'));
      expect(html).toContain('id="decision-reason"');
      expect(html).not.toContain('data-apply');
    }
    const { html: agent } = await page('folder-agent');
    expect(panel(agent)).toContain('From <b>Workspace Draft Agent</b>, one of your agents.');
    const agentFrame = (await frame('folder-agent')).html;
    expect(agentFrame).toContain('The next person should be able to find the decision without asking.');
    expect(agentFrame).toMatch(/<del>blue folder<\/del> ?<ins>green binder<\/ins>/u);
    expect(reviewDetails(agent)).toContain('green bin</pre>');
    expect(reviewDetails(agent)).toContain('Source binding');
    const { html: visitor } = await page('long-three-visitor');
    expect(panel(visitor)).toContain('From <b>a visitor</b>, not signed in.');
    expect((await frame('long-three-visitor')).html).toContain('Keys and cleanup');
    expect(visitor).toContain('data-anchors="1,2,3"');
    expect(visitor).toContain('id="rv-pos" aria-live="polite">1 of 3');
    const visitorFrame = (await frame('long-three-visitor')).html;
    expect([...visitorFrame.matchAll(/id="c(\d+)"/gu)].map((match) => match[1])).toEqual(['1', '2', '3']);
    const { html: forge } = await page('list-code-pull-request');
    expect(forge).toContain('pull request #42</a> on your forge');
    expect(forge).toContain('href="https://forge.example/owner/workshop/pulls/42"');
    const forgeFrame = (await frame('list-code-pull-request')).html;
    expect(forgeFrame).toContain('<pre><code>');
    expect(forgeFrame).toContain('Ask the host before changing shared settings.');
  });

  test('approved, rejected, stale, unapplicable, expired and missing-base states do not offer decision controls', async () => {
    const { page, frame } = await openFixture();
    const redirect = await page('already-approved');
    expect(redirect.status).toBe(303);
    expect(redirect.location).toMatch(/^\/owner\/decisions\/Q-/u);
    for (const [key, text, apply] of [
      ['already-approved', 'The page has not changed. Applying is a separate step.', true],
      ['already-rejected', 'Nothing changed. The page is exactly as it was.', false],
      ['approved-stale', 'Approved, but the page has moved on', false],
      ['properties-unapplicable', 'Approved, but it can’t be applied', false],
      ['applied', 'Pushing to your repository', false],
    ]) {
      const { status, html } = await page(key, { view: 'decisions' });
      expect(status).toBe(200);
      expect(html).toContain(text);
      expect(html).not.toContain('id="review-decision-form"');
      expect(html.includes('data-apply>Apply to page')).toBe(apply);
      expect(html).toMatch(/<iframe [^>]*sandbox=""[^>]*src="\/owner\/decisions\/Q-[^"]+\/page"/u);
      expect((await frame(key, 'decisions')).status).toBe(200);
    }
    for (const [key, text] of [['expired', 'This proposal expired'], ['base-unreachable', 'This proposal’s base is no longer available']]) {
      const { status, html } = await page(key);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(html).toContain(text);
      expect(html).not.toContain('id="review-decision-form"');
      expect(html).not.toContain('data-action="approve"');
    }
    const pending = await page('properties-pending');
    expect(pending.html).toContain('This can’t be approved');
    expect(pending.html).toContain('Page properties · 1');
    expect(pending.html).toContain('data-action="reject"');
    expect(panel(pending.html)).not.toContain('data-action="approve"');
    expect(pending.html).not.toContain('data-apply');
  });

  test('markup in draft content, exact evidence and signed display names remains inert', async () => {
    const { page, frame } = await openFixture({ hostileLabel: true });
    const { html } = await page('markup-and-hidden');
    expect(html).toContain('From <b>&lt;em&gt;Draft Agent&lt;/em&gt;</b>, one of your agents.');
    expect(html).not.toContain('<em>Draft Agent</em>');
    expect(html).not.toContain('<em>binder</em>');
    expect(reviewDetails(html)).toContain('&lt;em&gt;binder&lt;/em&gt;');
    const page2 = (await frame('markup-and-hidden')).html;
    expect(page2).toContain('A visible line');
    expect(page2).not.toContain('<em>binder</em>');
  });

  test('the page frame is sandboxed, script-free, unframeable elsewhere, and vault HTML cannot act', async () => {
    const { page, frame } = await openFixture();
    const shell = await page('hostile-html');
    expect(shell.headers.get('content-security-policy')).toContain("frame-src 'self'");
    expect(shell.headers.get('content-security-policy')).toContain("script-src 'self'");
    const iframe = /<iframe [^>]*>/u.exec(shell.html)[0];
    expect(iframe).toContain('sandbox=""');
    expect(iframe).not.toContain('allow-');
    expect(iframe).not.toContain('srcdoc');
    const framed = await frame('hostile-html');
    expect(framed.status).toBe(200);
    expect(framed.headers.get('content-security-policy')).toBe(FRAME_CSP);
    for (const directive of ["default-src 'none'", "frame-ancestors 'self'", "form-action 'none'", "img-src 'none'", 'sandbox']) {
      expect(FRAME_CSP.split('; ')).toContain(directive);
    }
    expect(FRAME_CSP).not.toContain('script-src');
    expect(framed.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    // Every hostile element arrives as visible text, never as markup.
    expect(framed.html).not.toMatch(/<(script|img|form|input|iframe|a|object|embed|link|base|meta http-equiv)\b/iu);
    expect(framed.html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/iu);
    expect(framed.html).not.toContain('target="_top"');
    expect(framed.html).toContain('&lt;script&gt;window.HOSTILE_SCRIPT = 1&lt;/script&gt;');
    expect(framed.html).toContain('onerror=&quot;window.HOSTILE_IMG = 1&quot;');
    expect(framed.html).toContain('target=&quot;_top&quot;');
    expect(framed.html).toContain('The ending stays.');
    // Links in the review copy are inert spans.
    expect((await frame('one-word')).html).toContain('<span class="lnk">restore guide</span>');
  });

  test('hidden comment canaries never appear in the page, the frame, the panel, the list or Details', async () => {
    const { page, frame } = await openFixture({ extraHiddenCases: true });
    for (const key of ['markup-and-hidden', 'marked-hidden-delimiters', 'obsidian-hidden', 'added-hidden-delimiters']) {
      for (const query of ['', '?mode=current', '?mode=proposed']) {
        const { status, html } = await page(key, { query });
        expect(status).toBe(200);
        expect(html.includes('_CANARY')).toBe(false);
        expect(reviewDetails(html)).toContain('Source binding');
        expect(reviewDetails(html)).not.toContain('Compare full versions');
      }
      const framed = (await frame(key)).html;
      expect(framed.includes('_CANARY')).toBe(false);
      expect(framed).toContain('Hidden content · source not shown');
      expect(framed).toContain('The ending stays.');
    }
    const unavailable = await page('replay-unavailable');
    expect(unavailable.status).toBe(200);
    expect(unavailable.html.includes('_CANARY')).toBe(false);
    expect(unavailable.html).not.toContain('amended');
    const unavailableFrame = (await frame('replay-unavailable')).html;
    expect(unavailableFrame.includes('_CANARY')).toBe(false);
    expect(unavailableFrame).toContain('Hidden content · source not shown');
    expect(unavailableFrame).not.toContain('amended');
  });

  test('changes the page cannot show are listed in the panel and must be seen before Approve, on the server too', async () => {
    const { page, decide, fixture } = await openFixture();
    const { html } = await page('link-destination');
    expect(html).toContain('A link would point somewhere new');
    expect(panel(html)).toContain('https://docs.example/restore');
    expect(panel(html)).toContain('https://help.example/restore');
    expect(html).toContain('id="rv-seen"');
    expect(html).toMatch(/<button type="button" data-action="approve" class="rv-pri" hidden>/u);
    expect(html).toContain('data-must-see="true"');

    const refused = await decide('link-destination', { action: 'approve' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('unseen-changes-not-acknowledged');
    expect(fixture.recorded).toHaveLength(0);
    const malformed = await decide('link-destination', { action: 'approve', acknowledgedInvisible: 'yes' });
    expect(malformed.status).toBe(400);
    const onReject = await decide('link-destination', { action: 'reject', acknowledgedInvisible: true });
    expect(onReject.status).toBe(400);
    expect(fixture.recorded).toHaveLength(0);
    // With the acknowledgement the request reaches the unchanged decision service.
    const acknowledged = await decide('link-destination', { action: 'approve', acknowledgedInvisible: true });
    expect(acknowledged.body.error.code).toBe('lock-busy');
    expect(fixture.recorded).toHaveLength(1);
    expect(Object.keys(fixture.recorded[0]).sort()).toEqual(['action', 'queueId', 'reason', 'reviewEvidenceDigest']);
    // Nothing to see: decisions are exactly as before, no new field needed.
    const plain = await decide('one-word', { action: 'approve' });
    expect(plain.body.error.code).toBe('lock-busy');
    const rejected = await decide('link-destination', { action: 'reject' });
    expect(rejected.body.error.code).toBe('lock-busy');
    expect(fixture.recorded).toHaveLength(3);
    for (const key of ['markup-and-hidden', 'marked-hidden-delimiters']) {
      expect((await decide(key, { action: 'approve' })).body.error.code).toBe('unseen-changes-not-acknowledged');
    }
  });

  test('rewritten paragraphs fold, many changes get a list, properties form their own group', async () => {
    const { page, frame } = await openFixture();
    const rewrite = await page('rewrite-three');
    expect(rewrite.html).toContain('3 paragraphs rewritten');
    const rewritten = (await frame('rewrite-three')).html;
    expect(rewritten.match(/class="chg rw"/gu)).toHaveLength(3);
    expect(rewritten.match(/Show what it said before/gu)).toHaveLength(3);
    expect(rewritten).not.toMatch(/<ins>/u);
    const many = await page('many-24');
    expect(many.html).toContain('24 changes');
    expect(many.html).toContain('See all 24 changes');
    expect(many.html).toContain(`data-anchors="${Array.from({ length: 24 }, (_, index) => index + 1).join(',')}"`);
    expect(many.html.match(/<li><a href="[^"]+#c\d+" target="rv-frame"/gu)).toHaveLength(24);
    expect(many.html).toContain('Read all');
    const one = await page('one-word');
    expect(one.html).toContain('<h1 class="">1 change</h1>');
    expect(one.html).not.toContain('rv-list-toggle');
    const properties = await page('properties-title');
    expect(properties.html).toContain('Page properties · 2');
    expect(properties.html).toMatch(/<dt>title<\/dt><dd><del>Testing a backup<\/del> <ins>Test a backup<\/ins><\/dd>/u);
    expect(panel(properties.html)).not.toContain('data-action="approve"');
    const propertiesFrame = (await frame('properties-title')).html;
    expect(propertiesFrame).not.toContain('tags:');
    expect(propertiesFrame).toMatch(/<del>original<\/del> <ins>spare<\/ins> drive/u);
  });
});
