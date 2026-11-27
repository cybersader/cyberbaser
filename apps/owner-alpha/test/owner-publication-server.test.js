import { afterEach, expect, test } from 'bun:test';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateOwnerAlphaConfig, computePolicyRevision } from '../src/config.js';
import { createJsonArtifactOnce } from '../src/artifacts.js';
import { initializeDurableJob } from '../src/job-state.js';
import { canonicalJson } from '../src/json.js';
import { createSaveHandler, pipelineArtifactPaths } from '../src/pipeline.js';
import { createOwnerAlphaHandler, runOwnerAlphaServer } from '../src/server.js';
import { createOwnerPublicationRuntime, PUBLICATION_VIEW_TTL_MS } from '../src/owner-publication-runtime.js';
import { createEditSession, defaultGitRunner } from '../src/source.js';
import { documentProjection } from '@cyberbaser/review-projection';
import { EDITED, MAPPING, PRIVATE_ID, PRIVATE_PATH, cleanup, command, publicationFixture } from './publication-fixture.js';
import { cleanupPublicationReviewFixture, publicationReviewCase } from './publication-readonly-checkpoints.js';

const ORIGIN = 'http://127.0.0.1:4317';
const CSRF = 'b'.repeat(43);
const TOKEN = 'c'.repeat(43);
function request(path, { method = 'GET', cookie, body, headers = {} } = {}) {
  return new Request(`${ORIGIN}${path}`, { method, headers: { Host: '127.0.0.1:4317',
    ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}), ...headers },
    body: typeof body === 'object' ? JSON.stringify(body) : body });
}
function privateAbsent(text) { expect(text).not.toContain(PRIVATE_ID); expect(text).not.toContain(PRIVATE_PATH); expect(text).not.toContain('"reference"'); }
async function handler(data, { enabled = true, service = data.runtime, lookupJob = data.pipeline.getJob } = {}) {
  const raw = structuredClone(data.config); if (!enabled) raw.ownerPublication = { enabled: false };
  const tokens = ['a'.repeat(43), CSRF, TOKEN]; let index = 0;
  const fetch = createOwnerAlphaHandler({ config: validateOwnerAlphaConfig(raw), projectRoot: data.root,
    saveEdit: data.pipeline.saveEdit, lookupJob, ownerPublication: service,
    createToken: () => tokens[index++],
    createEditSession: async () => ({ source: { text: '# Plain edit\n' } }) });
  const bootstrap = await fetch(request(`/owner/bootstrap?token=${TOKEN}`));
  return { fetch, bootstrap, cookie: bootstrap.headers.get('set-cookie').split(';')[0],
    post: (path, body, headers) => fetch(request(path, { method: 'POST', cookie: bootstrap.headers.get('set-cookie').split(';')[0], body, headers })) };
}
afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) =>
  cleanupPublicationReviewFixture(root, () => rm(root, { recursive: true, force: true })))); });

test('enabled normal owner entry links exact review, with safe modes and no private source reference in HTML or JSON', async () => {
  const data = await publicationFixture(); const app = await handler(data);
  expect(app.bootstrap.headers.get('location')).toBe('/owner/publication');
  const landing = await app.fetch(request('/owner/publication', { cookie: app.cookie }));
  expect(landing.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(landing.headers.get('referrer-policy')).toBe('no-referrer');
  const page = await landing.text(); privateAbsent(page); expect(page).toContain('Review changes'); expect(data.reads).toBe(0);
  const edit = await app.fetch(request('/owner/edit?relativePath=Notes%2FPage.md&slug=Notes%2Fpage', { cookie: app.cookie }));
  expect(await edit.text()).toContain('href="/owner/publication"');
  const prep = await app.post('/api/publication/prepare', { mappingId: MAPPING.id, csrf: CSRF });
  expect(prep.status).toBe(201); const preparedText = await prep.text(); privateAbsent(preparedText); const prepared = JSON.parse(preparedText);
  for (const mode of ['changes', 'proposed', 'current', 'compare']) {
    const response = await app.fetch(request(`${prepared.reviewUrl}?mode=${mode}`, { cookie: app.cookie }));
    expect(response.status).toBe(200); const html = await response.text(); privateAbsent(html);
    expect(html).not.toContain('Structural reading, not the published page');
    expect(html).not.toContain('Underline means added; strikethrough means removed.');
    expect(html).not.toContain('publication-review-note');
    expect(html).toContain('Captured authoring version 7');
    expect(html.indexOf('Captured authoring version 7')).toBeGreaterThan(html.indexOf('<section id="publication-review-details"'));
    expect(html.slice(0, html.indexOf('<section id="publication-review-details"'))).not.toContain('Captured version');
    expect(html).toContain('<button type="submit">Publish</button>');
    expect(html).toContain('<dialog id="publication-dialog"');
    expect(html).not.toContain('class="mode-tab');
    expect(html).toContain('aria-label="Proposed document"');
    expect(html).not.toContain('Publish approves this whole version, not selected passages.');
    const confirmation = html.slice(html.indexOf('<dialog id="publication-dialog"'));
    expect(confirmation).toContain('Publish this version?');
    expect(confirmation).toContain('applies the exact reviewed change, commits and pushes it');
    expect(confirmation).toContain('Later authoring edits are not included.');
    expect(html).toContain(`data-marks-visible="${mode !== 'proposed'}"`);
    expect(html).toContain(`<details id="publication-review-fallback"${['current', 'compare'].includes(mode) ? ' open' : ''}><summary>Details</summary>`);
    expect(html).toContain('<section id="publication-review-details">');
    expect(html).toContain('<dialog id="publication-details-dialog" aria-labelledby="publication-details-heading">');
    expect(html).toContain('aria-label="Close details"');
    expect(html).toContain('aria-controls="publication-details-dialog" aria-haspopup="dialog" hidden');
    expect(html).toContain('aria-label="Show changes"');
    expect(html).toContain(`aria-pressed="${mode !== 'proposed'}"`);
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('aria-hidden="true" focusable="false"');
    expect(html).toContain('id="publication-review-announcement"');
    expect(html).not.toContain('Review the whole version');
    expect(html).not.toContain('publication-tracked-summary');
    expect(html).not.toContain('Clean reading hides changes without accepting them');
    expect(html).not.toMatch(/\d+ inline · \d+ added/u);
    expect(html).not.toContain('role="tab');
    expect(html).not.toContain('Apply to page');
  }
  const asset = await app.fetch(request('/owner/assets/publication.js', { cookie: app.cookie })); expect(asset.status).toBe(200);
});

test('unchanged Prepare serves the entire pinned page with empty-operation projection, escaped source and existing Details layout', () =>
  publicationReviewCase('server-full-page', (onRoot) => publicationFixture({ onRoot }), async (data) => {
  const text = '---\ntitle: Synthetic research index\n---\n\n# <img src=x onerror=alert(1)>\n\nA complete synthetic research index with a [[Reference]] and ordinary blank lines.\n\n- Overview\n- Reading notes\n\n' + Array.from({ length: 60 }, (_, index) =>
    `## Section ${index + 1}\n\nWhole-page paragraph ${index + 1}: café, exact text and **strong words**.\n\n`).join('')
    + '| Exact table | Value |\n| --- | --- |\n| <script>alert(1)</script> | & sentinel |\n\nFinal captured paragraph.\n';
  await writeFile(path.join(data.root, MAPPING.relativePath), text);
  await command(data.root, ['add', MAPPING.relativePath]); await command(data.root, ['commit', '-q', '-m', 'synthetic full-page base']);
  const head = await command(data.root, ['rev-parse', 'HEAD']);
  const git = (checkout, args, options) => args[0] === 'ls-remote'
    ? Promise.resolve(`${head}\trefs/heads/main`) : defaultGitRunner(checkout, args, options);
  let now = 1000; let sessions = 0;
  data.setSource(text);
  const runtime = createOwnerPublicationRuntime({ config: data.config, context: data.context, readNote: data.readNote, clock: () => now,
    sourceSession: async (input) => { sessions += 1; return createEditSession({ ...input, git }); } });
  const before = await readdir(data.context.storeRoot); let currentLoads = 0;
  const forwarded = { ...runtime, loadCurrent(input) { currentLoads += 1; return runtime.loadCurrent(input); } };
  const app = await handler(data, { service: forwarded });
  const prep = await app.post('/api/publication/prepare', { mappingId: MAPPING.id, csrf: CSRF });
  expect(prep.status).toBe(201); const result = await prep.json();
  expect(Object.keys(result).sort()).toEqual(['outcome', 'reviewUrl']); expect(result.outcome).toBe('unchanged');
  expect(result.reviewUrl).toMatch(/^\/owner\/publication\/current\/[0-9a-f]{64}$/u);
  expect(data.reads).toBe(1); expect(sessions).toBe(1);
  const projection = documentProjection({ files: [{ path: MAPPING.relativePath, exists: true, baseText: text, candidateText: text }], operations: [] });
  for (const mode of ['current', 'proposed', 'unified']) {
    expect(projection.files[0][mode].available).toBe(true);
    expect(projection.files[0][mode].segments.every((segment) => segment.kind === 'context')).toBe(true);
    expect(projection.files[0][mode].blocks.length).toBeGreaterThan(120);
  }
  expect(projection.files[0].operationNumbers).toEqual([]);
  expect(projection.files[0].proposed.blocks.some((block) => block.kind === 'gap')).toBe(true);
  const response = await app.fetch(request(result.reviewUrl, { cookie: app.cookie }));
  expect(response.status).toBe(200); const html = await response.text(); privateAbsent(html);
  expect(currentLoads).toBe(1);
  const primary = /<article class="publication-reviewed-document" aria-label="Captured document">([\s\S]*?)<\/article>/u.exec(html)?.[1];
  expect(typeof primary).toBe('string');
  expect(primary).not.toContain('gap is not rendered');
  expect(primary).not.toContain('publication-exact-document');
  expect(primary).toContain('A complete synthetic research index');
  expect(primary).toContain('Final captured paragraph.');
  expect(primary).toContain('<strong>strong words</strong>');
  expect(html).toContain('publication-document-review'); expect(html).toContain('id="publication-document-scroll"');
  expect(html).toContain('aria-label="Captured document"'); expect(html).toContain('No changes'); expect(html).toContain('Read only');
  for (let index = 1; index <= 60; index += 1) {
    expect(html).toContain(`Whole-page paragraph ${index}:`);
    expect(primary).toContain(`Whole-page paragraph ${index}:`);
  }
  expect(html).toContain('<strong>strong words</strong>'); expect(html).toContain('Final captured paragraph.');
  expect(html).not.toContain('<img'); expect(html).not.toContain('<script>alert'); expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).toContain('&amp; sentinel');
  for (const fragment of ['data-change=', '<ins', '<del ', 'id="publication-form"', 'id="publication-dialog"', 'publication-toggle-marks', 'publication-next-change', 'Authoritative exact operation']) expect(html).not.toContain(fragment);
  expect(html).toContain('id="publication-review-fallback"><summary>Details</summary>');
  expect(html).toContain('id="publication-review-details"'); expect(html).toContain('id="publication-details-dialog"');
  expect(html).toContain('id="publication-close-details"'); expect(html).toContain('matches the pinned repository version');
  expect(html).toContain('Current deployment has not been verified.'); expect(html).toContain(head);
  const headed = await app.fetch(request(result.reviewUrl, { method: 'HEAD', cookie: app.cookie })); expect(headed.status).toBe(200); expect(await headed.text()).toBe('');
  expect((await app.fetch(request(`${result.reviewUrl}?mode=current`, { cookie: app.cookie }))).status).toBe(400);
  expect((await app.post(result.reviewUrl, {})).status).toBe(405);
  expect((await app.fetch(request(result.reviewUrl))).status).toBe(403);
  expect((await app.fetch(request(`/owner/publication/current/${'0'.repeat(64)}`, { cookie: app.cookie }))).status).toBe(409);
  expect((await app.fetch(request('/owner/publication/current/not-an-id', { cookie: app.cookie }))).status).toBe(404);
  now += PUBLICATION_VIEW_TTL_MS;
  for (const method of ['GET', 'HEAD']) expect((await app.fetch(request(result.reviewUrl, { method, cookie: app.cookie }))).status).toBe(409);
  expect(data.reads).toBe(1); expect(sessions).toBe(1);
  expect(await readdir(data.context.storeRoot)).toEqual(before); expect(data.renderCalls).toBe(0);
  // Empty and whitespace-only pinned files must retain the honest exact-source
  // fallback, not an empty article or a fabricated unsupported-gap panel.
  for (const [index, fallbackText] of ['', ' \n\n\t\n'].entries()) {
    await writeFile(path.join(data.root, MAPPING.relativePath), fallbackText);
    await command(data.root, ['add', MAPPING.relativePath]);
    await command(data.root, ['commit', '-q', '-m', 'synthetic exact-source fallback base']);
    const fallbackHead = await command(data.root, ['rev-parse', 'HEAD']);
    const fallbackGit = (checkout, args, options) => args[0] === 'ls-remote'
      ? Promise.resolve(`${fallbackHead}\trefs/heads/main`) : defaultGitRunner(checkout, args, options);
    data.setSource(fallbackText, 20 + index); let fallbackSessions = 0;
    const fallbackRuntime = createOwnerPublicationRuntime({ config: data.config, context: data.context, readNote: data.readNote,
      sourceSession: async (input) => { fallbackSessions += 1; return createEditSession({ ...input, git: fallbackGit }); } });
    const fallbackApp = await handler(data, { service: fallbackRuntime }); const reads = data.reads;
    const prepared = await fallbackApp.post('/api/publication/prepare', { mappingId: MAPPING.id, csrf: CSRF });
    expect(prepared.status).toBe(201); const captured = await prepared.json();
    expect(captured.outcome).toBe('unchanged');
    const page = await fallbackApp.fetch(request(captured.reviewUrl, { cookie: fallbackApp.cookie }));
    expect(page.status).toBe(200); const exactHtml = await page.text(); privateAbsent(exactHtml);
    const exactPrimary = /<article class="publication-reviewed-document" aria-label="Captured document">([\s\S]*?)<\/article>/u.exec(exactHtml)?.[1];
    expect(exactPrimary).toBe(`<div class="publication-exact-document"><p class="publication-source-label">Exact source</p><pre>${fallbackText}</pre></div>`);
    expect(exactHtml).not.toContain('gap is not rendered'); expect(exactHtml).not.toContain('data-change=');
    expect(exactHtml).not.toContain('id="publication-form"'); expect(exactHtml).not.toContain('id="publication-dialog"');
    expect(exactHtml).toContain('No changes'); expect(exactHtml).toContain('Read only');
    expect(exactHtml).toContain('id="publication-review-details"');
    expect(exactHtml).toContain('Current deployment has not been verified.');
    expect(fallbackSessions).toBe(1); expect(data.reads).toBe(reads + 1);
    expect(await readdir(data.context.storeRoot)).toEqual(before); expect(data.renderCalls).toBe(0);
  }
}));

test('read-only changed review omits Publish and router denies before body consumption or runtime dispatch', () =>
  publicationReviewCase('server-deny', (onRoot) => publicationFixture({ onRoot }), async (data) => {
  const { draft } = await data.prepare();
  const reads = data.reads; let calls = 0;
  const readonly = createOwnerPublicationRuntime({ config: data.config, context: data.context, readNote: data.readNote });
  for (const missingLoader of [undefined, null]) {
    const incomplete = { ...readonly, loadCurrent: missingLoader };
    await expect(handler(data, { service: incomplete })).rejects.toThrow('loadCurrent');
  }
  let unavailableLoads = 0;
  const unavailable = await handler(data, { service: { ...readonly, loadCurrent() {
    unavailableLoads += 1; throw new Error(PRIVATE_ID);
  } } });
  const unavailablePage = await unavailable.fetch(request(`/owner/publication/current/${'a'.repeat(64)}`, { cookie: unavailable.cookie }));
  expect(unavailablePage.status).toBe(409); privateAbsent(await unavailablePage.text()); expect(unavailableLoads).toBe(1);
  const service = { ...readonly, publish(...args) { calls += 1; return readonly.publish(...args); } };
  const app = await handler(data, { service });
  const html = await (await app.fetch(request(`/owner/publication/${draft.draftId}`, { cookie: app.cookie }))).text();
  expect(html).toContain('Read only'); expect(html).not.toContain('id="publication-form"'); expect(html).not.toContain('id="publication-dialog"');
  const publish = request('/api/publication/publish', { method: 'POST', cookie: app.cookie, body: 'malformed-json' });
  const denied = await app.fetch(publish); expect(denied.status).toBe(403); expect(publish.bodyUsed).toBe(false);
  expect(await denied.json()).toEqual({ error: { code: 'publication-read-only' } });
  expect((await app.post('/api/publication/publish', 'x'.repeat(4097))).status).toBe(403);
  expect(calls).toBe(0); expect(data.reads).toBe(reads); expect(data.renderCalls).toBe(0);
  expect(await data.runtime.readJob(draft.jobId)).toEqual({ status: 'missing' });
  expect(await readdir(path.join(data.context.storeRoot, 'owner-publication/authorizations'))).toEqual([]);
}));

test('routes inherit session/Host/Origin/CSRF and enforce finite closed bodies, method and query rules', async () => {
  const data = await publicationFixture(); const app = await handler(data);
  expect((await app.fetch(request('/owner/publication'))).status).toBe(403);
  expect((await app.fetch(request('/owner/publication', { cookie: app.cookie, headers: { Host: 'localhost:4317' } }))).status).toBe(421);
  expect((await app.post('/api/publication/prepare', { mappingId: MAPPING.id, csrf: CSRF }, { Origin: 'https://elsewhere.invalid' })).status).toBe(403);
  expect((await app.post('/api/publication/prepare', { mappingId: MAPPING.id, csrf: 'd'.repeat(43) })).status).toBe(403);
  for (const body of [{ mappingId: MAPPING.id, csrf: CSRF, path: 'forged.md' }, { draftId: 'a'.repeat(64), csrf: CSRF }, [], null]) {
    expect((await app.post('/api/publication/prepare', body)).status).toBe(400);
  }
  expect((await app.post('/api/publication/prepare', 'x'.repeat(4097))).status).toBe(413);
  expect((await app.post('/api/publication/prepare', {}, { 'Content-Type': 'text/plain' })).status).toBe(415);
  expect((await app.fetch(request('/api/publication/prepare', { cookie: app.cookie }))).status).toBe(405);
  expect((await app.fetch(request('/owner/publication?extra=x', { cookie: app.cookie }))).status).toBe(400);
  expect((await app.post('/api/publication/prepare?extra=x', { mappingId: MAPPING.id, csrf: CSRF })).status).toBe(400);
  const { draft } = await data.prepare();
  for (const query of ['?mode=wrong', '?mode=current&mode=compare', '?extra=x']) {
    expect((await app.fetch(request(`/owner/publication/${draft.draftId}${query}`, { cookie: app.cookie }))).status).toBe(400);
  }
});

test('disabled routes are unavailable and do not call an injected publication service', async () => {
  const data = await publicationFixture(); let calls = 0;
  const service = Object.fromEntries(['prepare', 'load', 'loadCurrent', 'publish', 'readJob'].map((key) => [key, () => { calls += 1; throw new Error(PRIVATE_ID); }]));
  const app = await handler(data, { enabled: false, service });
  for (const route of ['/owner/publication', `/owner/publication/${'a'.repeat(64)}`]) expect((await app.fetch(request(route, { cookie: app.cookie }))).status).toBe(404);
  expect((await app.post('/api/publication/prepare', { mappingId: MAPPING.id, csrf: CSRF })).status).toBe(404);
  expect((await app.post('/api/publication/publish', { draftId: 'a'.repeat(64), csrf: CSRF })).status).toBe(404);
  expect(calls).toBe(0);
});

test('Publish returns actual durable acceptance and normal job progress, with truthful terminal-draft replay', async () => {
  const data = await publicationFixture(); const app = await handler(data); const { draft } = await data.prepare();
  const accepted = await app.post('/api/publication/publish', { draftId: draft.draftId, csrf: CSRF }); expect(accepted.status).toBe(202);
  const text = await accepted.text(); privateAbsent(text); const receipt = JSON.parse(text);
  const job = await app.fetch(request(receipt.statusUrl, { cookie: app.cookie })); const html = await job.text(); privateAbsent(html); expect(html).toContain('class="publication-shell publication-job"'); expect(html).toContain('<h1>Page</h1>');
  const json = await app.fetch(request(`/api/jobs/${draft.jobId}`, { cookie: app.cookie })); const safe = await json.text(); privateAbsent(safe); expect(JSON.parse(safe).origin).toEqual({ type: 'owner-publication', relativePath: MAPPING.relativePath });
  data.setSource(EDITED.replace('new', 'next'), 7); data.renderGate.resolve({ ok: true }); await data.completion;
  const review = await app.fetch(request(`/owner/publication/${draft.draftId}`, { cookie: app.cookie }));
  const terminal = await review.text(); privateAbsent(terminal); expect(terminal).toContain('will not start again'); expect(terminal).not.toContain('id="publication-form"');
  data.setUnavailable(); const replay = await app.post('/api/publication/publish', { draftId: draft.draftId, csrf: CSRF }); expect(replay.status).toBe(202); privateAbsent(await replay.text());
});

test('source markup remains escaped in every private review mode', async () => {
  const data = await publicationFixture(); data.setSource(EDITED.replace('new', '<script>alert(1)</script>'), 8);
  const { draft } = await data.prepare(); const app = await handler(data);
  for (const mode of ['changes', 'current', 'proposed', 'compare']) {
    const result = await app.fetch(request(`/owner/publication/${draft.draftId}?mode=${mode}`, { cookie: app.cookie }));
    expect(result.status).toBe(200); const html = await result.text(); privateAbsent(html);
    expect(html).not.toContain('<script>alert(1)</script>');
    if (mode !== 'current') expect(html).toContain('&lt;script&gt;');
  }
});

test('inline review marks words without changing literal notation or inventing resolution controls', async () => {
  const data = await publicationFixture(); data.setSource(EDITED.replace('new', 'new `{++literal++}`'), 8);
  const { draft } = await data.prepare(); const app = await handler(data);
  const html = await (await app.fetch(request(`/owner/publication/${draft.draftId}`, { cookie: app.cookie }))).text();
  expect(html).toContain('<del class="publication-del" aria-label="Removed">');
  expect(html).toContain('<ins class="publication-ins" aria-label="Added">');
  expect(html).toContain('{++literal++}'); expect(html).toContain('aria-label="Show changes"');
  expect(html).not.toContain('publication-previous-fragment');
  expect(html).not.toContain('aria-label="Previous exact source for change 1"');
  const details = html.slice(html.indexOf('<section id="publication-review-details">'));
  expect(details).toContain('<details id="publication-previous-version"><summary>Pinned repository version</summary>');
  expect(details).toContain('<summary>Exact source and review details</summary>');
  expect(details).toContain('<h3>Pinned repository version · exact source</h3><pre># Synthetic page\n\nThe old value.\n</pre>');
  expect(details).toContain('<h3>Entire proposed version · exact source</h3><pre># Synthetic page\n\nThe new `{++literal++}` value.\n</pre>');
  expect(details).toContain('Authoritative exact operation');
  expect(html).not.toContain('Accept change'); expect(html).not.toContain('Reject change');
  expect(html).not.toContain('compares derived endpoint projections, not source-span mapping or authoring history');
  expect(draft.prepared.candidate.text).toBe(EDITED.replace('new', 'new `{++literal++}`'));
});

test('real startup passes the same injected coherent reader guard into actual pipeline recovery and the authenticated panel', async () => {
  const data = await publicationFixture(); const { draft } = await data.prepare();
  const event = { schemaVersion: 1, artifactType: 'owner-alpha-publication-authorization', action: 'publish',
    draftId: draft.draftId, jobId: draft.jobId, authorizedAt: '2026-10-30T12:00:00.000Z',
    authority: { type: 'owner-alpha-local', identity: data.config.owner.identity },
    policyRevision: computePolicyRevision(data.config), baseCommit: data.head, candidateDigest: draft.prepared.candidate.digest };
  const authorizationDigest = createHash('sha256').update(canonicalJson(event)).digest('hex');
  await createJsonArtifactOnce(data.context, `owner-publication/authorizations/${draft.draftId}.json`, event);
  const paths = pipelineArtifactPaths(draft.jobId);
  await createJsonArtifactOnce(data.context, paths.session, { ...draft.prepared.session, origin: { type: 'owner-publication', draftId: draft.draftId,
    authorizationDigest, reference: draft.prepared.reference } });
  await createJsonArtifactOnce(data.context, paths.operation, draft.prepared.operation);
  await initializeDurableJob(data.context, { jobId: draft.jobId, policyRevision: computePolicyRevision(data.config) });
  const configFile = path.join(data.root, '.workspace/owner-alpha.local.json');
  await writeFile(configFile, JSON.stringify(data.config), { mode: 0o600 });
  let sourceReads = 0; let guardDependency; let ownerFetch;
  const started = await runOwnerAlphaServer({ configFile, projectRoot: data.root,
    rebuildSite: async () => {}, startSuggestions: async () => null,
    readAuthoringNote: async () => { sourceReads += 1; throw new Error(`${PRIVATE_ID} ${PRIVATE_PATH}`); },
    loadPipeline: async (options) => {
      guardDependency = options.dependencies.revalidateSource;
      return createSaveHandler({ ...options, dependencies: { ...data.dependencies, ...options.dependencies,
        runPreApplyChecks: async () => ({ ok: true }),
        applyAcceptedOperation: async () => { throw new Error('must not apply'); } } });
    },
    createReader: () => async () => new Response('synthetic reader'),
    startServers: ({ ownerFetch: fetch }) => { ownerFetch = fetch; return { stop() {} }; },
  });
  expect(typeof guardDependency).toBe('function');
  const recovered = await started.recovery; expect(recovered).toHaveLength(1); expect(recovered[0].state).toBe('blocked-pre-apply');
  expect(recovered[0].failure.code).toBe('authoring-read-failed'); expect(sourceReads).toBe(1);
  // Exercise the handler constructed by real startup, not a replacement panel.
  const token = ownerFetch.bootstrapToken;
  const opened = await ownerFetch(request(`/owner/bootstrap?token=${token}`));
  const cookie = opened.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toBeTruthy();
  const landing = await ownerFetch(request('/owner/publication', { cookie })); expect(landing.status).toBe(200); privateAbsent(await landing.text());
  await started.stop();
});

test('publication headings use only captured evidence, escape titles, and keep exact source available', async () => {
  const data = await publicationFixture();
  data.setSource(EDITED.replace('Synthetic page', '<img src=x onerror=alert(1)>'), 9);
  const { draft } = await data.prepare(); const app = await handler(data);
  const before = data.reads;
  const landing = await (await app.fetch(request('/owner/publication', { cookie: app.cookie }))).text();
  expect(landing).toContain('<h1>Page</h1>');
  expect(landing).not.toContain('Notes/Page.md');
  expect(landing).toContain('<a href="https://example.github.io/fixture/Notes/page" rel="noreferrer">');
  expect(landing).not.toMatch(/in sync|unpublished changes|fresh/iu);
  for (const mode of ['changes', 'proposed', 'current', 'compare']) {
    const html = await (await app.fetch(request(`/owner/publication/${draft.draftId}?mode=${mode}`, { cookie: app.cookie }))).text();
    expect(html).toContain('<h1>&lt;img src=x onerror=alert(1)&gt;</h1>');
    expect(html).not.toContain('<img'); expect(html).not.toContain('<style');
    expect(html).not.toMatch(/<script(?! src=)/u);
    expect(html).toContain('Exact source and review details');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    privateAbsent(html);
  }
  expect(data.reads).toBe(before);
});

test('unknown job state refuses publication without claiming that nothing changed', async () => {
  const data = await publicationFixture(); const { draft } = await data.prepare();
  const app = await handler(data, { service: { ...data.runtime, readJob: async () => ({ status: 'unavailable' }) } });
  const html = await (await app.fetch(request(`/owner/publication/${draft.draftId}`, { cookie: app.cookie }))).text();
  expect(html).toContain('A job may already exist');
  expect(html).toContain('Job state cannot be established safely. Publication is unavailable; do not assume the job is absent.');
  expect(html).toContain('<button type="button" disabled>Publish unavailable</button>');
  expect(html).not.toContain('id="publication-form"'); expect(html).not.toContain('<dialog id="publication-dialog"');
});

test('publication job outcomes are readable and raw identities remain in disclosure', async () => {
  const data = await publicationFixture();
  const cases = {
    completed: 'Published and confirmed.',
    'blocked-pre-apply': 'Stopped before changing the page. Nothing changed.',
    'deployment-failed': 'The page changed and was pushed, but the site build failed.',
    'live-verification-failed': 'The change was pushed. The live page is not confirmed yet. Checking again.',
    'manual-intervention': 'Publication stopped. Check the record before taking another action.',
    failed: 'Publication stopped. Changes may already have been made; check the record.',
    cancelled: 'Publication cancelled. Check the record before starting another review.',
    accepted: 'Publishing this version',
    pushing: 'Publishing this version',
  };
  for (const [state, copy] of Object.entries(cases)) {
    const job = { jobId: `OA-PUB-${'a'.repeat(64)}`, state, revision: 1,
      origin: { type: 'owner-publication', relativePath: 'Notes/Page.md' },
      recovery: { instruction: 'Safe recovery instruction.' }, failure: null };
    const app = await handler(data, { lookupJob: async () => job });
    const html = await (await app.fetch(request(`/owner/jobs/${job.jobId}`, { cookie: app.cookie }))).text();
    expect(html).toContain(`<h2 id="job-stage">${copy}</h2>`);
    expect(html).toContain('<summary>Details for the record</summary>');
    expect(html).toContain('<header class="publication-heading"><h1>Page</h1></header>');
    expect(html.indexOf('Notes/Page.md')).toBeGreaterThan(html.indexOf('<details'));
    expect((html.match(/>Back to your page<\/a>/gu) ?? []).length).toBe(1);
    expect(html).not.toContain('class="publication-button"');
    expect(html.indexOf('id="job-state"')).toBeGreaterThan(html.indexOf('<details'));
    expect(html).toContain('Safe recovery instruction.');
    if (['failed', 'manual-intervention', 'cancelled'].includes(state)) {
      expect((html.match(/data-status="unknown"/gu) ?? []).length).toBe(6);
      expect(html).not.toContain('data-status="pending"');
    }
    expect(html).not.toContain('Open the live page'); // Public job has no bound live URL.
    expect(html).toContain('/owner/assets/publication.js');
    privateAbsent(html);
  }
});

test('original byte inconsistency or missing pinned base disables publication without losing exact evidence', async () => {
  const data = await publicationFixture(); const { draft } = await data.prepare();
  for (const corrupt of ['old', 'candidate', 'offset', 'noBase']) {
    const bad = structuredClone(draft);
    if (corrupt === 'old') bad.prepared.operation.expectedOldBytesBase64 = Buffer.from('wrong').toString('base64');
    if (corrupt === 'candidate') bad.prepared.candidate.text += 'wrong';
    if (corrupt === 'offset') bad.prepared.operation.start = -1;
    if (corrupt === 'noBase') bad.prepared.session.source.text = null;
    const app = await handler(data, { service: { ...data.runtime, load: async () => bad } });
    const html = await (await app.fetch(request(`/owner/publication/${draft.draftId}`, { cookie: app.cookie }))).text();
    expect(html).toContain('Publish is disabled.'); expect(html).toContain('Authoritative exact operation');
    expect(html).toContain('Entire proposed version'); expect(html).not.toContain('id="publication-form"');
    expect(html).not.toContain('<dialog id="publication-dialog"'); expect(html).toContain('The new value.'); privateAbsent(html);
  }
});

test('reader errors and hostile dependency codes/messages never become HTTP error details', async () => {
  const data = await publicationFixture(); data.setUnavailable(); const app = await handler(data);
  const response = await app.post('/api/publication/prepare', { mappingId: MAPPING.id, csrf: CSRF }); expect(response.status).toBe(409); privateAbsent(await response.text());
  const service = { ...data.runtime, publish() { throw Object.assign(new Error(PRIVATE_PATH), { code: PRIVATE_ID }); } };
  const other = await handler(data, { service }); const refusal = await other.post('/api/publication/publish', { draftId: 'a'.repeat(64), csrf: CSRF }); privateAbsent(await refusal.text());
});
