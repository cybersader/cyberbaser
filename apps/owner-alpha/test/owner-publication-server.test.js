import { afterEach, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateOwnerAlphaConfig, computePolicyRevision } from '../src/config.js';
import { createJsonArtifactOnce } from '../src/artifacts.js';
import { initializeDurableJob } from '../src/job-state.js';
import { canonicalJson } from '../src/json.js';
import { createSaveHandler, pipelineArtifactPaths } from '../src/pipeline.js';
import { createOwnerAlphaHandler, runOwnerAlphaServer } from '../src/server.js';
import { EDITED, MAPPING, PRIVATE_ID, PRIVATE_PATH, cleanup, publicationFixture } from './publication-fixture.js';

const ORIGIN = 'http://127.0.0.1:4317';
const CSRF = 'b'.repeat(43);
const TOKEN = 'c'.repeat(43);
function request(path, { method = 'GET', cookie, body, headers = {} } = {}) {
  return new Request(`${ORIGIN}${path}`, { method, headers: { Host: '127.0.0.1:4317',
    ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}), ...headers },
    body: typeof body === 'object' ? JSON.stringify(body) : body });
}
function privateAbsent(text) { expect(text).not.toContain(PRIVATE_ID); expect(text).not.toContain(PRIVATE_PATH); expect(text).not.toContain('"reference"'); }
async function handler(data, { enabled = true, service = data.runtime } = {}) {
  const raw = structuredClone(data.config); if (!enabled) raw.ownerPublication = { enabled: false };
  const tokens = ['a'.repeat(43), CSRF, TOKEN]; let index = 0;
  const fetch = createOwnerAlphaHandler({ config: validateOwnerAlphaConfig(raw), projectRoot: data.root,
    saveEdit: data.pipeline.saveEdit, lookupJob: data.pipeline.getJob, ownerPublication: service,
    createToken: () => tokens[index++],
    createEditSession: async () => ({ source: { text: '# Plain edit\n' } }) });
  const bootstrap = await fetch(request(`/owner/bootstrap?token=${TOKEN}`));
  return { fetch, bootstrap, cookie: bootstrap.headers.get('set-cookie').split(';')[0],
    post: (path, body, headers) => fetch(request(path, { method: 'POST', cookie: bootstrap.headers.get('set-cookie').split(';')[0], body, headers })) };
}
afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test('enabled normal owner entry links exact review, with safe modes and no private source reference in HTML or JSON', async () => {
  const data = await publicationFixture(); const app = await handler(data);
  expect(app.bootstrap.headers.get('location')).toBe('/owner/publication');
  const landing = await app.fetch(request('/owner/publication', { cookie: app.cookie }));
  expect(landing.headers.get('content-security-policy')).toContain("script-src 'self'");
  const page = await landing.text(); privateAbsent(page); expect(page).toContain('Prepare exact review');
  const edit = await app.fetch(request('/owner/edit?relativePath=Notes%2FPage.md&slug=Notes%2Fpage', { cookie: app.cookie }));
  expect(await edit.text()).toContain('href="/owner/publication"');
  const prep = await app.post('/api/publication/prepare', { mappingId: MAPPING.id, csrf: CSRF });
  expect(prep.status).toBe(201); const preparedText = await prep.text(); privateAbsent(preparedText); const prepared = JSON.parse(preparedText);
  for (const mode of ['changes', 'proposed', 'current', 'compare']) {
    const response = await app.fetch(request(`${prepared.reviewUrl}?mode=${mode}`, { cookie: app.cookie }));
    expect(response.status).toBe(200); const html = await response.text(); privateAbsent(html);
    expect(html).toContain('structural reading, not the published page'); expect(html).toContain('Captured authoring version 7');
    expect(html).toContain('Publish this captured version');
    expect(html).not.toContain('Apply to page');
  }
  const asset = await app.fetch(request('/owner/assets/publication.js', { cookie: app.cookie })); expect(asset.status).toBe(200);
});

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
  const service = Object.fromEntries(['prepare', 'load', 'publish', 'readJob'].map((key) => [key, () => { calls += 1; throw new Error(PRIVATE_ID); }]));
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
  const job = await app.fetch(request(receipt.statusUrl, { cookie: app.cookie })); const html = await job.text(); privateAbsent(html); expect(html).toContain('Publishing your page');
  const json = await app.fetch(request(`/api/jobs/${draft.jobId}`, { cookie: app.cookie })); const safe = await json.text(); privateAbsent(safe); expect(JSON.parse(safe).origin).toEqual({ type: 'owner-publication', relativePath: MAPPING.relativePath });
  data.setSource(); data.renderGate.resolve({ ok: true }); await data.completion;
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

test('reader errors and hostile dependency codes/messages never become HTTP error details', async () => {
  const data = await publicationFixture(); data.setUnavailable(); const app = await handler(data);
  const response = await app.post('/api/publication/prepare', { mappingId: MAPPING.id, csrf: CSRF }); expect(response.status).toBe(409); privateAbsent(await response.text());
  const service = { ...data.runtime, publish() { throw Object.assign(new Error(PRIVATE_PATH), { code: PRIVATE_ID }); } };
  const other = await handler(data, { service }); const refusal = await other.post('/api/publication/publish', { draftId: 'a'.repeat(64), csrf: CSRF }); privateAbsent(await refusal.text());
});
