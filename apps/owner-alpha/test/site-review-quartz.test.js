// Opt-in: a throwaway vault gets a real private build from the pinned Quartz
// with source provenance, then signed agent proposals against it open on the
// site's own page. Slow (a real Quartz build). Run alone:
//   OWNER_ALPHA_SITE_REVIEW_QUARTZ=1 bun test apps/owner-alpha/test/site-review-quartz.test.js
// Set OWNER_ALPHA_REVIEW_SCREENSHOTS=<dir> to also capture phone and desktop views.
import { expect, test } from 'bun:test';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_LABEL, createAgentProposalRehearsal, runAgentChild } from '../bin/agent-proposal-rehearsal.js';
import { assertPrerequisites } from '../bin/suggestions-rehearsal-fixture.js';
import { FRAME_CSP } from '../src/proposal-review-page.js';
import { SITE_FRAME_CSP, SITE_REVIEW_REASONS } from '../src/site-review-page.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../../..');
const SCREENSHOTS = process.env.OWNER_ALPHA_REVIEW_SCREENSHOTS ?? null;
const enabled = process.env.OWNER_ALPHA_SITE_REVIEW_QUARTZ === '1';

const rewrites = [
  ['Restore some files somewhere and see if it worked. If nothing complains, the backup is probably fine for now.',
    'Restore a small folder to a spare drive. Keep the working copy disconnected until you have checked every restored file.'],
  ['Look at a few files when you have time. If they open at all, you can assume the rest of them are fine.',
    'Open a document and a photo from the restored folder. Compare their checksums with the originals; a matching count is not enough.'],
  ['Delete the test copy when you are done so it does not take up space on the drive afterwards.',
    'Keep the restored folder until you have written down the snapshot name, the date and how long the restore took.'],
];
const before = `---\ntitle: Testing a backup\ntags: [backups]\n---\n\nA successful backup job tells you the copy finished. A restore test tells you whether you can use it.\n\n## Choose a destination\n\nRestore a small folder to the original drive. Leave the working copy alone.\n\nPick a folder you know well. For the command, see the [restore guide](https://docs.example/restore).\n\n## Run a restore test\n\n${rewrites.map(([old]) => old).join('\n\n')}\n\n## Record the result\n\nKeep one entry per test, with the snapshot name and how long it took.\n`;
const capture = (text) => ({ source: 'workspace-fixture', path: 'draft.md', text });
const proposals = {
  'one-word': before.replace('original drive', 'spare drive'),
  'rewrite-three': rewrites.reduce((text, [old, next]) => text.replace(old, next), before),
  'link-destination': before.replace('docs.example/restore', 'help.example/restore'),
};

function freePorts() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listeners = [];
    try {
      const port = 48500 + Math.floor(Math.random() * 7000);
      for (let offset = 0; offset < 3; offset += 1) listeners.push(Bun.serve({ hostname: '127.0.0.1', port: port + offset, fetch: () => new Response('reserved') }));
      return port;
    } catch { /* another triple */ } finally { for (const listener of listeners) listener.stop(true); }
  }
  throw new Error('no free loopback port triple');
}

(enabled ? test : test.skip)('real private Quartz build: matching head shows the site page with marks; an unplaceable change falls back with its reason', async () => {
  await assertPrerequisites();
  const fixture = await createAgentProposalRehearsal({ port: freePorts(), before: capture(before), after: capture(proposals['one-word']),
    realQuartz: true, siteTitle: 'Cyberbase' });
  try {
    const ids = { 'one-word': fixture.queueId };
    for (const key of ['rewrite-three', 'link-destination']) {
      await writeFile(fixture.agent.capture, JSON.stringify(capture(proposals[key])));
      const result = await runAgentChild(fixture.agent);
      expect(result.code, result.stderr).toBe(0);
      ids[key] = JSON.parse(result.stdout).queueId;
    }
    const login = await fetch(fixture.issueSignInUrl(), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    const get = async (route) => {
      const response = await fetch(`${fixture.ownerOrigin}${route}`, { headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      return { status: response.status, html: await response.text(), csp: response.headers.get('content-security-policy') };
    };

    const word = await get(`/owner/review/${ids['one-word']}/page`);
    expect(word.status).toBe(200);
    expect(word.csp).toBe(SITE_FRAME_CSP);
    expect(word.html).toContain('<article class="popover-hint">');
    expect(word.html).toContain('<span class="cbr-c cbr-n1" id="c1"><del>original</del> <ins>spare</ins></span> drive');
    expect(word.html).toContain('Cyberbase');
    expect(word.html.replace(/<style[\s\S]*?<\/style>/gu, '')).not.toMatch(/<(script|link|iframe|form)\b|\son[a-z]+=|\shref=/iu);
    const shell = await get(`/owner/review/${ids['one-word']}`);
    expect(shell.html).toContain(`From <b>${AGENT_LABEL}</b>`);
    expect(shell.html).not.toContain('rv-site-note');

    const rewrite = await get(`/owner/review/${ids['rewrite-three']}/page`);
    expect(rewrite.csp).toBe(SITE_FRAME_CSP);
    expect(rewrite.html.match(/<div class="cbr-rw"><span class="cbr-tag">Rewritten<\/span>/gu)).toHaveLength(3);

    const link = await get(`/owner/review/${ids['link-destination']}/page`);
    expect(link.csp).toBe(FRAME_CSP);
    expect(link.html).not.toContain('popover-hint');
    expect((await get(`/owner/review/${ids['link-destination']}`)).html).toContain(SITE_REVIEW_REASONS.unplaceable);

    if (SCREENSHOTS !== null) {
      const { chromium } = await import(path.join(PROJECT_ROOT, 'docs/node_modules/playwright/index.js'));
      await mkdir(SCREENSHOTS, { recursive: true });
      const browser = await chromium.launch({ headless: true });
      const errors = [];
      try {
        for (const [size, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 800 }]]) {
          const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
          const page = await context.newPage();
          page.on('pageerror', (error) => errors.push(String(error)));
          await page.goto(fixture.issueSignInUrl());
          const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(SCREENSHOTS, `${size}-${name}.png`) }); };
          await page.goto(`${fixture.ownerOrigin}/owner/review/${ids['one-word']}`);
          await shot('01-one-word');
          await page.goto(`${fixture.ownerOrigin}/owner/review/${ids['rewrite-three']}`);
          await page.frameLocator('#rv-frame').locator('details.cbr-old summary').first().click();
          await shot('02-rewrite-three');
          await page.goto(`${fixture.ownerOrigin}/owner/review/${ids['link-destination']}?mode=changes`);
          await page.locator('#publication-review-fallback').evaluate((element) => { element.open = true; });
          await page.locator('.rv-site-note').scrollIntoViewIfNeeded();
          await shot('03-fallback-reason');
          await context.close();
        }
      } finally { await browser.close(); }
      expect(errors).toEqual([]);
    }
  } finally { await fixture.cleanup(); }
  await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
}, 600_000);
