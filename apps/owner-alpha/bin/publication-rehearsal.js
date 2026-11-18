#!/usr/bin/env bun
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicationRehearsal } from './publication-rehearsal-fixture.js';

export function rehearsalOptions(environment = process.env) {
  const port = Number(environment.CYBERBASER_PUBLICATION_REHEARSAL_PORT ?? 46327);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65534) throw new TypeError('rehearsal port must be 1024 through 65534');
  const noOpen = environment.CYBERBASER_PUBLICATION_REHEARSAL_NO_OPEN;
  if (noOpen !== undefined && !['0', '1'].includes(noOpen)) throw new TypeError('rehearsal NO_OPEN must be 0 or 1');
  return { port, openBrowser: noOpen !== '1' };
}

/** Human-invoked launcher only. Automated rehearsal imports the fixture directly
 * and uses its own fresh headless Playwright context. No tokens reach stdout. */
export async function runPublicationRehearsalLauncher() {
  const options = rehearsalOptions();
  const fixture = await createPublicationRehearsal({ port: options.port });
  let browser; let opening = false; let stopping = false;
  let disposeInput = () => {};
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    await browser?.close().catch(() => {});
    try {
      await fixture.cleanup();
      disposeInput();
      process.stdout.write('Synthetic publication rehearsal stopped; owned listeners and temporary repositories removed.\n');
      process.exit(code);
    } catch {
      process.stderr.write(`Synthetic rehearsal cleanup could not finish; no shared paths were removed. Owned temporary directory retained: ${fixture.root}\n`);
      stopping = false;
      process.exitCode = 1;
    }
  };
  async function openSignIn() {
    if (opening || stopping) return;
    opening = true;
    try {
      if (!browser) {
        const installed = path.resolve(import.meta.dir, '../../../docs/node_modules/playwright/index.js');
        const { chromium } = await import(pathToFileURL(installed).href);
        // New ephemeral Chromium profile and nonpersistent context. Never CDP,
        // a persistent userDataDir, a main browser profile, or a live origin.
        browser = await chromium.launch({ headless: false });
      }
      const context = await browser.newContext({ viewport: null });
      await context.route('**/*', (route) => [fixture.ownerOrigin, fixture.readerOrigin].includes(new URL(route.request().url()).origin)
        ? route.continue() : route.abort());
      const page = await context.newPage();
      // Reuse the real one-time bootstrap route. Capability stays in memory.
      await page.goto(fixture.issueSignInUrl());
      await page.waitForURL(fixture.panelUrl);
    } finally { opening = false; }
  }
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8'); process.stdin.resume();
    const onData = (chunk) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (line.trim().toLowerCase() === 'q') void stop();
        if (line.trim().toLowerCase() === 'b') void openSignIn().catch(() => {
          process.stderr.write('Fresh-context sign-in could not open. No authentication capability was printed or saved.\n');
        });
      }
    };
    process.stdin.on('data', onData);
    disposeInput = () => { process.stdin.off('data', onData); process.stdin.pause(); };
  }
  process.stdout.write(`${fixture.label}\n`);
  process.stdout.write(`Synthetic publication panel: ${fixture.panelUrl}\n`);
  process.stdout.write(`Stop and clean up: Ctrl-C, q then Enter, or kill -TERM ${process.pid}\n`);
  if (process.stdin.isTTY) process.stdout.write('Enter b to open a fresh isolated browser sign-in.\n');
  if (options.openBrowser) {
    try { await openSignIn(); }
    catch { process.stderr.write('Isolated browser launch failed. No browser install/download was attempted.\n'); await stop(1); }
  }
  await new Promise(() => {});
}

if (import.meta.main) {
  runPublicationRehearsalLauncher().catch(() => {
    // Never print raw Playwright errors, which can contain bootstrap URLs.
    process.stderr.write('Synthetic publication rehearsal could not start.\n');
    process.exitCode = 1;
  });
}
