import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computePolicyRevision, validateOwnerAlphaConfig } from '../src/config.js';
import { createOwnerAlphaHandler, createMemoryEditSessionStore } from '../src/server.js';
import { createOwnerHandoffStore, deriveOwnerDirect, authorizeOwnerDirect, guardOwnerDirect, validateOwnerHandoff } from '../src/owner-direct.js';
import { defineStoreContext } from '../src/store.js';
import { readJsonArtifact } from '../src/artifacts.js';
import { applyEditorOperation } from '../src/operation.js';

const cleanups = [];
afterEach(async () => { for (const root of cleanups.splice(0)) await rm(root, { recursive: true, force: true }); });
const text = '# Page\n\nA **bold** block.\n\nCorrect teh typo.\n\nUntouched\t tail 😀.\n';
const base = Buffer.from(text);
const operations = [
  { operationId: 'source-block-1', start: base.indexOf('**bold**'), end: base.indexOf('**bold**') + 8, expected: '**bold**', replacement: '*bold*' },
  { operationId: 'edit-2', start: base.indexOf('teh'), end: base.indexOf('teh') + 3, expected: 'teh', replacement: 'the' },
];
const origin = 'http://127.0.0.1:4317';
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cb-owner-direct-')); cleanups.push(root);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
  const raw = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url)));
  raw.repository.checkout = path.join(root, 'vault');
  const config = validateOwnerAlphaConfig(raw);
  const context = defineStoreContext({ projectRoot: root, workspaceRoot: path.join(root, config.workspace.root), storeRoot: path.join(root, config.workspace.store) });
  const session = { schemaVersion: 1, artifactType: 'owner-alpha-edit-session', relativePath: 'docs/page.md', slug: 'docs/page', liveUrl: 'https://example.org/docs/page', baseCommit: '1'.repeat(40), policyRevision: computePolicyRevision(config), source: { text, bytesBase64: base.toString('base64'), byteLength: base.length, digest: `sha-256=:${createHash('sha256').update(base).digest('base64')}:`, frontmatter: null } };
  const handoff = { source: { path: session.relativePath, byteLength: base.length, sha256: createHash('sha256').update(base).digest('hex') }, revision: session.baseCommit, slug: session.slug, operations };
  let calls = 0;
  const handler = createOwnerAlphaHandler({ config, projectRoot: root, createEditSession: async () => session,
    saveEdit: async input => { calls++; await guardOwnerDirect({ context, config, ...input }); return { jobId: input.jobId, state: 'accepted' }; }, lookupJob: async () => null });
  const request = (url, { method = 'GET', cookie, requestOrigin, body, type = 'application/json' } = {}) => handler(new Request(`${origin}${url}`, { method, headers: { Host: new URL(origin).host, ...(cookie ? { Cookie: cookie } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(body ? { 'Content-Type': type } : {}) }, body }));
  const bootstrap = await request(`/owner/bootstrap?token=${handler.bootstrapToken}`);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const stage = async (value = handoff) => request('/owner/stage', { method: 'POST', requestOrigin: 'https://hostile.example', type: 'application/x-www-form-urlencoded', body: new URLSearchParams({ changeSet: JSON.stringify(value) }).toString() });
  return { root, context, config, session, handoff, handler, request, cookie, stage, calls: () => calls };
}

test('inert cross-origin staging needs an authenticated owner review and exact Origin plus CSRF to Save', async () => {
  const f = await fixture();
  const staged = await f.stage(); expect(staged.status).toBe(303); expect(f.calls()).toBe(0);
  const location = staged.headers.get('location');
  expect((await f.request(location)).status).toBe(403);
  const review = await f.request(location, { cookie: f.cookie }); expect(review.status).toBe(200);
  const markup = await review.text();
  expect(review.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  expect(markup).toContain('<del>**bold**</del><ins>*bold*</ins>');
  const editId = /data-edit-id="([^"]+)"/.exec(markup)[1], csrf = /data-csrf="([^"]+)"/.exec(markup)[1];
  for (const denied of [
    { requestOrigin: origin, body: JSON.stringify({ editId, csrf }) },
    { cookie: f.cookie, requestOrigin: 'http://127.0.0.1:4318', body: JSON.stringify({ editId, csrf }) },
    { cookie: f.cookie, requestOrigin: origin, body: JSON.stringify({ editId, csrf: '' }) },
    { cookie: f.cookie, requestOrigin: origin, body: JSON.stringify({ editId }) },
  ]) {
    expect([400, 403]).toContain((await f.request('/api/owner-direct', { method: 'POST', ...denied })).status);
    expect(f.calls()).toBe(0);
  }
  const secondLogin = await f.request(`/owner/bootstrap?token=${f.handler.issueBootstrap()}`);
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  const secondReview = await f.request(location, { cookie: secondCookie });
  const secondCsrf = /data-csrf="([^"]+)"/.exec(await secondReview.text())[1];
  expect((await f.request('/api/owner-direct', { method: 'POST', cookie: secondCookie, requestOrigin: origin, body: JSON.stringify({ editId, csrf: secondCsrf }) })).status).toBe(410);
  expect(f.calls()).toBe(0);
  const saved = await f.request('/api/owner-direct', { method: 'POST', cookie: f.cookie, requestOrigin: origin, body: JSON.stringify({ editId, csrf }) });
  expect(saved.status).toBe(202); expect(f.calls()).toBe(1);
  expect((await f.request('/api/owner-direct', { method: 'POST', cookie: f.cookie, requestOrigin: origin, body: JSON.stringify({ editId, csrf }) })).status).toBe(410);
});

test('stale rendered revision or bytes fail before owner confirmation and never call Save', async () => {
  const f = await fixture();
  for (const value of [{ ...f.handoff, revision: '2'.repeat(40) }, { ...f.handoff, source: { ...f.handoff.source, sha256: '0'.repeat(64) } }]) {
    const staged = await f.stage(value);
    const result = await f.request(staged.headers.get('location'), { cookie: f.cookie });
    expect(result.status).toBe(409); expect((await result.json()).error.code).toBe('owner-direct-stale-base');
  }
  expect(f.calls()).toBe(0);
});

test('owner-direct immutable authority binds all exact operations, session and policy during recovery', async () => {
  const f = await fixture();
  const derived = deriveOwnerDirect(f);
  const session = await authorizeOwnerDirect({ context: f.context, jobId: 'OA-direct-test', ...derived });
  await guardOwnerDirect({ context: f.context, config: f.config, jobId: 'OA-direct-test', session, operation: derived.operation });
  const record = await readJsonArtifact(f.context, 'owner-direct/OA-direct-test.json');
  expect(record.authority).toBe('owner-direct'); expect(record.source.baseCommit).toBe(f.session.baseCommit);
  expect(record.operationsDigest).toMatch(/^sha256:/);
  expect(applyEditorOperation(session, derived.operation).toString()).toBe(text.replace('**bold**', '*bold*').replace('teh', 'the'));
  await expect(authorizeOwnerDirect({ context: f.context, jobId: 'OA-direct-test', ...derived })).rejects.toHaveProperty('code', 'artifact-already-exists');
  const modified = structuredClone(derived.operation); modified.proposal.changeSet.files[0].operations[1].replacement = 'bad';
  await expect(guardOwnerDirect({ context: f.context, config: f.config, jobId: 'OA-direct-test', session, operation: modified })).rejects.toHaveProperty('code', 'owner-direct-authority-mismatch');
  await expect(guardOwnerDirect({ context: f.context, config: f.config, jobId: 'OA-other', session, operation: derived.operation })).rejects.toHaveProperty('code', 'owner-direct-authority-mismatch');
  await rm(path.join(f.context.storeRoot, 'owner-direct/OA-direct-test.json'));
  await expect(guardOwnerDirect({ context: f.context, config: f.config, jobId: 'OA-direct-test', session, operation: derived.operation })).rejects.toHaveProperty('code', 'artifact-not-found');
});

test('handoff storage is bounded, expires and holds no durable authority', () => {
  let now = 0;
  const store = createOwnerHandoffStore({ now: () => now, ttl: 10, maximum: 1, createId: () => 'a'.repeat(43) });
  const id = store.create({ harmless: true }); expect(store.get(id)).toEqual({ harmless: true });
  expect(() => store.create({})).toThrow(); now = 11; expect(store.get(id)).toBeNull();
  expect(store.create({})).toBe(id);
  expect(() => validateOwnerHandoff({})).toThrow();
});
