import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MOCKUP_HOST, startMockupServer } from '../src/server.js';

const ROOT = path.resolve(import.meta.dir, '../../..');
const PLAYWRIGHT = path.join(ROOT, 'docs', 'node_modules', 'playwright', 'index.js');
const running = [];
let browser;
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.unref(); probe.once('error', reject);
    probe.listen(0, MOCKUP_HOST, () => { const { port } = probe.address(); probe.close((error) => error ? reject(error) : resolve(port)); });
  });
}
async function fixture(width = 1440, height = 900, colorScheme = 'light') {
  const port = await freePort();
  const server = await startMockupServer({ port }); running.push({ stop: () => server.stop(true) });
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce' });
  running.push({ stop: () => context.close() });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(15_000);
  return { server, context, page };
}
beforeAll(async () => {
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
  browser = await chromium.launch({ headless: true });
});
afterEach(async () => {
  for (const item of running.splice(0).reverse()) await item.stop();
});
afterAll(async () => { await browser?.close(); });

test('a seeded HttpOnly owner-session cookie stays on the owner host and is not sent to the mockup', async () => {
  const { context, page, server } = await fixture();
  await context.addCookies([{
    name: 'owner_alpha_session',
    value: 'privileged-owner-cookie',
    url: 'http://127.0.0.1:4317/owner/review',
    httpOnly: true,
    sameSite: 'Strict',
  }]);
  const navigationRequest = page.waitForRequest((request) => request.isNavigationRequest() && request.url() === server.url);
  const response = await page.goto(server.url);
  const request = await navigationRequest;
  expect(response.status()).toBe(200);
  expect((await request.allHeaders()).cookie).toBeUndefined();
  expect(await context.cookies(server.url)).toEqual([]);
  expect(await context.cookies('http://127.0.0.1:4317/owner/review')).toEqual([
    expect.objectContaining({ name: 'owner_alpha_session', value: 'privileged-owner-cookie', httpOnly: true }),
  ]);
}, 120_000);

test('the default reading mode gives the proposal full width and keeps the owner action visible', async () => {
  const { page, server } = await fixture();
  const requests = [];
  page.on('request', (request) => requests.push({ method: request.method(), url: request.url() }));
  await page.goto(`${server.url}#review/v1-retention-paragraph`);

  expect(await page.locator('#mode-panel').getAttribute('aria-labelledby')).toBe('mode-tab-changes');
  expect(await page.locator('[role="tab"]').evaluateAll((items) => items.map((item) => item.textContent.split('\n')[0].trim()))).toHaveLength(4);
  expect(await page.locator('[data-mode="changes"]').getAttribute('aria-selected')).toBe('true');
  const widths = await page.evaluate(() => ({
    body: document.querySelector('.reading-body').getBoundingClientRect().width,
    canvas: document.querySelector('.review-canvas').getBoundingClientRect().width,
  }));
  expect(widths.body / widths.canvas).toBeGreaterThan(0.55);
  expect(await page.locator('#rendered-reading').isChecked()).toBe(true);
  expect(await page.locator('.reading-body .md-heading').count()).toBeGreaterThan(0);
  expect(await page.locator('.md-source-wrap .md-source-label').first().innerText()).toBe('EXACT SOURCE · CHANGED PASSAGE');
  expect(await page.locator('.md-source del').count()).toBe(1);
  expect(await page.locator('.md-source ins').count()).toBe(1);
  await page.locator('#rendered-reading').uncheck();
  expect(await page.locator('.reading-body').count()).toBe(0);
  expect(await page.locator('.document-changes del').count()).toBe(1);
  expect(await page.locator('.document-changes ins').count()).toBe(1);
  expect(await page.locator('.document-body').evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('pre-wrap');
  await page.locator('#rendered-reading').check();

  const dock = page.locator('.decision-dock');
  expect(await dock.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
  expect(await page.locator('#dock-body').evaluate((element) => element.hidden)).toBe(true);
  const decide = page.getByRole('button', { name: 'Decide this proposal' });
  const box = await decide.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  for (const value of ['Owner action required', '1 exact change in 1 page', 'EXECUTABLE V1 · SYNTHETIC MECHANICAL', 'Removed text is', 'Added text is']) {
    expect(await page.getByText(value, { exact: false }).count()).toBeGreaterThan(0);
  }
  expect(requests.every((item) => item.method === 'GET')).toBe(true);
  expect(requests.every((item) => new URL(item.url).host === `${MOCKUP_HOST}:${server.port}`)).toBe(true);
}, 120_000);

test('mode tabs switch by pointer and keyboard and render only derivable documents', async () => {
  const { page, server } = await fixture();
  await page.goto(`${server.url}#review/v1-retention-paragraph`);
  await page.getByRole('tab', { name: 'Proposed', exact: true }).click();
  await page.locator('#mode-panel.mode-panel-proposed').waitFor();
  expect(await page.locator('.document-proposed').count()).toBe(1);
  expect(await page.locator('.document-proposed del').count()).toBe(0);
  expect(await page.locator('.document-proposed ins').count()).toBe(1);
  expect(await page.locator('.document-proposed .md-heading').count()).toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'Current', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('#mode-panel.mode-panel-current').waitFor();
  expect(await page.locator('.document-current ins').count()).toBe(0);
  expect(await page.locator('.document-current del').count()).toBe(1);
  expect(await page.locator('.document-current .md-paragraph').count()).toBeGreaterThan(0);

  await page.keyboard.press('ArrowRight');
  await page.locator('#mode-panel.mode-panel-compare').waitFor();
  const panes = await page.locator('.proof').evaluateAll((items) => items.map((item) => ({ label: item.getAttribute('aria-label'), box: item.getBoundingClientRect().toJSON() })));
  expect(panes.map((item) => item.label)).toEqual(['Current source', 'Proposed change']);
  expect(Math.abs(panes[0].box.width - panes[1].box.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(panes[0].box.y - panes[1].box.y)).toBeLessThanOrEqual(1);
  expect(panes[0].box.x).toBeLessThan(panes[1].box.x);

  await page.keyboard.press('Home');
  await page.locator('#mode-panel.mode-panel-changes').waitFor();
  expect(await page.locator('.document-changes').count()).toBe(1);
}, 120_000);

test('a proposal with no derivable candidate refuses to invent proposed or unified documents', async () => {
  const { page, server } = await fixture();
  await page.goto(`${server.url}#review/blocked-stale-base/proposed`);
  expect(await page.getByText('Not derivable', { exact: true }).count()).toBeGreaterThan(0);
  expect(await page.getByText('No candidate result is derivable from this evidence', { exact: false }).count()).toBeGreaterThan(0);
  expect(await page.locator('.document-proposed').count()).toBe(0);
  await page.getByRole('button', { name: 'Show the declared change spans' }).click();
  await page.locator('#mode-panel.mode-panel-compare').waitFor();
  expect(await page.locator('.proof-current').count()).toBe(1);
  await page.goto(`${server.url}#review/blocked-stale-base/current`);
  expect(await page.locator('.document-current').count()).toBe(1);
  await page.goto(`${server.url}#review/later-new-handoff-checklist-page/current`);
  expect(await page.getByText('This page does not exist in the pinned base', { exact: false }).count()).toBeGreaterThan(0);
}, 120_000);

test('replacement, insertion, and deletion evidence uses truthful color-independent semantics', async () => {
  const { page, server } = await fixture();
  await page.goto(`${server.url}#review/v1-retention-paragraph/compare`);
  expect(await page.locator('.proof-current .semantic-label').innerText()).toBe('Removed');
  expect(await page.locator('.proof-proposed .semantic-label').innerText()).toBe('Added · Not yet approved');
  await page.goto(`${server.url}#review/v1-offline-limitation-insertion/compare`);
  expect(await page.locator('.proof-current .semantic-label').innerText()).toBe('No current text');
  expect(await page.locator('.proof-current').getByText('⟨insertion point · change 1⟩', { exact: true }).count()).toBe(1);
  await page.goto(`${server.url}#review/v1-obsolete-notice-deletion/compare`);
  expect(await page.locator('.proof-proposed .semantic-label').innerText()).toBe('Absent in proposed result · Not yet approved');
  expect(await page.locator('.proof-proposed').getByText('⟨removed here · change 1⟩', { exact: true }).count()).toBe(1);
  await page.goto(`${server.url}#review/v1-obsolete-notice-deletion/changes`);
  expect(await page.locator('.document-changes del').count()).toBe(1);
  expect(await page.locator('.document-changes ins').count()).toBe(0);
  await page.goto(`${server.url}#review/v1-frontmatter-review-date/current`);
  expect(await page.locator('.md-source').first().innerText()).toContain('reviewed: 2025-10-15');
  expect(await page.locator('.md-frontmatter').count()).toBe(0);
  await page.goto(`${server.url}#review/v1-onboarding-link/current`);
  expect(await page.locator('.md-heading').first().innerText()).toBe('Onboarding checklist');
  expect(await page.locator('.md-source').first().innerText()).toContain('/handbook/old-setup/');
  expect(await page.locator('.md-source-uninterpreted').count()).toBe(0);
}, 120_000);

test('long unchanged passages collapse on request and expand in place', async () => {
  const { page, server } = await fixture();
  await page.goto(`${server.url}#review/v1-access-review-long-page/current`);
  await page.locator('#rendered-reading').uncheck();
  const full = await page.locator('.document-body').innerText();
  await page.locator('#focus-changes').check();
  expect(await page.locator('#focus-changes').isChecked()).toBe(true);
  const collapsed = page.locator('.collapsed-run');
  const count = await collapsed.count();
  expect(count).toBeGreaterThan(0);
  expect((await page.locator('.document-body').innerText()).length).toBeLessThan(full.length);
  await collapsed.first().click();
  expect(await page.locator('.collapsed-run').count()).toBe(count - 1);
}, 120_000);

test('mobile stacks Current then Proposed, contains long evidence, and uses a full-width decision sheet', async () => {
  const { page, server } = await fixture(390, 844, 'dark');
  await page.goto(`${server.url}#review/v2-setup-three-places/compare`);
  const boxes = await page.locator('.proof').evaluateAll((items) => items.map((item) => ({ label: item.getAttribute('aria-label'), box: item.getBoundingClientRect().toJSON() })));
  expect(boxes.map((item) => item.label)).toEqual(['Current source', 'Proposed change']);
  expect(boxes[0].box.y).toBeLessThan(boxes[1].box.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(2);
  expect(await page.locator('.technical pre').evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto');
  expect(await page.locator('.decision-dock').evaluate((element) => getComputedStyle(element).display)).toBe('none');
  await page.getByRole('button', { name: '3 changes · Decide' }).click();
  const sheet = page.locator('#decision-sheet');
  expect(await sheet.evaluate((element) => element.open)).toBe(true);
  const box = await sheet.boundingBox();
  expect(Math.abs(box.width - 390)).toBeLessThanOrEqual(2);
  expect(await sheet.getByText('Target capability', { exact: true }).count()).toBe(1);
  expect(await sheet.getByText('Static design only', { exact: true }).count()).toBe(1);
  const close = sheet.getByRole('button', { name: 'Close' });
  const closeBox = await close.boundingBox();
  expect(closeBox.y).toBeGreaterThanOrEqual(box.y);
  expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(844);
  await close.click();
  expect(await sheet.evaluate((element) => element.open)).toBe(false);
  expect(await page.getByRole('button', { name: '3 changes · Decide' }).evaluate((element) => element === document.activeElement)).toBe(true);
  await page.getByRole('button', { name: '3 changes · Decide' }).click();
  await page.keyboard.press('Escape');
  expect(await sheet.evaluate((element) => element.open)).toBe(false);
  await page.goto(`${server.url}#review/long-unbreakable-url`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(2);
}, 120_000);

test('operation navigation preserves note text, keyboard focus, and selected semantics', async () => {
  const { page, server } = await fixture();
  await page.goto(`${server.url}#review/v2-setup-three-places`);
  await page.getByRole('button', { name: 'Decide this proposal' }).click();
  const note = page.locator('.decision-dock textarea');
  await note.fill('Review all three changes as one atomic proposal.');
  const second = page.getByRole('button', { name: '2. Repair the validation command and reference' });
  await second.focus();
  await page.keyboard.press('Enter');
  const selectedSecond = page.getByRole('button', { name: '2. Repair the validation command and reference' });
  expect(await selectedSecond.getAttribute('aria-current')).toBe('step');
  expect(await selectedSecond.getAttribute('aria-pressed')).toBe('true');
  expect(await selectedSecond.evaluate((element) => element === document.activeElement)).toBe(true);
  expect(await page.locator('.doc-added.is-active, .doc-removed.is-active').count()).toBeGreaterThan(0);
  expect(await page.locator('.decision-dock textarea').inputValue()).toBe('Review all three changes as one atomic proposal.');
  await page.getByRole('button', { name: 'Next' }).click();
  const selectedThird = page.getByRole('button', { name: '3. Add the compatibility note' });
  expect(await selectedThird.getAttribute('aria-current')).toBe('step');
  expect(await selectedThird.evaluate((element) => element === document.activeElement)).toBe(true);
  expect(await page.locator('.decision-dock textarea').inputValue()).toBe('Review all three changes as one atomic proposal.');
  await page.getByRole('button', { name: 'Approve proposal' }).click();
  const confirmation = page.locator('#confirmation-dialog');
  for (const value of ['guides/setup.md', 'Update the supported runtime prerequisite', 'Repair the validation command and reference', 'Add the compatibility note', 'One atomic decision · partial approval unavailable']) {
    expect(await confirmation.getByText(value, { exact: false }).count()).toBeGreaterThan(0);
  }
  await confirmation.getByRole('button', { name: 'Confirm approval' }).click();
  await page.waitForURL(/#receipts$/u);
  const receiptText = await page.locator('.receipt').first().innerText();
  for (const value of ['guides/setup.md', 'Update the supported runtime prerequisite', 'Repair the validation command and reference', 'Add the compatibility note', 'One atomic decision · partial approval unavailable', 'TARGET CAPABILITY', 'STATIC DESIGN ONLY', 'Source unchanged']) {
    expect(receiptText).toContain(value);
  }
}, 120_000);

test('note validation, deliberate confirmation, cancel, focus return, and receipt previews remain memory-only', async () => {
  const { page, server } = await fixture();
  let mutationRequests = 0;
  page.on('request', (request) => { if (!['GET', 'HEAD'].includes(request.method())) mutationRequests += 1; });
  await page.goto(`${server.url}#review/v1-retention-paragraph`);
  await page.getByRole('button', { name: 'Decide this proposal' }).click();
  const note = page.locator('.decision-dock textarea');
  const approve = page.getByRole('button', { name: 'Approve proposal' });
  await approve.click();
  expect(await page.locator('#confirmation-dialog').evaluate((element) => element.open)).toBe(false);
  for (const invalid of ['   ', 'line\nbreak', 'a'.repeat(4097)]) {
    await note.fill(invalid); await approve.click();
    expect(await page.locator('#confirmation-dialog').evaluate((element) => element.open)).toBe(false);
  }
  await note.fill('🧭'.repeat(1024));
  await approve.click();
  expect(await page.locator('#confirmation-dialog').evaluate((element) => element.open)).toBe(true);
  expect(await page.getByText('Source unchanged · this does not start', { exact: true }).count()).toBe(1);
  await page.keyboard.press('Escape');
  expect(await approve.evaluate((element) => element === document.activeElement)).toBe(true);
  expect(await note.inputValue()).toBe('🧭'.repeat(1024));
  await note.fill('The clarification is accurate and bounded.');
  await approve.click();
  expect(mutationRequests).toBe(0);
  await page.getByRole('button', { name: 'Confirm approval' }).click();
  await page.waitForURL(/#receipts$/u);
  await page.getByText('Approval recorded', { exact: true }).waitFor();
  for (const value of ['Private proposal decision receipt', 'Approval recorded', 'The clarification is accurate and bounded.', 'Source unchanged', 'No application requested or started', 'Executable v1', 'Synthetic mechanical']) expect(await page.getByText(value, { exact: false }).count()).toBeGreaterThan(0);
  expect(mutationRequests).toBe(0);
  await page.reload();
  expect(await page.getByText('No decisions previewed yet', { exact: true }).count()).toBe(1);
}, 120_000);

test('inbox, blocked, conceptual, authority, system, and evidence views preserve real boundaries', async () => {
  const { page, server } = await fixture();
  await page.goto(`${server.url}#inbox`);
  expect(await page.locator('.proposal-row').count()).toBe(16);
  for (const value of ['Ambiguous selection never entered the queue', 'No-op operations fail before admission', 'Use “review receipt” in both contributor guides']) expect(await page.getByText(value, { exact: true }).count()).toBe(0);
  await page.goto(`${server.url}#review/blocked-stale-base`);
  expect(await page.getByText('Decision unavailable', { exact: true }).count()).toBe(1);
  expect(await page.getByText('No decision was recorded', { exact: true }).count()).toBe(1);
  expect(await page.getByRole('button', { name: /proposal/u }).count()).toBe(0);
  expect((await page.locator('body').innerText()).includes('Proposal rejected')).toBe(false);
  await page.goto(`${server.url}#review/later-two-guide-terminology-rename`);
  expect(await page.getByText('Conceptual later', { exact: true }).count()).toBeGreaterThan(0);
  expect(await page.getByText('Conceptual later · no decision available', { exact: true }).count()).toBeGreaterThan(0);
  expect(await page.getByText('Needs your decision', { exact: true }).count()).toBe(0);
  expect(await page.getByRole('button', { name: /proposal/u }).count()).toBe(0);
  await page.goto(`${server.url}#review/authority-approved-not-authorized`);
  expect(await page.getByText('Approval recorded in the illustrated history', { exact: true }).count()).toBe(1);
  expect(await page.locator('.authority-rail').getByText('Source unchanged', { exact: true }).count()).toBeGreaterThanOrEqual(1);
  expect(await page.getByText('Decision unavailable', { exact: true }).count()).toBe(0);
  expect(await page.getByText('No decision was recorded', { exact: true }).count()).toBe(0);
  expect(await page.getByText('This static mockup recorded no decision and caused no effect.', { exact: false }).count()).toBe(1);
  await page.goto(`${server.url}#system`);
  for (const value of ['Docs and contributor surface', 'Lane-specific intake and adapter', 'Finite private queue', 'Private owner review', 'Immutable decision receipt', 'Application-authority gate', 'Canonical Markdown and Git', 'Renderer, deployment, and live witness', 'shared-socket OCI review is unimplemented', 'Lane B is disabled']) expect(await page.getByText(value, { exact: false }).count()).toBeGreaterThan(0);
  expect(await page.locator('.system-frame-button').count()).toBe(8);
  await page.locator('[data-system-frame="4"]').click();
  expect(await page.locator('#system-frame-detail').getByText('Implemented and mechanically accepted in the working tree', { exact: true }).count()).toBe(1);
  await page.locator('[data-system-frame="6"]').click();
  expect(await page.locator('[data-system-frame="6"]').getAttribute('aria-current')).toBe('step');
  expect(await page.locator('#system-frame-detail').getByText('Missing future boundary', { exact: true }).count()).toBe(1);
  await page.goto(`${server.url}#evidence`);
  for (const value of ['Executable v1', 'Target research', 'Conceptual later', 'Negative synthetic', 'Future operational design', 'Maintainer comprehension', 'Independent human', 'Live effect']) expect(await page.getByText(value, { exact: true }).count()).toBeGreaterThan(0);
  for (const value of ['Ambiguous selection never entered the queue', 'No-op operations fail before admission', 'Use “review receipt” in both contributor guides']) expect(await page.getByText(value, { exact: true }).count()).toBe(1);
  await page.getByText('Bidirectional and invisible characters are exposed safely', { exact: true }).click();
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).toContain('⟦U+202E RIGHT-TO-LEFT OVERRIDE⟧');
  expect(bodyText).toContain('⟦U+200B ZERO WIDTH SPACE⟧');
  expect(bodyText).not.toContain('‮');
}, 120_000);

test('light and dark action text meet focused contrast checks and focus remains visible', async () => {
  const { page, server } = await fixture();
  const ratios = async () => page.evaluate(() => {
    const parse = (value) => value.match(/[\d.]+/gu).slice(0, 3).map(Number);
    const luminance = (value) => {
      const channels = parse(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const ratio = (foreground, background) => {
      const light = Math.max(luminance(foreground), luminance(background));
      const dark = Math.min(luminance(foreground), luminance(background));
      return (light + 0.05) / (dark + 0.05);
    };
    const rail = getComputedStyle(document.querySelector('.decision-dock')).backgroundColor;
    const approve = getComputedStyle(document.querySelector('.approve'));
    const reject = getComputedStyle(document.querySelector('.reject'));
    const body = getComputedStyle(document.body);
    return {
      body: ratio(body.color, body.backgroundColor),
      approve: ratio(approve.color, approve.backgroundColor),
      reject: ratio(reject.color, rail),
    };
  });
  await page.goto(`${server.url}#review/v1-retention-paragraph`);
  await page.getByRole('button', { name: 'Decide this proposal' }).click();
  for (const value of Object.values(await ratios())) expect(value).toBeGreaterThanOrEqual(4.5);
  const approve = page.getByRole('button', { name: 'Approve proposal' });
  await approve.focus();
  expect(await approve.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe('3px');
  const tab = page.getByRole('tab', { name: 'Compare', exact: true });
  await tab.focus();
  expect(await tab.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe('3px');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  for (const value of Object.values(await ratios())) expect(value).toBeGreaterThanOrEqual(4.5);
}, 120_000);
