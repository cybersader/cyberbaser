#!/usr/bin/env node
// Phone-step acceptance run: the built plugin inside a disposable OpenClast
// harness browser (Obsidian mobile emulation, phone-sized viewport), a
// synthetic vault, and a disposable owner node with Iroh on.
//
//   node phone-step.mjs <out-dir>            loopback relay on 127.0.0.1
//   CYBERBASER_IROH_RELAY_TEST=1 node ...    n0's public relay instead
//
// Pairing starts on the node's Devices page and goes through its QR code: the
// QR is decoded from a screenshot and its obsidian:// link opened in Obsidian.
// Needs: the plugin built (bun run build), the loopback relay built
// (bun run build:wasm), and the OpenClast checkout (OPENCLAST_ROOT) with its
// browser-native dependencies and Playwright Chromium installed. Nothing here
// touches a real vault, account or room.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '../..');
const openclast = process.env.OPENCLAST_ROOT ?? path.resolve(pluginRoot, '../../../openclast');
const harnessCli = path.join(openclast, 'experimental/browser-native/harness/openclast-harness.mjs');
const { chromium } = createRequire(path.join(openclast, 'experimental/browser-native/package.json'))('playwright');
const outDir = path.resolve(process.argv[2] ?? path.join(pluginRoot, '../../.workspace/phone-step'));
const useN0 = process.env.CYBERBASER_IROH_RELAY_TEST === '1';
const tag = useN0 ? 'n0' : 'loopback';
const port = Number(process.env.PHONE_STEP_PORT ?? 47611);
const vault = path.join(here, 'vault');
const dist = path.join(pluginRoot, 'dist');

const children = [];
function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  children.push(child);
  child.stderr.on('data', (chunk) => process.stderr.write(`[${path.basename(args[0] ?? command)}] ${chunk}`));
  return child;
}
function firstLine(child, ms = 180_000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error('timed out waiting for first line')), ms);
    lines.once('line', (line) => { clearTimeout(timer); resolve(line); });
    child.once('exit', (code) => reject(new Error(`exited ${code} before printing`)));
  });
}
const now = () => performance.now();
// Read a QR from a PNG screenshot with an independent decoder (jsQR, a dev
// dependency of the node app) after ImageMagick turns it into RGBA pixels.
const jsQR = createRequire(path.join(pluginRoot, '../owner-alpha/package.json'))('jsqr');
function decodePng(file) {
  const size = execFileSync('magick', ['identify', '-format', '%w %h', file], { encoding: 'utf8' }).split(' ').map(Number);
  const pixels = execFileSync('magick', [file, '-depth', '8', 'rgba:-'], { maxBuffer: 1 << 27 });
  return jsQR(new Uint8ClampedArray(pixels), size[0], size[1])?.data ?? null;
}

const record = { schema: 'cyberbaser.phone-step.v1', relay: tag, startedAt: new Date().toISOString(),
  build: {}, fixture: {}, steps: [], assertions: [], timings: {}, screenshots: [] };
function step(name, detail = {}) { record.steps.push({ name, at: new Date().toISOString(), ...detail }); console.error(`step: ${name}`); }
function assert(name, ok, detail = {}) {
  record.assertions.push({ name, ok: Boolean(ok), ...detail });
  if (!ok) throw new Error(`assertion failed: ${name} ${JSON.stringify(detail)}`);
}

async function main() {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
  record.build = { mainJs: { bytes: (await readFile(path.join(dist, 'main.js'))).length, sha256: await sha(path.join(dist, 'main.js')) },
    wasm: { bytes: (await readFile(path.join(pluginRoot, 'carrier/target/browser/carrier_bg.wasm'))).length,
      sha256: await sha(path.join(pluginRoot, 'carrier/target/browser/carrier_bg.wasm')) },
    manifest: JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8')) };
  const workspaceText = await readFile(path.join(vault, 'workspace-note.md'), 'utf8');
  record.fixture = { vault: 'apps/obsidian-cyberbaser/test/harness/vault (one synthetic note)', note: 'workspace-note.md',
    node: 'disposable owner node: synthetic Git vault, local bare remote, simulated build/deploy/live confirmation' };

  // 1. Relay and node.
  let relay = 'n0';
  if (!useN0) {
    const child = start(path.join(pluginRoot, 'carrier/target/release/loopback-relay'), []);
    relay = JSON.parse(await firstLine(child)).relay;
  }
  step('relay ready', { relay: useN0 ? 'n0 public relay' : relay });
  const nodeChild = start('bun', [path.join(here, 'node-fixture.js'), relay, String(port), path.join(vault, 'workspace-note.md')], { cwd: pluginRoot });
  const node = JSON.parse(await firstLine(nodeChild));
  step('owner node ready', { ownerOrigin: node.ownerOrigin });

  // Owner session (the owner's browser on the node's own loopback page).
  const login = await fetch(node.signInUrl, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const owner = (route, body) => fetch(`${node.ownerOrigin}${route}`, { redirect: 'error',
    headers: { Cookie: cookie, Origin: node.ownerOrigin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const csrf = (await (await owner('/owner/devices')).text()).match(/data-csrf="([^"]+)"/u)[1];

  // 2. Harness session with the built plugin.
  const manifestFile = path.join(outDir, `harness-session-${tag}-${Date.now()}.json`);
  const harness = start('node', [harnessCli, 'session', '--plugin', dist, '--vault', vault, '--emulate-mobile',
    '--max-minutes', '15', '--manifest-out', manifestFile], { cwd: openclast });
  const session = JSON.parse(await firstLine(harness));
  step('harness session ready', { schema: session.schema, runId: session.runId });
  const browser = await chromium.connectOverCDP(session.cdpEndpoint);
  try {
    const context = browser.contexts()[0];
    const page = context.pages().find((candidate) => candidate.url().startsWith(session.url.split('#')[0].replace(/\/[^/]*$/u, ''))) ?? context.pages()[0];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.app?.plugins?.plugins?.cyberbaser, null, { timeout: 60_000 });
    assert('plugin loaded and enabled', await page.evaluate(() => Boolean(app.plugins.plugins.cyberbaser)));
    assert('Obsidian mobile emulation on', await page.evaluate(() => app.isMobile === true || document.body.classList.contains('is-mobile')));
    const shot = async (name, target = page, fullPage = false) => {
      const file = path.join(outDir, `${tag}-${name}.png`);
      await target.screenshot({ path: file, fullPage });
      record.screenshots.push(path.relative(path.resolve(pluginRoot, '../..'), file));
    };
    await page.evaluate(async (notePath) => {
      const file = app.vault.getAbstractFileByPath(notePath);
      await app.workspace.getLeaf(false).openFile(file, { state: { mode: 'source' } });
    }, node.deliveryPath);
    step('note opened', { path: node.deliveryPath });

    // 3. Pair from the node's Devices page: the owner starts a phone pairing
    //    and the page shows the QR. The QR is decoded from the screenshot and
    //    its obsidian:// link is opened the way the OS hands it to Obsidian.
    const ownerPage = await context.newPage();
    await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: node.ownerOrigin }]);
    await ownerPage.setViewportSize({ width: 1280, height: 900 });
    await ownerPage.goto(`${node.ownerOrigin}/owner/devices`);
    await ownerPage.click('label.segment:has(input[value="owner-device"])');
    await ownerPage.click('label.segment:has(input[value="full"])');
    await ownerPage.fill('#pair-label', 'Test phone');
    await ownerPage.click('#pair-form button[type="submit"]');
    await ownerPage.waitForSelector('svg.pair-qr', { timeout: 10_000 });
    await shot('devices-qr-1280', ownerPage);
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await shot('devices-qr-390', ownerPage, true);
    const qrPng = path.join(outDir, `${tag}-qr-element.png`);
    await ownerPage.locator('svg.pair-qr').screenshot({ path: qrPng });
    const link = decodePng(qrPng);
    const code = (await ownerPage.textContent('.pair-code')).trim();
    assert('the QR on the Devices page decodes to the pairing link', link === `obsidian://cyberbaser-pair?code=${encodeURIComponent(code)}`, { link });
    const opened = await page.evaluate((url) => {
      const parsed = new URL(url);
      const params = { action: parsed.host, ...Object.fromEntries(parsed.searchParams) };
      if (typeof window.OBS_ACT === 'function') { window.OBS_ACT(params); return 'OBS_ACT'; }
      const handler = app.workspace.protocolHandlers?.get(parsed.host);
      if (!handler) return null;
      handler(params);
      return 'protocolHandlers';
    }, link);
    assert('Obsidian accepted the obsidian:// pairing link', opened !== null, { opened });
    await page.waitForSelector('.cyberbaser-code', { timeout: 10_000 });
    assert('the link opened pairing with the code filled in', (await page.inputValue('.cyberbaser-code')) === code);
    record.pairingLinkPath = opened;
    let t = now();
    await page.click('.cyberbaser-pair-button');
    await page.waitForSelector('.cyberbaser-word-list', { timeout: 60_000 });
    record.timings.codeToWordsMs = Math.round(now() - t);
    const phoneWords = (await page.textContent('.cyberbaser-word-list')).split(' · ');
    const state = await (await owner('/owner/devices/state')).json();
    const pending = state.pairings.find((item) => item.state === 'awaiting');
    assert('phone and node show the same four words', pending?.words.join(' ') === phoneWords.join(' '), { phoneWords, nodeWords: pending?.words });
    assert('nothing enrolled before Confirm', !state.devices.some((device) => device.label === 'Test phone'));
    await shot('1-pairing-words');
    await ownerPage.waitForSelector('.pair-words', { timeout: 10_000 });
    await shot('1b-node-devices-words', ownerPage);
    t = now();
    await ownerPage.click('.pair-live button:not(.quiet)'); // Confirm
    await page.waitForFunction(() => document.querySelector('.cyberbaser-message')?.textContent.startsWith('Paired.'), null, { timeout: 30_000 });
    record.timings.confirmToPairedMs = Math.round(now() - t);
    await shot('2-paired');
    const devices = (await (await owner('/owner/devices/state')).json()).devices;
    assert('device enrolled with full grants', devices.some((device) => device.label === 'Test phone' && device.grants.includes('publish')));
    const synced = await page.evaluate(async () => JSON.stringify(await app.plugins.plugins.cyberbaser.loadData()));
    assert('synced plugin data holds no pairing', synced === '{"showMark":true}' || synced === 'null', { synced });
    const stored = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('cyberbaser-device', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const keys = await new Promise((resolve) => { const r = db.transaction('pairings').objectStore('pairings').getAll(); r.onsuccess = () => resolve(r.result); });
      return keys.map((entry) => ({ keyId: entry.keyId, extractable: entry.privateKey.extractable, secretBytes: entry.irohSecret.length }));
    });
    assert('pairing kept in device IndexedDB with a non-extractable key', stored.length === 1 && stored[0].extractable === false && stored[0].secretBytes === 32, { stored });
    await page.click('.cyberbaser-pair-button'); // Done
    await page.waitForSelector('.cyberbaser-modal', { state: 'detached', timeout: 10_000 });

    // 4. Quiet status: nothing on the note; the full status on demand.
    const mark = () => page.evaluate(() => document.querySelector('.view-action.cyberbaser-mark')?.dataset.status ?? null);
    const statusKey = () => page.evaluate(async () => (await app.plugins.plugins.cyberbaser.refreshStatus(true, { force: true })).status.key);
    t = now();
    assert('first status is public, not confirmed', await statusKey() === 'pending');
    record.timings.statusMs = Math.round(now() - t);
    assert('no mark while there is nothing to act on', await mark() === null);
    await page.evaluate(() => app.commands.executeCommandById('cyberbaser:status'));
    await page.waitForFunction(() => document.querySelector('.cyberbaser-status-sentence')?.textContent === 'Public, not confirmed yet', null, { timeout: 30_000 });
    await shot('3-status-on-demand');

    // 5. Publish: the node has not linked this note yet, so it asks the owner.
    await page.click('text=Send or publish…');
    await page.waitForSelector('text=Publish to your site', { timeout: 30_000 });
    await page.click('text=Publish to your site');
    await page.waitForFunction(() => document.querySelector('.cyberbaser-result')?.textContent.includes('open Devices and link it'), null, { timeout: 60_000 });
    await shot('4-needs-linking');
    await page.click('.cyberbaser-modal .modal-close-button');
    await ownerPage.setViewportSize({ width: 1280, height: 900 });
    await ownerPage.goto(`${node.ownerOrigin}/owner/devices`);
    await ownerPage.waitForSelector('#link-notes:not([hidden]) .link-row', { timeout: 15_000 });
    await shot('link-step-1280', ownerPage, true);
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await ownerPage.locator('#link-notes').scrollIntoViewIfNeeded();
    await shot('link-step-390', ownerPage, true);
    await ownerPage.click('.link-row button:not(.quiet)'); // Link
    await ownerPage.waitForFunction(() => document.querySelector('.link-result')?.textContent.startsWith('Linked.'), null, { timeout: 30_000 });
    await shot('link-step-linked-390', ownerPage, true);
    // The node's workspace copy receives the phone's text (as a sync would).
    nodeChild.stdin.write('sync\n');
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 6. Publish again until the node confirms it live; still no mark.
    await page.evaluate(() => app.commands.executeCommandById('cyberbaser:send'));
    await page.waitForSelector('text=Publish to your site', { timeout: 30_000 });
    t = now();
    await page.click('text=Publish to your site');
    await page.waitForFunction(() => document.querySelector('.cyberbaser-result')?.textContent.startsWith('Publishing.'), null, { timeout: 60_000 });
    await shot('5-publishing');
    await page.click('.cyberbaser-modal .modal-close-button');
    const deadline = Date.now() + 150_000;
    while (await statusKey() !== 'live') {
      if (Date.now() > deadline) throw new Error('not live in time');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    record.timings.publishToLiveMs = Math.round(now() - t);
    assert('a live, unchanged note shows no mark', await mark() === null);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((dark) => { document.body.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-light', !dark); }, theme === 'dark');
      await shot(`6-live-unchanged-nothing-${theme}`);
    }
    await page.evaluate(() => app.commands.executeCommandById('cyberbaser:status'));
    await page.waitForFunction(() => document.querySelector('.cyberbaser-status-sentence')?.textContent.startsWith('Live'), null, { timeout: 30_000 });
    record.liveSentence = await page.textContent('.cyberbaser-status-sentence');
    assert('on-demand status says when it went live', record.liveSentence.startsWith('Live. Confirmed on your site '), { sentence: record.liveSentence });
    await shot('7-status-on-demand-live-dark');
    await page.click('.cyberbaser-modal .modal-close-button');

    // 7. One-word change: the quiet mark appears; tap it to send for review.
    await page.evaluate(() => {
      const editor = app.workspace.activeLeaf.view.editor;
      editor.setValue(editor.getValue().replace('red folder', 'yellow folder'));
    });
    await page.waitForFunction(() => document.querySelector('.view-action.cyberbaser-mark')?.dataset.status === 'older', null, { timeout: 30_000 });
    record.markLabel = await page.getAttribute('.view-action.cyberbaser-mark', 'aria-label');
    for (const theme of ['dark', 'light']) {
      await page.evaluate((dark) => { document.body.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-light', !dark); }, theme === 'dark');
      await shot(`8-unsent-changes-mark-${theme}`);
    }
    await page.click('.view-action.cyberbaser-mark');
    await page.waitForSelector('text=Send for review', { timeout: 30_000 });
    t = now();
    await page.click('text=Send for review');
    await page.waitForFunction(() => document.querySelector('.cyberbaser-result')?.textContent.startsWith('Sent for review.'), null, { timeout: 60_000 });
    record.timings.sendForReviewMs = Math.round(now() - t);
    await shot('9-send-result');
    const inbox = await (await owner('/api/review')).json();
    const item = inbox.actionable.find(({ summary }) => summary.submitter?.label === 'Test phone');
    assert('the change is in the owner Proposals inbox from the phone', Boolean(item), { submitters: inbox.actionable.map(({ summary }) => summary.submitter?.label) });
    record.result = 'passed';
  } catch (error) {
    record.pageAtFailure = await browser.contexts()[0]?.pages()[0]?.evaluate(() => ({
      result: document.querySelector('.cyberbaser-result')?.textContent ?? null,
      message: document.querySelector('.cyberbaser-message')?.textContent ?? null,
      mark: document.querySelector('.view-action.cyberbaser-mark')?.dataset.status ?? null,
    })).catch(() => null);
    await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(outDir, `${tag}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await browser.close().catch(() => {});
    harness.kill('SIGTERM');
    await new Promise((resolve) => { harness.once('exit', resolve); setTimeout(resolve, 20_000); });
    nodeChild.stdin.end();
    await new Promise((resolve) => { nodeChild.once('exit', resolve); setTimeout(resolve, 60_000); });
  }
}

try {
  await main();
} catch (error) {
  record.result = 'failed';
  record.error = String(error?.message ?? error);
  process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  record.finishedAt = new Date().toISOString();
  await writeFile(path.join(outDir, `record-${tag}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ result: record.result, error: record.error ?? null, timings: record.timings }));
}
