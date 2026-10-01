#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MOCKUP_HOST, startMockupServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PLAYWRIGHT = path.join(ROOT, 'docs', 'node_modules', 'playwright', 'index.js');
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref(); probe.once('error', reject);
    probe.listen(0, MOCKUP_HOST, () => { const { port } = probe.address(); probe.close((error) => error ? reject(error) : resolve(port)); });
  });
}
function runId() { return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-'); }
const screenshotRoot = path.join(ROOT, '.workspace', 'proposal-review-mockup', 'screenshots');
const output = path.join(screenshotRoot, runId());
await mkdir(screenshotRoot, { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: false, mode: 0o700 });
const port = await freePort();
const server = await startMockupServer({ port });
const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
const browser = await chromium.launch({ headless: true });
async function context(width, height, colorScheme) {
  return browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce' });
}
async function shot(page, name, fullPage = true) {
  const target = path.join(output, `${name}.png`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.screenshot({ path: target, fullPage, animations: 'disabled' });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      await page.waitForTimeout(75);
    }
  }
}
try {
  let ctx = await context(1440, 900, 'light');
  let page = await ctx.newPage();
  await page.goto(`${server.url}#inbox`); await shot(page, 'inbox-light-desktop');
  await page.goto(`${server.url}#review/v1-access-review-long-page/changes`); await shot(page, 'long-page-changes-light-desktop', false);
  await page.goto(`${server.url}#review/v1-access-review-long-page/proposed`); await shot(page, 'long-page-proposed-light-desktop');
  await page.goto(`${server.url}#review/v1-access-review-long-page/current`); await shot(page, 'long-page-current-light-desktop');
  await page.goto(`${server.url}#review/v1-access-review-long-page/compare`); await shot(page, 'long-page-compare-light-desktop', false);
  await page.goto(`${server.url}#review/v1-access-review-long-page/changes`);
  await page.getByRole('button', { name: 'Decide this proposal' }).click();
  await shot(page, 'decision-dock-open-light-desktop', false);
  await page.goto(`${server.url}#review/blocked-stale-base/proposed`); await shot(page, 'not-derivable-light-desktop', false);
  await page.goto(`${server.url}#review/v1-survey-number-date/changes`); await shot(page, 'short-page-changes-light-desktop', false);
  await page.goto(`${server.url}#review/v1-retention-paragraph/changes`); await shot(page, 'paragraph-light-desktop');
  await ctx.close();

  ctx = await context(1440, 900, 'dark'); page = await ctx.newPage();
  await page.goto(`${server.url}#review/v1-retention-paragraph/changes`); await shot(page, 'paragraph-dark-desktop');
  await ctx.close();

  ctx = await context(1440, 900, 'light'); page = await ctx.newPage();
  await page.goto(`${server.url}#review/v2-setup-three-places`);
  await page.getByRole('button', { name: '3. Add the compatibility note' }).click();
  await shot(page, 'multi-operation-light-desktop');
  await page.goto(`${server.url}#review/v1-offline-limitation-insertion/compare`); await shot(page, 'insertion-light-desktop');
  await page.goto(`${server.url}#review/v1-obsolete-notice-deletion/compare`); await shot(page, 'deletion-light-desktop');
  await page.goto(`${server.url}#review/v1-retention-paragraph`);
  await page.getByRole('button', { name: 'Decide this proposal' }).click();
  await page.locator('.decision-dock textarea').fill('The clarification is accurate and preserves the intended retention policy.');
  await page.getByRole('button', { name: 'Approve proposal' }).click();
  await page.getByRole('button', { name: 'Confirm approval' }).click();
  await page.waitForURL(/#receipts$/u); await page.getByText('Approval recorded', { exact: true }).waitFor(); await shot(page, 'approval-receipt-light');
  await page.goto(`${server.url}#review/v1-survey-number-date`);
  await page.getByRole('button', { name: 'Decide this proposal' }).click();
  await page.locator('.decision-dock textarea').fill('The reference is not verified enough for this factual correction.');
  await page.getByRole('button', { name: 'Reject proposal' }).click();
  await page.getByRole('button', { name: 'Confirm rejection' }).click();
  await page.waitForURL(/#receipts$/u); await page.getByText('Proposal rejected', { exact: true }).waitFor(); await shot(page, 'rejection-receipt-light');
  await page.goto(`${server.url}#system`); await shot(page, 'system-light-desktop');
  await ctx.close();

  ctx = await context(390, 844, 'dark'); page = await ctx.newPage();
  await page.goto(`${server.url}#review/v2-setup-three-places/compare`); await shot(page, 'mobile-stacked-dark');
  await page.getByRole('button', { name: '3 changes · Decide' }).click(); await shot(page, 'mobile-decision-sheet-dark');
  await ctx.close();
  process.stdout.write(`Static-design-only screenshots written to ${output}\n`);
} finally {
  await browser.close();
  server.stop(true);
}
