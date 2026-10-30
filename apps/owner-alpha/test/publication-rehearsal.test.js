import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/json.js';
import { capturePublicationResponse } from './publication-response-capture.js';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPublicationRehearsal, REHEARSAL_BASE, REHEARSAL_CANDIDATE, REHEARSAL_LABEL,
} from '../bin/publication-rehearsal-fixture.js';
import { rehearsalOptions } from '../bin/publication-rehearsal.js';

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
  expect(REHEARSAL_CANDIDATE).toBe(REHEARSAL_BASE.replace('value is old', 'value is new'));
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
  expect(html.includes(REHEARSAL_LABEL)).toBe(true); expect(html.includes('Prepare exact review')).toBe(true);
  expect(existsSync(path.join(fixture.context.storeRoot, 'jobs'))).toBe(false);
});

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

// Root must relay the runtime review verdict before enabling this test. It is
// prepared, not part of the setup/lifecycle gate, and never downloads a browser.
const browserTest = process.env.OWNER_ALPHA_PUBLICATION_REHEARSAL_BROWSER === '1' ? test : test.skip;
browserTest('headless browser rehearsal uses actual publication routes and real local-only Git effects', async () => {
  let fixture; let browser; let stage = 'setup';
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
  const persist = async () => {
    evidence.stage = stage;
    await writeFile(path.join(captureDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  };
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
  const capture = async (page, name) => {
    const file = path.join(captureDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true }); await chmod(file, 0o600);
  };
  const privateAbsent = (html) => {
    expect(html.includes('synthetic-authoring-memory')).toBe(false);
    expect(html.includes('drafts/rehearsal.md')).toBe(false);
    expect(html.includes('"reference"')).toBe(false);
  };
  try {
    fixture = await createPublicationRehearsal({ port: 46333 }); owned.push(fixture);
    evidence.achievedEffects.baselineCommit = 1; evidence.achievedEffects.baselineLocalBarePush = 1;
    await persist();
    const installed = path.resolve(import.meta.dir, '../../../docs/node_modules/playwright/index.js');
    const { chromium } = await import(pathToFileURL(installed).href);
    stage = 'fresh-headless-launch'; browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', (route) => [fixture.ownerOrigin, fixture.readerOrigin].includes(new URL(route.request().url()).origin)
      ? route.continue() : route.abort());
    const page = await context.newPage(); let publishRequests = 0;
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/publication/publish') publishRequests += 1; });
    // No persistent profile, storageState, remote debugging or prior cookies.
    stage = 'normal-authentication'; await page.goto(fixture.issueSignInUrl()); await page.waitForURL(fixture.panelUrl);
    privateAbsent(await page.content());
    stage = 'prepare';
    // Status survives navigation; response BODY is deliberately not read here.
    // Route JSON shape is covered separately. Actual navigated URL selects the
    // immutable draft whose exact bindings are checked below, not a second POST.
    const prepareStatus = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/publication/prepare')
      .then((response) => response.status());
    await page.getByRole('button', { name: 'Prepare exact review' }).click();
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
    stage = 'review-modes';
    for (const mode of ['Changes', 'Proposed', 'Current', 'Compare']) {
      await page.getByRole('link', { name: mode, exact: true }).click();
      privateAbsent(await page.content());
    }
    await page.getByRole('heading', { name: 'Proposed publication', exact: true }).waitFor();
    await capture(page, 'review');
    const csrf = await page.locator('#publication-form').getAttribute('data-csrf');
    stage = 'publish'; page.once('dialog', (dialog) => { void dialog.accept(); });
    const publishStatus = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/publication/publish')
      .then((response) => response.status());
    // Two immediate button activations exercise the existing pending/disabled
    // protection. The second cannot enqueue another client Publish request.
    await page.getByRole('button', { name: 'Publish this captured version' }).evaluate((button) => { button.click(); button.click(); });
    const actualPublishStatus = await publishStatus;
    await recordNavigatingStatus(actualPublishStatus, 'publish'); expect(actualPublishStatus).toBe(202);
    await page.waitForURL(/\/owner\/jobs\/OA-PUB-[0-9a-f]{64}$/u);
    expect(page.url()).toBe(`${fixture.ownerOrigin}/owner/jobs/${prepared.jobId}`);
    stage = 'job-completion'; await page.waitForFunction(() => document.querySelector('#job-state')?.textContent === 'completed');
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
    expect((await page.content()).includes(REHEARSAL_LABEL)).toBe(true); await capture(page, 'completed');
    Object.assign(evidence, { outcome: 'completed', capturedVersion: prepared.capturedVersion, candidateDigest: prepared.candidateDigest,
      mappingId: 'synthetic-page', canonicalPath: 'rehearsal/synthetic-only.md', draftId: prepared.draftId, jobId: prepared.jobId,
      clientPublishRequests: publishRequests, repeatedRequestReplayed: true, jobCount: 1,
      publicationCommitCount: 1, localCommit: commit, remoteEqualsLocal: true, effectCounts: fixture.readEffectCounts(), privateReferencesAbsent: true });
    await context.close();
  } catch {
    evidence.outcome = 'failed'; evidence.failedStage = stage;
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
    evidence.cleanup = { browserClosed: false, ownedTempRootRemoved: false };
    await persist();
    try { await browser?.close(); evidence.cleanup.browserClosed = true; }
    catch { evidence.cleanup.browserCloseFailed = true; }
    try { if (fixture) { await fixture.cleanup(); evidence.cleanup.ownedTempRootRemoved = !existsSync(fixture.root); } }
    catch { evidence.cleanup.ownedCleanupFailed = true; }
    await persist();
  }
});
