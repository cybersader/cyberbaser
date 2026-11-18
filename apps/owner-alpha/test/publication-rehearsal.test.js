import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/json.js';
import { publicationDisplay } from '../src/publication-display.js';
import { capturePublicationResponse } from './publication-response-capture.js';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPublicationRehearsal, REHEARSAL_BASE, REHEARSAL_CANDIDATE, REHEARSAL_LABEL,
} from '../bin/publication-rehearsal-fixture.js';
import { rehearsalOptions } from '../bin/publication-rehearsal.js';
import { safeCheckpoints, safeDirectiveCounts, installCspCounter, colourlessScope, observeRestoration, checkpointFailureClass, recordRehearsalOwnership } from './publication-rehearsal-harness.js';

const owned = [];
afterEach(async () => { await Promise.all(owned.splice(0).map((fixture) => fixture.cleanup())); });
function memoryServers() {
  const calls = [];
  const serve = (options) => { const call = { ...options, stops: 0 }; calls.push(call); return { stop() { call.stops += 1; } }; };
  return { serve, calls };
}
function localRequest(fixture, url, cookie) {
  return new Request(url, { headers: { Host: new URL(fixture.ownerOrigin).host, ...(cookie ? { Cookie: cookie } : {}) } });
}

test('setup creates an isolated clean delivery repo, matching local bare remote and empty ignored private store', async () => {
  const server = memoryServers(); const fixture = await createPublicationRehearsal({ port: 46327, serve: server.serve }); owned.push(fixture);
  expect(server.calls.map(({ hostname, port }) => ({ hostname, port }))).toEqual([{ hostname: '127.0.0.1', port: 46327 }, { hostname: '127.0.0.1', port: 46328 }]);
  expect(await fixture.inspectDelivery()).toBe(REHEARSAL_BASE);
  expect(REHEARSAL_CANDIDATE).toBe(REHEARSAL_BASE.replace('twelve printed copies', 'eighteen printed copies').replace('sixty minutes', 'forty minutes'));
  expect(await fixture.readStatus()).toBe('');
  expect(await fixture.readLocalHead()).toBe(fixture.initialCommit); expect(await fixture.readBareHead()).toBe(fixture.initialCommit);
  expect(await readdir(fixture.context.storeRoot)).toEqual([]);
  expect(fixture.readEffectCounts()).toEqual({ apply: 0, commit: 0, push: 0 });
  expect((await lstat(fixture.root)).mode & 0o777).toBe(0o700);
  expect((await readdir(fixture.projectRoot)).some((name) => name.endsWith('.json'))).toBe(false);
  expect(fixture.advanceSourceVersion()).toBe(2); expect(fixture.advanceSourceVersion()).toBe(3);
  // Normal bootstrap/authenticated handler, exercised in memory, not a browser or
  // publication rehearsal. Never assert or log the actual capability/cookie.
  const ownerFetch = server.calls[0].fetch;
  expect((await ownerFetch(localRequest(fixture, fixture.panelUrl))).status).toBe(403);
  const bootstrap = await ownerFetch(localRequest(fixture, fixture.issueSignInUrl()));
  expect(bootstrap.status).toBe(303);
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]; expect(Boolean(cookie)).toBe(true);
  const page = await ownerFetch(localRequest(fixture, fixture.panelUrl, cookie));
  expect(page.status).toBe(200); const html = await page.text();
  expect(html.includes(REHEARSAL_LABEL)).toBe(true); expect(html.includes('Review changes')).toBe(true);
  expect(html).toContain('No public-site effects.'); expect(html).toContain('class="rehearsal-notice"');
  expect(existsSync(path.join(fixture.context.storeRoot, 'jobs'))).toBe(false);
});

test('full-page variations use real preparation, labelled fallback and fixture-only finite policy refusal', async () => {
  for (const variation of ['small', 'dispersed', 'broad', 'table', 'coarse', 'overPolicy', 'sourceOnly', 'removedBlock', 'addedBlock', 'formatted']) {
    const server = memoryServers(); const fixture = await createPublicationRehearsal({ port: 46500, serve: server.serve, variation }); owned.push(fixture);
    const fetch = server.calls[0].fetch;
    const bootstrap = await fetch(localRequest(fixture, fixture.issueSignInUrl())); const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const landing = await (await fetch(localRequest(fixture, fixture.panelUrl, cookie))).text();
    const csrf = /data-csrf="([^"]+)"/u.exec(landing)[1];
    const prepared = await fetch(new Request(`${fixture.ownerOrigin}/api/publication/prepare`, { method: 'POST',
      headers: { Host: new URL(fixture.ownerOrigin).host, Cookie: cookie, Origin: fixture.ownerOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mappingId: 'synthetic-page', csrf }) }));
    if (variation === 'overPolicy') { expect(prepared.status).toBe(409); }
    else {
      expect(prepared.status, variation).toBe(201); const result = await prepared.json();
      const html = await (await fetch(localRequest(fixture, `${fixture.ownerOrigin}${result.reviewUrl}`, cookie))).text();
      expect(html).toContain('aria-label="Proposed document"'); expect(html).toContain('Publish this version?');
      expect(html).not.toContain('class="mode-tab'); expect(html).not.toContain('class="publication-publish-region"');
      expect(html).toContain('not rendered in this structural review'); expect(html).toContain('Hand tools');
      expect(html).toContain('End of the synthetic handbook.'); expect(html).toContain('type="submit">Publish');
      if (['broad', 'coarse'].includes(variation)) {
        expect(html).toContain('Whole-document review'); expect(html).not.toContain('id="publication-next-change"');
        expect(html).not.toContain('data-change=');
      } else expect((html.match(/data-change=/gu) ?? []).length).toBe(variation === 'dispersed' ? 2 : 1);
      if (['small', 'dispersed'].includes(variation)) {
        expect(html).toContain('<del class="publication-del" aria-label="Removed">twelve</del>');
        expect(html).toContain('<ins class="publication-ins" aria-label="Added">eighteen</ins>');
        expect(html).not.toContain('publication-previous-fragment');
        if (variation === 'dispersed') {
          expect(html).toContain('<del class="publication-del" aria-label="Removed">sixty</del>');
          expect(html).toContain('<ins class="publication-ins" aria-label="Added">forty</ins>');
        }
      }
      if (['table', 'sourceOnly'].includes(variation)) {
        expect(html).toContain('<details class="publication-previous-fragment">');
        expect(html).toContain('aria-label="Previous exact source for change 1"');
        expect(html).toContain(' Previous</summary>');
        const previous = /<details class="publication-previous-fragment">[\s\S]*?<pre>([\s\S]*?)<\/pre><\/details>/u.exec(html)?.[1];
        expect(previous).toContain(variation === 'table' ? '| Hand tools | 12 |' : '```text');
        expect(html).toContain('<summary>Pinned repository version</summary>');
        expect(html).toContain('<summary>Exact source and review details</summary>');
        expect(html).toContain('Pinned repository version · exact source');
        expect(html).toContain('Entire proposed version · exact source');
      }
      if (variation === 'sourceOnly') expect(html).toContain('Source/formatting changed');
      if (variation === 'removedBlock') expect(html).toContain('publication-deleted-block');
      if (variation === 'table') expect(html).toContain('| Hand tools | 16 |');
      if (variation === 'coarse') expect(html).toContain('Sample 1499: checked');
    }
    expect(fixture.readEffectCounts()).toEqual({ apply: 0, commit: 0, push: 0 });
    await fixture.cleanup();
  }
}, 30000);

test('cleanup stops only owned fixture servers, removes only its captured temp root and is idempotent', async () => {
  const server = memoryServers(); const fixture = await createPublicationRehearsal({ port: 46329, serve: server.serve }); owned.push(fixture);
  const root = fixture.root;
  await fixture.cleanup(); await fixture.cleanup();
  expect(server.calls.map((item) => item.stops)).toEqual([1, 1]); expect(existsSync(root)).toBe(false);
  await expect(fixture.readLocalHead()).rejects.toThrow('rehearsal Git containment refused');
  expect(() => fixture.advanceSourceVersion()).toThrow('synthetic source closed');
});

test('startup failure cleans its own new temp directory and closes a partially started owner listener', async () => {
  const prefix = 'owner-publication-rehearsal-';
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith(prefix)));
  let calls = 0; let stops = 0;
  await expect(createPublicationRehearsal({ port: 46331, serve: () => {
    calls += 1; if (calls === 2) throw new Error('synthetic-reader-bind-refused');
    return { stop() { stops += 1; } };
  } })).rejects.toThrow('synthetic-reader-bind-refused');
  expect(stops).toBe(1);
  const added = (await readdir(os.tmpdir())).filter((name) => name.startsWith(prefix) && !before.has(name)); expect(added).toEqual([]);
});

test('launcher options validate bounded loopback ports without opening any browser or server on import', async () => {
  expect(rehearsalOptions({})).toEqual({ port: 46327, openBrowser: true });
  expect(rehearsalOptions({ CYBERBASER_PUBLICATION_REHEARSAL_PORT: '46400', CYBERBASER_PUBLICATION_REHEARSAL_NO_OPEN: '1' })).toEqual({ port: 46400, openBrowser: false });
  for (const port of ['0', '1023', '65535', '12.5', 'not-a-number']) expect(() => rehearsalOptions({ CYBERBASER_PUBLICATION_REHEARSAL_PORT: port })).toThrow();
  expect(() => rehearsalOptions({ CYBERBASER_PUBLICATION_REHEARSAL_NO_OPEN: 'yes' })).toThrow();
  await expect(createPublicationRehearsal({ port: 0 })).rejects.toThrow('rehearsal port');
});

test('human launcher uses the native window viewport while retaining isolated sign-in containment', async () => {
  const launcher = await readFile(new URL('../bin/publication-rehearsal.js', import.meta.url), 'utf8');
  expect(launcher).toContain('const context = await browser.newContext({ viewport: null });');
  expect(launcher.match(/browser\.newContext\(/gu)).toHaveLength(1);
  expect(launcher).not.toContain('setViewportSize');
  expect(launcher).not.toContain('launchPersistentContext');
  expect(launcher).toContain("browser = await chromium.launch({ headless: false });");
  expect(launcher).toContain("await context.route('**/*', (route) => [fixture.ownerOrigin, fixture.readerOrigin].includes(new URL(route.request().url()).origin)");
  expect(launcher).toContain('? route.continue() : route.abort());');
  expect(launcher).toContain('await page.goto(fixture.issueSignInUrl());');
});

// Root must relay the runtime review verdict before enabling this test. It is
// prepared, not part of the setup/lifecycle gate, and never downloads a browser.
const browserTest = process.env.OWNER_ALPHA_PUBLICATION_REHEARSAL_BROWSER === '1' ? test : test.skip;
browserTest('headless browser rehearsal uses actual publication routes and real local-only Git effects', async () => {
  let fixture; let browser; let releaseProgressPolls; let stage = 'setup';
  const evidence = { synthetic: true, outcome: 'not-completed',
    potentialCapabilities: ['disposable local source application', 'local commit', 'local-bare push'],
    attemptedEffects: { apply: 0, commit: 0, push: 0 }, achievedEffects: { baselineCommit: 0, baselineLocalBarePush: 0,
      publicationSourceApplied: false, publicationCommitCount: 0, publicationLocalBarePushCount: 0 },
    prepareHttpStatus: null, prepareSafeErrorCode: null, publishHttpStatus: null, publishSafeErrorCode: null,
    simulated: ['renderer/preapply', 'deployment discovery/monitor', 'live confirmation', 'local rebuild'] };
  const captureDir = process.env.OWNER_ALPHA_PUBLICATION_REHEARSAL_CAPTURE_DIR;
  if (!captureDir || !path.isAbsolute(captureDir)) throw new Error('explicit absolute test-only rehearsal output directory required');
  // Refuse reuse, even for a prior failed run. Original receipts/screenshots are
  // never opened for writing by this diagnostics-only retry.
  await mkdir(captureDir, { mode: 0o700 });
  let diagnosticPage; let diagnosticGeneration = 0;
  const directiveDocuments = new Map();
  Object.assign(evidence, { securityPolicyViolationDirectives: safeDirectiveCounts(), cspDiagnosticsReadable: false,
    cssomColourRemovalApplied: false, cssomColourRemovalRestored: null, cssomRestorationEvaluateCompleted: false,
    cssomRestorationClauses: null, inlineStyleInjectionAttempted: false,
    marksVisibleAfterNavigation: false, toggleAriaPressedAfterNavigation: false,
    changeCountAnnouncementPresent: false, focusedAnchorVisibleAtFocusTime: false });
  const persist = async () => {
    if (diagnosticPage && !diagnosticPage.isClosed()) {
      try {
        const values = await diagnosticPage.evaluate(() => globalThis.__publicationRehearsalCspCounts ?? {});
        directiveDocuments.set(diagnosticGeneration, safeDirectiveCounts(values));
        const totals = safeDirectiveCounts();
        for (const counts of directiveDocuments.values()) for (const name of Object.keys(totals)) totals[name] = Math.min(1000, totals[name] + counts[name]);
        evidence.securityPolicyViolationDirectives = totals; evidence.cspDiagnosticsReadable = true;
      } catch { evidence.cspDiagnosticsReadable = false; } // Navigation/closure may prevent a diagnostic read; never serialize its error.
    }
    evidence.stage = stage;
    await writeFile(path.join(captureDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  };
  const checkpoint = safeCheckpoints(evidence, persist);
  const publicErrorCodes = new Set(['publication-prepare-failed', 'publication-publish-refused', 'publication-disabled',
    'invalid-host', 'invalid-session', 'invalid-origin', 'invalid-csrf', 'invalid-publication-body', 'invalid-publication-query',
    'publication-review-unavailable', 'invalid-json']);
  const recordHttp = async (captured, name) => {
    evidence[`${name}HttpStatus`] = captured.status;
    evidence[`${name}BodyReadSucceeded`] = captured.bodyReadSucceeded;
    evidence[`${name}LocalClassification`] = captured.classification;
    const code = captured.body?.error?.code;
    evidence[`${name}SafeErrorCode`] = captured.bodyReadSucceeded && code === undefined && captured.status < 400 ? null
      : typeof code === 'string' && publicErrorCodes.has(code) ? code : 'redacted-unknown';
    evidence.diagnosticSubstage = captured.bodyReadSucceeded ? `${name}-response-captured` : `${name}-response-capture-failed`;
    await persist();
    if (!captured.bodyReadSucceeded) throw new Error('rehearsal-response-capture-failed');
    return captured.body; // Existing success assertions use this only in memory.
  };
  const recordNavigatingStatus = async (status, name) => {
    evidence[`${name}HttpStatus`] = status;
    evidence[`${name}ResponseBodyNotReadReason`] = 'navigation-safe-durable-binding';
    evidence.diagnosticSubstage = `${name}-status-observed`;
    await persist();
  };
  evidence.screenshots = []; evidence.measurements = []; evidence.ownershipRecords = [];
  const capture = async (page, name, fullPage = true) => {
    const file = path.join(captureDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage }); await chmod(file, 0o600);
    evidence.screenshots.push(file);
  };
  evidence.capturePlan = 'tracked-changes-1440x900-390x844-light-dark';
  const measure = async (page, screen) => {
    const result = await page.evaluate((screen) => {
      const rect = (selector) => { const node = document.querySelector(selector); if (!node) return null;
        const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }; };
      const css = getComputedStyle(document.body);
      const luminance = (name) => { const hex = css.getPropertyValue(name).trim().slice(1); const expanded = hex.length === 3 ? [...hex].map((part) => part + part).join('') : hex;
        const rgb = [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16) / 255).map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722; };
      const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + 0.05) / (values[1] + 0.05); };
      const toolbar = rect('.publication-toolbar'); const scroller = rect('.publication-document-scroll');
      const anchor = document.activeElement?.matches('[data-change]') ? rect(`#${document.activeElement.id}`) : null;
      return { screen, width: innerWidth, height: innerHeight, colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        toolbar, scroller, anchor, bodyContrast: contrast('--review-ink', '--review-ground'), mutedContrast: contrast('--review-muted', '--review-ground'), buttonContrast: contrast('--review-accent', '--review-sheet'), publish: rect('#publication-form button[type="submit"]'),
        scrollTop: document.querySelector('.publication-document-scroll')?.scrollTop,
        scrollHeight: document.querySelector('.publication-document-scroll')?.scrollHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        scrollerHorizontalOverflow: document.querySelector('.publication-document-scroll') ? document.querySelector('.publication-document-scroll').scrollWidth > document.querySelector('.publication-document-scroll').clientWidth : false,
        controls: [...document.querySelectorAll('.publication-toolbar button')].map((node) => ({ type: node.type, outsideForm: node.closest('form') === null, height: node.getBoundingClientRect().height })) };
    }, screen);
    evidence.measurements.push(result);
    expect(result.horizontalOverflow).toBe(false); expect(result.scrollerHorizontalOverflow).toBe(false);
    expect(result.bodyContrast).toBeGreaterThanOrEqual(4.5); expect(result.mutedContrast).toBeGreaterThanOrEqual(4.5); expect(result.buttonContrast).toBeGreaterThanOrEqual(4.5);
    if (result.scroller) {
      expect(result.toolbar.bottom).toBeLessThanOrEqual(result.scroller.top + 1);
      expect(result.scroller.height).toBeGreaterThan(Math.min(350, result.height / 2));
      expect(result.scroller.bottom).toBeLessThanOrEqual(result.height + 1);
      expect(result.publish.top).toBeGreaterThanOrEqual(0); expect(result.publish.bottom).toBeLessThanOrEqual(result.scroller.top);
      for (const control of result.controls) { expect(control.height).toBeGreaterThanOrEqual(44); if (control.type !== 'submit') expect(control.outsideForm).toBe(true); }
      if (result.anchor) {
        expect(result.anchor.top).toBeGreaterThanOrEqual(result.scroller.top);
        expect(result.anchor.top).toBeLessThan(result.scroller.bottom - 40);
        expect(result.anchor.bottom).toBeGreaterThan(result.scroller.top + 40);
      }
    }
    return result;
  };
  evidence.detailsChecks = [];
  const detailsCheck = async (page, width, height, colorScheme) => {
    const sheet = page.locator('#publication-details-dialog');
    const opener = page.getByRole('button', { name: 'Details', exact: true });
    const scroller = page.locator('#publication-document-scroll');
    const record = { width, height, colorScheme }; evidence.detailsChecks.push(record);
    await scroller.evaluate((node) => { node.scrollTop = 400; });
    const before = await scroller.evaluate((node) => node.scrollTop);
    await checkpoint('details-open', async () => {
      await opener.focus(); await page.keyboard.press('Enter'); await sheet.waitFor({ state: 'visible' });
      Object.assign(record, await sheet.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return { modal: node.matches(':modal'), focusOnClose: document.activeElement?.id === 'publication-close-details',
          rightAligned: Math.abs(box.right - innerWidth) <= 1, fullHeight: Math.abs(box.height - innerHeight) <= 1,
          responsiveWidth: innerWidth <= 640 ? Math.abs(box.width - innerWidth) <= 1 : box.width < innerWidth,
          noPageOverflow: document.documentElement.scrollWidth <= innerWidth,
          comparisonStacked: getComputedStyle(node.querySelector('.proof-grid')).gridTemplateColumns.split(' ').length === 1 };
      }));
      record.scrollPreservedOnOpen = await scroller.evaluate((node) => node.scrollTop) === before;
      expect(Object.values(record).filter((value) => typeof value === 'boolean').every(Boolean)).toBe(true);
      expect(await opener.getAttribute('aria-expanded')).toBe('true');
      expect(await page.locator('#publication-dialog').isVisible()).toBe(false);
      await capture(page, `details-${width}x${height}-${colorScheme}`, false);
    });
    await checkpoint('details-focus', async () => {
      await page.keyboard.press('Shift+Tab');
      record.reverseWrap = await sheet.evaluate((node) => {
        const stops = [...node.querySelectorAll('button, [href], summary, [tabindex]:not([tabindex="-1"])')].filter((part) => !part.disabled && part.getClientRects().length);
        return document.activeElement === stops.at(-1);
      });
      expect(record.reverseWrap).toBe(true);
      await page.keyboard.press('Tab');
      record.forwardWrap = await page.locator('#publication-close-details').evaluate((node) => node === document.activeElement);
      expect(record.forwardWrap).toBe(true);
      let contained = true;
      for (let index = 0; index < 8; index += 1) {
        await page.keyboard.press('Tab'); contained &&= await sheet.evaluate((node) => node.contains(document.activeElement));
      }
      record.focusContained = contained; expect(contained).toBe(true);
      await page.locator('#publication-close-details').focus();
    });
    await checkpoint('details-resize', async () => {
      await page.setViewportSize({ width: width === 390 ? 1440 : 390, height });
      record.openAfterResize = await sheet.evaluate((node) => node.open && node.matches(':modal'));
      record.focusAfterResize = await page.locator('#publication-close-details').evaluate((node) => node === document.activeElement);
      expect(record.openAfterResize).toBe(true); expect(record.focusAfterResize).toBe(true);
      await page.setViewportSize({ width, height });
    });
    await checkpoint('details-close', async () => {
      if (height === 600) await page.getByRole('button', { name: 'Close details', exact: true }).click();
      else await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'hidden' });
      // Native close/focus restoration precede the queued close listener.
      // Observe that listener's state before asserting focus and saved scroll.
      record.closeStateWaitCompleted = false;
      try {
        await page.waitForFunction(() => document.querySelector('#publication-toggle-details')?.getAttribute('aria-expanded') === 'false', null, { timeout: 5000 });
        record.closeStateWaitCompleted = true;
      } catch {
        let expanded;
        try { expanded = await opener.getAttribute('aria-expanded', { timeout: 1000 }); } catch { /* Closed diagnostic only. */ }
        record.closeStateAttribute = expanded === 'true' || expanded === 'false' ? expanded : expanded === null ? 'missing' : 'other';
        throw new Error('details-close-state-wait-failed');
      }
      record.focusReturned = await opener.evaluate((node) => node === document.activeElement);
      record.scrollPreservedOnClose = await scroller.evaluate((node) => node.scrollTop) === before;
      expect(record.focusReturned).toBe(true); expect(record.scrollPreservedOnClose).toBe(true);
      expect(await opener.getAttribute('aria-expanded')).toBe('false');
    });
  };
  const captureMatrix = async (page, screen) => {
    const viewports = screen === 'review' ? [[1440, 900], [390, 844], [1440, 600], [1440, 1100], [390, 600], [390, 1000]] : [[1440, 900], [390, 844]];
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        if (screen === 'review') {
          for (const position of ['top', 'middle', 'end']) {
            await page.locator('#publication-document-scroll').evaluate((node, position) => { node.focus({ preventScroll: true }); node.scrollTop = position === 'top' ? 0 : position === 'middle' ? (node.scrollHeight - node.clientHeight) / 2 : node.scrollHeight; }, position);
            await measure(page, `${screen}-${position}`); await capture(page, `${screen}-${position}-${width}x${height}-${colorScheme}`, false);
          }
          // Real focused navigation after each scroll position, not CSS inference.
          for (const position of ['top', 'middle', 'end']) {
            await page.locator('#publication-document-scroll').evaluate((node, position) => { node.scrollTop = position === 'top' ? 0 : position === 'middle' ? node.scrollHeight / 2 : node.scrollHeight; }, position);
            await page.getByRole('button', { name: 'Next change', exact: true }).click();
            expect(await page.locator('[data-change]:focus').count()).toBe(1);
            await measure(page, `focused-after-${position}`);
          }
          await capture(page, `focused-change-${width}x${height}-${colorScheme}`, false);
          await detailsCheck(page, width, height, colorScheme);
          if (width === 390 && height === 844) {
            const normal = await measure(page, 'before-dynamic-toolbar');
            await page.locator('#publication-status').evaluate((node) => { node.textContent = 'Display-only layout test: an expanded toolbar message must reserve its own space.'; });
            await page.getByRole('button', { name: 'Next change', exact: true }).click();
            const expanded = await measure(page, 'dynamic-toolbar-height'); expect(expanded.toolbar.height).toBeGreaterThan(normal.toolbar.height);
            await capture(page, `dynamic-toolbar-${width}-${colorScheme}`, false);
            await page.locator('#publication-status').evaluate((node) => { node.textContent = ''; });
            await page.locator('.rehearsal-notice summary').click();
            await measure(page, 'expanded-synthetic-notice'); await capture(page, `expanded-notice-${colorScheme}`, false);
            await page.locator('.rehearsal-notice summary').click();
          }
        } else {
          await measure(page, screen); await capture(page, `${screen}-${width}-${colorScheme}`, screen !== 'confirmation');
        }
        expect(await page.locator('.rehearsal-notice').textContent()).toContain(REHEARSAL_LABEL);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await page.emulateMedia({ colorScheme: 'light' });
    if (screen === 'review') await page.locator('#publication-document-scroll').evaluate((node) => { node.scrollTop = 0; });
    await persist();
  };
  const fullDocumentCapture = async (page, name) => {
    // Explicit capture-only expanded layout, separate from all actual viewport
    // measurements above. Restore immediately; this is not a scrolling proof.
    await page.evaluate(() => { document.body.style.height = 'auto'; document.body.style.overflow = 'visible'; document.querySelector('.publication-document-scroll').style.cssText = 'overflow:visible;flex:none'; document.querySelector('.publication-review-app').style.flex = 'none'; });
    await capture(page, `${name}-full-document-expanded-capture`, true);
    await page.evaluate(() => { document.body.removeAttribute('style'); document.querySelector('.publication-document-scroll').removeAttribute('style'); document.querySelector('.publication-review-app').removeAttribute('style'); });
  };
  const privateAbsent = (html) => {
    expect(html.includes('synthetic-authoring-memory')).toBe(false);
    expect(html.includes('drafts/rehearsal.md')).toBe(false);
    expect(html.includes('"reference"')).toBe(false);
  };
  try {
    fixture = await createPublicationRehearsal({ port: 46840 }); owned.push(fixture);
    evidence.achievedEffects.baselineCommit = 1; evidence.achievedEffects.baselineLocalBarePush = 1;
    evidence.ownershipRecords.push(await recordRehearsalOwnership(fixture, captureDir, 'main'));
    await persist();
    const installed = path.resolve(import.meta.dir, '../../../docs/node_modules/playwright/index.js');
    const { chromium } = await import(pathToFileURL(installed).href);
    stage = 'fresh-headless-launch'; browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', (route) => [fixture.ownerOrigin, fixture.readerOrigin].includes(new URL(route.request().url()).origin)
      ? route.continue() : route.abort());
    await context.addInitScript(installCspCounter);
    const page = await context.newPage(); let publishRequests = 0;
    diagnosticPage = page;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) diagnosticGeneration += 1; });
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/publication/publish') publishRequests += 1; });
    // No persistent profile, storageState, remote debugging or prior cookies.
    stage = 'normal-authentication'; await page.goto(fixture.issueSignInUrl()); await page.waitForURL(fixture.panelUrl);
    privateAbsent(await page.content());
    stage = 'landing-matrix'; await captureMatrix(page, 'landing');
    stage = 'prepare';
    // Status survives navigation; response BODY is deliberately not read here.
    // Route JSON shape is covered separately. Actual navigated URL selects the
    // immutable draft whose exact bindings are checked below, not a second POST.
    const prepareStatus = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/publication/prepare')
      .then((response) => response.status());
    await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    const actualPrepareStatus = await prepareStatus;
    await recordNavigatingStatus(actualPrepareStatus, 'prepare');
    expect(actualPrepareStatus).toBe(201);
    await page.waitForURL(/\/owner\/publication\/[0-9a-f]{64}$/u);
    const reviewUrl = new URL(page.url());
    expect(reviewUrl.origin).toBe(fixture.ownerOrigin); expect(reviewUrl.search).toBe(''); expect(reviewUrl.hash).toBe('');
    const reviewMatch = /^\/owner\/publication\/([0-9a-f]{64})$/u.exec(reviewUrl.pathname);
    expect(reviewMatch !== null).toBe(true);
    evidence.diagnosticSubstage = 'prepare-durable-binding';
    const draft = JSON.parse(await readFile(path.join(fixture.context.storeRoot, 'owner-publication/drafts', `${reviewMatch[1]}.json`), 'utf8'));
    const prepared = { draftId: reviewMatch[1], jobId: draft.jobId, capturedVersion: draft.prepared.reference.source.version,
      candidateDigest: draft.prepared.candidate.digest };
    expect(draft.draftId).toBe(prepared.draftId);
    const exactDigest = `sha-256=:${createHash('sha256').update(REHEARSAL_CANDIDATE).digest('base64')}:`;
    expect(prepared.candidateDigest).toBe(exactDigest);
    const candidateBytes = Buffer.from(draft.prepared.candidate.bytesBase64, 'base64');
    expect(candidateBytes.equals(Buffer.from(REHEARSAL_CANDIDATE))).toBe(true);
    expect(`sha-256=:${createHash('sha256').update(candidateBytes).digest('base64')}:`).toBe(exactDigest);
    expect(prepared.capturedVersion).toBe(1); expect(prepared.jobId).toBe(`OA-PUB-${prepared.draftId}`);
    expect(draft.prepared.reference.mapping.id).toBe('synthetic-page');
    expect(draft.prepared.reference.mapping.relativePath).toBe('rehearsal/synthetic-only.md');
    expect(createHash('sha256').update(canonicalJson(draft.prepared)).digest('hex')).toBe(prepared.draftId);
    stage = 'document-review-controls';
    await page.waitForLoadState('networkidle');
    let displayRequests = 0; const countDisplayRequest = () => { displayRequests += 1; }; page.on('request', countDisplayRequest);
    expect(await page.locator('[data-change]').count()).toBe(2);
    expect(await page.locator('article[aria-label="Proposed document"] .md-paragraph').count()).toBeGreaterThan(20);
    expect(await page.locator('article[aria-label="Proposed document"] .md-source-wrap').count()).toBe(0);
    await checkpoint('quiet-toolbar', async () => {
      expect(await page.locator('#publication-change-count').textContent()).toBe('2 changes');
      expect(await page.locator('.publication-toolbar-title').textContent()).not.toContain('Review the whole version');
      expect(await page.locator('.publication-tracked-summary').count()).toBe(0);
      const control = page.getByRole('button', { name: 'Show changes', exact: true });
      expect(await control.getAttribute('aria-pressed')).toBe('true');
      expect(await control.locator('svg[aria-hidden="true"]').count()).toBe(1);
      await control.focus(); expect(await page.locator('#publication-toggle-marks-tip').isVisible()).toBe(true);
      await page.keyboard.press('Escape'); expect(await page.locator('#publication-toggle-marks-tip').isVisible()).toBe(false);
      await page.keyboard.press('Enter'); expect(await control.getAttribute('aria-pressed')).toBe('false');
      expect(await control.getAttribute('aria-label')).toBe('Show changes');
      expect(await page.locator('#publication-toggle-marks-tip').textContent()).toBe('Changes hidden');
      await page.keyboard.press('Enter'); expect(await control.getAttribute('aria-pressed')).toBe('true');
      const next = page.locator('#publication-next-change'); await next.hover();
      const tip = page.locator('#publication-next-change-tip'); expect(await tip.isVisible()).toBe(true);
      await tip.hover(); expect(await tip.isVisible()).toBe(true);
      await page.mouse.move(1000, 500); expect(await tip.isVisible()).toBe(false);
      expect(publishRequests).toBe(0);
      evidence.quietToolbar = { compactCount: true, stableName: true, pressedState: true, svgRetained: true, keyboardTooltipEscape: true, hoverableTooltip: true };
    });
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.locator('#publication-previous-version summary').click();
    await page.locator('#publication-comparison summary').click();
    await page.locator('.technical-evidence summary').click();
    expect(await page.locator('.technical-evidence').textContent()).toContain(REHEARSAL_CANDIDATE);
    expect(publishRequests).toBe(0);
    for (const selector of ['#publication-previous-version', '#publication-comparison', '.technical-evidence']) await page.locator(`${selector} > summary`).click();
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    stage = 'inline-and-clean-reading';
    const article = page.locator('article[aria-label="Proposed document"]');
    await checkpoint('inline-text-verified', async () => {
      expect(await article.locator('ins').allTextContents()).toEqual(['eighteen', 'forty']);
      expect(await article.locator('del').allTextContents()).toEqual(['twelve', 'sixty']);
    });
    // Complete derived endpoint comparison, including metadata and unsupported
    // exact-source blocks. No source bytes or arbitrary diagnostics are removed.
    const candidateBlocks = await checkpoint('candidate-projection-derived', async () => {
      const input = { path: 'rehearsal/synthetic-only.md', baseText: REHEARSAL_BASE, candidateText: REHEARSAL_CANDIDATE,
        operation: { path: 'rehearsal/synthetic-only.md', start: 0, end: Buffer.byteLength(REHEARSAL_BASE), oldText: REHEARSAL_BASE, replacementText: REHEARSAL_CANDIDATE } };
      const blocks = publicationDisplay(input).file.proposed.blocks.filter((block) => block.kind !== 'gap');
      expect(blocks).toHaveLength(45); return blocks;
    });
    const plain = (block) => block.uninterpreted.length ? REHEARSAL_CANDIDATE.slice(block.start, block.end)
      : block.tokens ? block.tokens.map((token) => token.text).join('')
      : block.items ? block.items.map((item) => item.tokens.map((token) => token.text).join('')).join('')
      : block.kind === 'code' ? block.text : block.entries ? block.entries.map((entry) => entry.name + entry.value).join('') : '';
    await checkpoint('clean-mode-selected', async () => {
      await page.locator('#publication-toggle-marks').click();
      expect(await page.locator('.publication-review-app').getAttribute('data-marks-visible')).toBe('false');
    });
    const cleanBlocks = await checkpoint('clean-projection-read', async () => article.locator(':scope > .publication-block:not(.publication-deleted-block)').evaluateAll((nodes) => nodes.map((node) => {
      const clone = node.cloneNode(true); clone.querySelectorAll('del, .publication-change-label, .publication-margin-mark, details, .publication-source-label, .md-frontmatter > .section-kicker').forEach((part) => part.remove()); return clone.textContent;
    })));
    await checkpoint('clean-projection-verified', async () => {
      evidence.cleanProjectionComparison = { candidateBlocks: candidateBlocks.length, actualBlocks: cleanBlocks.length,
        mismatches: candidateBlocks.flatMap((block, index) => plain(block) === cleanBlocks[index] ? [] : [{ index, kind: block.kind }]) };
      expect(cleanBlocks).toEqual(candidateBlocks.map(plain));
    });
    await checkpoint('clean-deletions-hidden', async () => { expect(await article.locator('del').first().isVisible()).toBe(false); });
    await checkpoint('clean-screenshot-captured', async () => capture(page, 'clean-reading-1440-light', false));
    // Observe synchronous focusin BEFORE scrollIntoView. A target outside the
    // viewport is not hidden; CSS visibility/layout and marks mode must be ready.
    const focusObserver = await checkpoint('navigation-focus-observer-installed', async () => page.evaluateHandle(() => {
      const observations = [];
      const listener = (event) => {
        const target = event.target;
        if (!target.matches?.('[data-change]')) return;
        observations.push({ marksVisible: document.querySelector('.publication-review-app')?.dataset.marksVisible === 'true',
          ariaPressed: document.querySelector('#publication-toggle-marks')?.getAttribute('aria-pressed') === 'true',
          targetVisible: target.getClientRects().length > 0 && getComputedStyle(target).visibility !== 'hidden' });
      };
      document.addEventListener('focusin', listener, true);
      return { read: () => observations, remove: () => document.removeEventListener('focusin', listener, true) };
    }));
    try {
      await checkpoint('navigation-restore-clicked', async () => page.getByRole('button', { name: 'Next change', exact: true }).click());
      await checkpoint('navigation-restore-asserted', async () => {
        const observations = await focusObserver.evaluate((scope) => scope.read());
        evidence.marksVisibleAfterNavigation = await page.locator('.publication-review-app').getAttribute('data-marks-visible') === 'true';
        evidence.toggleAriaPressedAfterNavigation = await page.locator('#publication-toggle-marks').getAttribute('aria-pressed') === 'true';
        evidence.changeCountAnnouncementPresent = (await page.locator('#publication-review-announcement').textContent()).includes('Changes shown.');
        evidence.focusedAnchorVisibleAtFocusTime = observations.length > 0 && observations.every((entry) => entry.marksVisible && entry.ariaPressed && entry.targetVisible);
        expect(await page.locator('#publication-review-announcement').textContent()).toContain('Changes shown.');
        expect(evidence.marksVisibleAfterNavigation).toBe(true); expect(evidence.toggleAriaPressedAfterNavigation).toBe(true);
        expect(evidence.changeCountAnnouncementPresent).toBe(true); expect(evidence.focusedAnchorVisibleAtFocusTime).toBe(true);
        expect(await page.locator('[data-change]:focus').isVisible()).toBe(true);
      });
    } finally {
      try { await checkpoint('navigation-focus-observer-removed', async () => focusObserver.evaluate((scope) => scope.remove())); }
      finally { await focusObserver.dispose(); }
    }
    // No inline stylesheet injection and no CSP bypass. The browser-owned
    // JSHandle retains exact nodes, declaration values/order and priorities.
    let monochrome; let cues;
    try {
      await checkpoint('monochrome-applied', async () => {
        monochrome = await article.evaluateHandle(colourlessScope);
        evidence.cssomColourRemovalApplied = await monochrome.evaluate((scope) => scope.applied);
        expect(evidence.cssomColourRemovalApplied).toBe(true);
      });
      cues = await checkpoint('monochrome-cues-read', async () => monochrome.evaluate((scope) => scope.cues()));
      await checkpoint('monochrome-thickness-asserted', async () => { expect(cues.every((cue) => Number.parseFloat(cue.thickness) >= 2)).toBe(true); });
      await checkpoint('monochrome-insertion-asserted', async () => { expect(cues.filter((cue) => cue.tag === 'INS').every((cue) => cue.line === 'underline')).toBe(true); });
      await checkpoint('monochrome-deletion-asserted', async () => { expect(cues.filter((cue) => cue.tag === 'DEL').every((cue) => cue.line === 'line-through')).toBe(true); });
      await checkpoint('monochrome-screenshot-captured', async () => capture(page, 'inline-colourless-1440-light', false));
    } finally {
      if (monochrome) {
        try { await checkpoint('monochrome-restored', async () => {
          await observeRestoration(evidence, () => monochrome.evaluate((scope) => scope.restore()));
          expect(evidence.cssomRestorationEvaluateCompleted).toBe(true);
          expect(evidence.cssomColourRemovalRestored).toBe(true);
        }); } finally { await monochrome.dispose(); }
      }
    }
    await checkpoint('inline-proof-recorded', async () => {
      evidence.inlineProof = { additions: ['eighteen', 'forty'], deletions: ['twelve', 'sixty'], cleanBlocksEqualCandidateProjection: true,
        noncolourCues: cues.map((cue) => ({ tag: cue.tag === 'INS' ? 'INS' : 'DEL', thicknessAtLeastTwo: Number.parseFloat(cue.thickness) >= 2,
          lineMatchesExpected: cue.line === (cue.tag === 'INS' ? 'underline' : 'line-through') })) };
    });
    stage = 'review-matrix'; await captureMatrix(page, 'review');
    stage = 'full-document-capture'; await fullDocumentCapture(page, 'dispersed');
    privateAbsent(await page.content());
    expect(displayRequests).toBe(0); evidence.displayControlRequests = displayRequests; page.off('request', countDisplayRequest);
    evidence.fallbackChecks = [];
    for (const mode of ['no-js', 'unsupported', 'current', 'compare']) {
      stage = `details-${mode}`;
      const extraContext = await browser.newContext({ javaScriptEnabled: mode !== 'no-js', viewport: { width: mode === 'unsupported' ? 390 : 1440, height: 900 } });
      try {
        await extraContext.route('**/*', (route) => [fixture.ownerOrigin, fixture.readerOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
        if (mode === 'unsupported') await extraContext.addInitScript(() => { HTMLDialogElement.prototype.showModal = undefined; });
        const extraPage = await extraContext.newPage();
        await extraPage.goto(fixture.issueSignInUrl()); await extraPage.waitForURL(fixture.panelUrl);
        await extraPage.goto(`${reviewUrl.href}${['current', 'compare'].includes(mode) ? `?mode=${mode}` : ''}`);
        if (['no-js', 'unsupported'].includes(mode)) await checkpoint('fallback-native', async () => {
          const fallback = extraPage.locator('#publication-review-fallback');
          const record = { mode, fallbackVisible: await fallback.isVisible(), collapsed: await fallback.getAttribute('open') === null,
            toolbarDetailsHidden: !await extraPage.locator('#publication-toggle-details').isVisible(), sheetClosed: !await extraPage.locator('#publication-details-dialog').isVisible() };
          evidence.fallbackChecks.push(record); expect(Object.values(record).filter((value) => typeof value === 'boolean').every(Boolean)).toBe(true);
          await fallback.locator(':scope > summary').click();
          await fallback.locator('.technical-evidence > summary').click();
          expect(await fallback.locator('.technical-evidence').textContent()).toContain(REHEARSAL_CANDIDATE);
          record.nativeContentReachable = await fallback.locator('.technical-evidence pre').first().isVisible();
          expect(record.nativeContentReachable).toBe(true); await capture(extraPage, `details-fallback-${mode}`, false);
        });
        else await checkpoint('explicit-details', async () => {
          const sheet = extraPage.locator('#publication-details-dialog'); await sheet.waitFor({ state: 'visible' });
          const selected = extraPage.locator(mode === 'current' ? '#publication-previous-version' : '#publication-comparison');
          const record = { mode, modal: await sheet.evaluate((node) => node.matches(':modal')), selectedDisclosureOpen: await selected.getAttribute('open') !== null,
            focusOnClose: await extraPage.locator('#publication-close-details').evaluate((node) => node === document.activeElement), publishClosed: !await extraPage.locator('#publication-dialog').isVisible() };
          evidence.fallbackChecks.push(record); expect(Object.values(record).filter((value) => typeof value === 'boolean').every(Boolean)).toBe(true);
          await extraPage.keyboard.press('Escape'); expect(await sheet.isVisible()).toBe(false);
        });
      } finally { await extraContext.close(); }
    }
    const csrf = await page.locator('#publication-form').getAttribute('data-csrf');
    const trigger = page.locator('#publication-form button[type="submit"]');
    const dialog = page.getByRole('dialog', { name: 'Publish this version?' });
    stage = 'keyboard-confirmation';
    await trigger.focus(); await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'visible' });
    evidence.keyboardChecks = [];
    const focused = async (id) => {
      const result = await page.locator(`#${id}`).evaluate((node) => node === document.activeElement);
      evidence.keyboardChecks.push({ id, focused: result });
      return result;
    };
    stage = 'keyboard-initial-focus'; expect(await focused('publication-cancel')).toBe(true);
    await capture(page, 'confirmation-keyboard', false);
    stage = 'keyboard-reverse-tab'; await page.keyboard.press('Shift+Tab');
    expect(await focused('publication-confirm')).toBe(true);
    stage = 'keyboard-forward-tab'; await page.keyboard.press('Tab');
    expect(await focused('publication-cancel')).toBe(true);
    stage = 'keyboard-escape'; await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(true);
    expect(publishRequests).toBe(0);
    await page.keyboard.press('Enter');
    stage = 'confirmation-matrix'; await captureMatrix(page, 'confirmation');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(true); expect(publishRequests).toBe(0);
    evidence.keyboard = { opensWithEnter: true, initialFocusCancel: true, tabContained: true, escapeRestoresFocus: true, cancelRestoresFocus: true, cancelRequests: 0 };
    // Freeze only the browser's status polling while capturing the actual initial
    // server-rendered progress page. The disposable job runs normally throughout.
    const pollGate = new Promise((resolve) => { releaseProgressPolls = resolve; });
    await context.route('**/api/jobs/**', async (route) => { await pollGate; await route.continue(); });
    stage = 'publish'; await trigger.click();
    const publishStatus = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/publication/publish')
      .then((response) => response.status());
    // Two immediate confirmation activations preserve client one-request coverage.
    await dialog.getByRole('button', { name: 'Publish', exact: true }).evaluate((button) => { button.click(); button.click(); });
    const actualPublishStatus = await publishStatus;
    await recordNavigatingStatus(actualPublishStatus, 'publish'); expect(actualPublishStatus).toBe(202);
    await page.waitForURL(/\/owner\/jobs\/OA-PUB-[0-9a-f]{64}$/u);
    expect(page.url()).toBe(`${fixture.ownerOrigin}/owner/jobs/${prepared.jobId}`);
    stage = 'progress-matrix';
    evidence.progressSnapshotState = await page.locator('#job-state').textContent();
    expect(evidence.progressSnapshotState).not.toBe('completed');
    expect(await page.locator('#job-stage').textContent()).toBe('Running the local rehearsal');
    expect(await page.getByRole('link', { name: 'Back to your page', exact: true }).count()).toBe(1);
    await captureMatrix(page, 'progress'); evidence.progressPollingHeldForScreenshots = true;
    releaseProgressPolls();
    stage = 'job-completion'; await page.waitForFunction(() => document.querySelector('#job-state')?.textContent === 'completed');
    expect(await page.locator('#job-stage').textContent()).toBe('Rehearsal complete');
    expect(await page.getByRole('link', { name: 'Open the live page' }).count()).toBe(0);
    privateAbsent(await page.content()); expect(publishRequests).toBe(1);
    evidence.diagnosticSubstage = 'completed-durable-job-binding';
    const durableJob = JSON.parse(await readFile(path.join(fixture.context.storeRoot, 'jobs', prepared.jobId, 'state.json'), 'utf8'));
    expect(durableJob.jobId).toBe(prepared.jobId); expect(durableJob.state).toBe('completed');
    expect(await fixture.inspectDelivery()).toBe(REHEARSAL_CANDIDATE);
    const commit = await fixture.readLocalHead(); expect(commit === fixture.initialCommit).toBe(false);
    expect(await fixture.readBareHead()).toBe(commit); expect(await fixture.readStatus()).toBe('');
    expect(await fixture.readPublicationCommitCount()).toBe('1'); expect(fixture.readEffectCounts()).toEqual({ apply: 1, commit: 1, push: 1 });
    const replay = await capturePublicationResponse(context.request.post(`${fixture.ownerOrigin}/api/publication/publish`, {
      headers: { Origin: fixture.ownerOrigin }, data: { draftId: prepared.draftId, csrf } }));
    const replayed = await recordHttp(replay, 'replayPublish');
    expect(replay.status).toBe(202); expect(replayed.replayed).toBe(true); expect(replayed.jobId).toBe(prepared.jobId);
    expect((await readdir(path.join(fixture.context.storeRoot, 'jobs'))).length).toBe(1);
    expect(fixture.readEffectCounts()).toEqual({ apply: 1, commit: 1, push: 1 });
    expect((await page.content()).includes(REHEARSAL_LABEL)).toBe(true);
    stage = 'result-matrix'; await captureMatrix(page, 'result');
    Object.assign(evidence, { outcome: 'completed', capturedVersion: prepared.capturedVersion, candidateDigest: prepared.candidateDigest,
      mappingId: 'synthetic-page', canonicalPath: 'rehearsal/synthetic-only.md', draftId: prepared.draftId, jobId: prepared.jobId,
      clientPublishRequests: publishRequests, repeatedRequestReplayed: true, jobCount: 1,
      publicationCommitCount: 1, localCommit: commit, remoteEqualsLocal: true, effectCounts: fixture.readEffectCounts(), privateReferencesAbsent: true });
    await persist(); diagnosticPage = null;
    await context.close();
    evidence.variations = [];
    for (const variation of ['broad', 'table', 'sourceOnly', 'removedBlock']) {
      stage = `variation-${variation}`;
      const alternate = await createPublicationRehearsal({ port: 46844, variation }); owned.push(alternate);
      let alternateContext;
      try {
        evidence.ownershipRecords.push(await recordRehearsalOwnership(alternate, captureDir, variation));
        alternateContext = await browser.newContext({ viewport: { width: variation === 'table' ? 390 : 1440, height: variation === 'table' ? 844 : 900 }, colorScheme: variation === 'table' ? 'dark' : 'light' });
        await alternateContext.route('**/*', (route) => [alternate.ownerOrigin, alternate.readerOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
        const alternatePage = await alternateContext.newPage(); let alternatePublishRequests = 0;
        alternatePage.on('request', (request) => { if (new URL(request.url()).pathname === '/api/publication/publish') alternatePublishRequests += 1; });
        await alternatePage.goto(alternate.issueSignInUrl()); await alternatePage.waitForURL(alternate.panelUrl);
        await alternatePage.getByRole('button', { name: 'Review changes', exact: true }).click();
        await alternatePage.waitForURL(/\/owner\/publication\/[0-9a-f]{64}$/u);
        privateAbsent(await alternatePage.content());
        if (variation === 'sourceOnly') {
          expect(await alternatePage.locator('.publication-change-label').textContent()).toContain('Source/formatting changed');
          await alternatePage.getByRole('button', { name: 'Next change', exact: true }).click();
          await measure(alternatePage, 'source-only-focused'); await capture(alternatePage, 'source-only-focused-1440-light', false);
          await alternatePage.locator('.publication-previous-fragment summary').click();
          expect(await alternatePage.locator('.publication-previous-fragment pre').textContent()).toContain('```text');
        } else if (variation === 'removedBlock') {
          const removed = alternatePage.locator('.publication-deleted-block'); expect(await removed.count()).toBe(1);
          expect(await removed.textContent()).toContain('A shared repair workshop works best');
          await alternatePage.locator('#publication-toggle-marks').click(); expect(await removed.isVisible()).toBe(false);
          await alternatePage.getByRole('button', { name: 'Next change', exact: true }).click();
          expect(await removed.isVisible()).toBe(true); expect(await removed.evaluate((node) => node === document.activeElement)).toBe(true);
          expect(await alternatePage.locator('#publication-review-announcement').textContent()).toContain('Changes shown.');
          await measure(alternatePage, 'removed-block-restored'); await capture(alternatePage, 'removed-block-restored-1440-light', false);
        } else if (variation === 'table') {
          expect(await alternatePage.locator('[data-change]').count()).toBe(1);
          expect(await alternatePage.locator('.publication-change .publication-source-label').textContent()).toContain('not rendered');
          await alternatePage.getByRole('button', { name: 'Next change', exact: true }).click();
          await measure(alternatePage, 'table-focused'); await capture(alternatePage, 'table-focused-390-dark', false);
        } else {
          expect(await alternatePage.locator('.publication-coarse').textContent()).toBe('Whole-document review');
          expect(await alternatePage.locator('[data-change]').count()).toBe(0);
          expect(await alternatePage.locator('#publication-next-change').count()).toBe(0);
          for (const position of ['top', 'middle', 'end']) {
            await alternatePage.locator('#publication-document-scroll').evaluate((node, position) => { node.scrollTop = position === 'top' ? 0 : position === 'middle' ? node.scrollHeight / 2 : node.scrollHeight; }, position);
            await measure(alternatePage, `${variation}-${position}`); await capture(alternatePage, `${variation}-${position}-1440-light`, false);
          }
          expect(await alternatePage.locator('.publication-review-app').getAttribute('data-marks-visible')).toBe('false');
          await alternatePage.getByRole('button', { name: 'Show changes', exact: true }).click();
          expect(await alternatePage.locator('.publication-review-app').getAttribute('data-marks-visible')).toBe('true');
          expect(await alternatePage.locator('.publication-tracked-summary').count()).toBe(0);
          await fullDocumentCapture(alternatePage, variation);
        }
        await alternatePage.getByRole('button', { name: 'Details', exact: true }).click();
        if (variation === 'broad') await checkpoint('broad-details-limit', async () => {
          expect(await alternatePage.locator('#publication-details-dialog .publication-review-limit').textContent()).toContain('Broad rewrite');
          expect(await alternatePage.locator('.publication-coarse p').count()).toBe(0);
          await capture(alternatePage, 'broad-details-limit-1440-light', false);
        });
        await alternatePage.locator('.technical-evidence summary').click();
        expect(await alternatePage.locator('.technical-evidence').textContent()).toContain(variation === 'coarse' ? 'Sample 1499: checked' : 'End of the synthetic handbook.');
        expect(alternatePublishRequests).toBe(0); expect(alternate.readEffectCounts()).toEqual({ apply: 0, commit: 0, push: 0 });
        evidence.variations.push({ variation, displayed: true, exactEvidenceReachable: true, publishRequests: 0, effects: alternate.readEffectCounts() });
      } finally {
        await alternateContext?.close(); await alternate.cleanup();
        const record = evidence.variations.find((item) => item.variation === variation);
        if (record) record.cleanup = { contextClosed: true, ownedTempRootRemoved: !existsSync(alternate.root) };
      }
    }
  } catch (error) {
    evidence.outcome = 'failed'; evidence.failedStage = stage;
    if (evidence.failedCheckpointId === null) {
      evidence.failedCheckpointId = 'outside-inline-checkpoints'; evidence.failedCheckpointClass = checkpointFailureClass(error);
    }
    // Playwright errors can contain the one-time bootstrap URL. Never relay it.
    throw new Error(`synthetic headless publication rehearsal failed at ${stage}; authentication details withheld`);
  } finally {
    // Persist measured effects before cleanup. Counters describe attempts; source
    // bytes, commit count and bare-ref equality separately establish achievements.
    if (fixture) {
      evidence.attemptedEffects = fixture.readEffectCounts();
      try {
        const commits = Number(await fixture.readPublicationCommitCount());
        const local = await fixture.readLocalHead(); const bare = await fixture.readBareHead();
        Object.assign(evidence.achievedEffects, {
          publicationSourceApplied: await fixture.inspectDelivery() === REHEARSAL_CANDIDATE,
          publicationCommitCount: commits,
          publicationLocalBarePushCount: commits > 0 && local === bare ? 1 : 0,
        });
      } catch { evidence.achievedEffects.measurementUnavailable = true; }
    }
    releaseProgressPolls?.();
    evidence.cleanup = { browserClosed: false, ownedTempRootRemoved: false };
    await persist();
    try { await browser?.close(); evidence.cleanup.browserClosed = true; }
    catch { evidence.cleanup.browserCloseFailed = true; }
    try { if (fixture) { await fixture.cleanup(); evidence.cleanup.ownedTempRootRemoved = !existsSync(fixture.root); } }
    catch { evidence.cleanup.ownedCleanupFailed = true; }
    await persist();
  }
});
