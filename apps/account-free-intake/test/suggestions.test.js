import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyChangeSetProposal, parseVersionedProposal } from '@cyberbaser/proposal';
import { validateConfig } from '../src/config.js';
import { openIntakeService } from '../src/server.js';
import { createReviewIpcHandler } from '../src/review-ipc.js';
import { renderListText, renderListHtml, renderShowText, renderShowHtml } from '../src/review.js';
import { createFixture, configInput, FORM_ORIGIN, request, SOURCE_PATH } from './helpers.js';

const BASE = '# Notes\r\n\r\nCorrect teh typo. 🙂\r\nLast line.\r\n';
const operations = [['teh', 'the'], ['🙂', '😀']].map(([expected, replacement], i) => {
  const start = Buffer.from(BASE).indexOf(Buffer.from(expected));
  return { operationId: `edit-${i}`, start, end: start + Buffer.byteLength(expected), expected, replacement };
});
function intent(fixture, overrides = {}) {
  return {
    schemaVersion: 2, artifactType: 'cyberbaser-account-free-correction-intent',
    bindingDigest: fixture.bindingDigest, pageId: fixture.pageId,
    operations, idempotencyKey: 'A'.repeat(32), ...overrides,
  };
}
function post(value, endpoint = '/v2/suggestions') {
  return request(endpoint, { method: 'POST', origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}
const peer = { address: '192.0.2.1' };
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const ipcRequest = (value) => Buffer.from(`${canonical({ schemaVersion: 1, ...value })}\n`);

async function fixtureService(limits = {}) {
  const fixture = await createFixture({ pages: [{ path: SOURCE_PATH, text: BASE }] });
  const config = validateConfig(configInput(fixture.root, {
    limits: { ...configInput(fixture.root).limits, perSenderCapacity: 100, perNetworkCapacity: 100, perPageCapacity: 100, ...limits },
  }));
  let service;
  try { service = await openIntakeService({ config }); }
  catch (error) { await fixture.cleanup(); throw error; }
  return { fixture, config, service, async close() { await service.close(); await fixture.cleanup(); } };
}

test('v2 HTTP submission stores one exact artifact, replays one receipt, and survives mixed-version recovery and IPC', async () => {
  const item = await fixtureService();
  let reopened;
  try {
    const response = await item.service.fetch(post(intent(item.fixture)), peer);
    expect(response.status).toBe(202);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(FORM_ORIGIN);
    const { receipt } = await response.json();
    const replay = await item.service.fetch(post(intent(item.fixture)), peer);
    expect(replay.status).toBe(200);
    expect((await replay.json()).receipt).toEqual(receipt);
    expect(item.service.stats().pendingEntries).toBe(1);
    const changed = await item.service.fetch(post(intent(item.fixture, { rationale: 'Changed request.' })), peer);
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe('idempotency-conflict');
    const entry = await item.service.review.load(receipt.queueId);
    const stored = await readFile(path.join(item.fixture.root, 'queue', 'pending', receipt.queueId, 'proposal.json'));
    expect(stored.toString()).toBe(entry.proposalText);
    const parsed = parseVersionedProposal(stored);
    expect(parsed.version).toBe(2);
    expect(parsed.proposal.changeSet.files[0].operations).toEqual(operations);
    expect(applyChangeSetProposal(Buffer.from(BASE), parsed.proposal).toString()).toBe(BASE.replace('teh', 'the').replace('🙂', '😀'));
    expect(entry.classification.classification).toMatchObject({ route: 'full-review', tier: 'anonymous' });
    const old = item.fixture.intent({ idempotencyKey: null });
    expect((await item.service.fetch(post(old, '/v1/corrections'), peer)).status).toBe(202);
    expect(item.service.stats().pendingEntries).toBe(2);
    await item.service.close();
    reopened = await openIntakeService({ config: item.config });
    const mixed = await reopened.review.list();
    expect(mixed.map((e) => e.proposal.schemaVersion).sort()).toEqual([1, 2]);
    expect((await reopened.review.load(receipt.queueId)).proposalText).toBe(stored.toString());
    const handle = createReviewIpcHandler({ review: reopened.review });
    const listed = JSON.parse((await handle(ipcRequest({ operation: 'list', state: null, cursor: null, limit: 100 }))).toString());
    expect(listed.entries.map((e) => e.proposalVersion).sort()).toEqual([1, 2]);
    const loaded = JSON.parse((await handle(ipcRequest({ operation: 'load', queueId: receipt.queueId }))).toString());
    expect(loaded.entry.proposalVersion).toBe(2);
    expect(loaded.entry.proposalText).toBe(stored.toString());
    expect(renderListText(mixed)).toContain(SOURCE_PATH);
    expect(renderListHtml(mixed)).toContain(SOURCE_PATH);
    expect(renderShowText(entry)).toContain('Operation: edit-1');
    expect(renderShowHtml(entry)).toContain('Operation edit-1');
    expect(renderShowHtml(entry)).toContain('😀');
  } finally { await reopened?.close(); await item.close(); }
});

test.each([0, 1])('v2 HTTP refuses mismatched expected bytes at operation %i without enqueue', async (index) => {
  const item = await fixtureService();
  try {
    const wrong = operations.map((op, i) => i === index ? { ...op, expected: 'x'.repeat(Buffer.byteLength(op.expected)) } : op);
    const response = await item.service.fetch(post(intent(item.fixture, { operations: wrong })), peer);
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('old-bytes-mismatch');
    expect(item.service.stats().pendingEntries).toBe(0);
  } finally { await item.close(); }
});

test.each([
  ['operation', { perSenderOperationBudget: 3 }],
  ['byte', { perSenderOperationBudget: 100, perSenderByteBudget: 14 }],
])('v2 %s work budget charges idempotent replays and returns 429', async (_, limits) => {
  const item = await fixtureService(limits);
  try {
    expect((await item.service.fetch(post(intent(item.fixture)), peer)).status).toBe(202);
    const response = await item.service.fetch(post(intent(item.fixture)), peer);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect((await response.json()).error.code).toBe('rate-limited');
    expect(item.service.stats().pendingEntries).toBe(1);
  } finally { await item.close(); }
});

test('v2 endpoint retains exact origin/preflight/credential boundaries and refuses version confusion', async () => {
  const item = await fixtureService();
  try {
    const preflight = await item.service.fetch(request('/v2/suggestions', {
      method: 'OPTIONS', origin: FORM_ORIGIN,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    }), peer);
    expect(preflight.status).toBe(204);
    expect((await item.service.fetch(post(intent(item.fixture), '/v1/corrections'), peer)).status).toBe(400);
    expect((await item.service.fetch(post(item.fixture.intent()), peer)).status).toBe(400);
    const forbidden = request('/v2/suggestions', { method: 'POST', origin: 'https://other.invalid', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent(item.fixture)) });
    expect((await item.service.fetch(forbidden, peer)).status).toBe(403);
    const cookie = post(intent(item.fixture)); cookie.headers.set('Cookie', 'x=y');
    expect((await item.service.fetch(cookie, peer)).status).toBe(400);
  } finally { await item.close(); }
});

test.each([
  ['overlap', [operations[0], { ...operations[1], start: operations[0].start + 1, end: operations[0].start + 5 }]],
  ['operation-count', Array.from({ length: 51 }, (_, i) => ({ operationId: `op-${i}`, start: i, end: i, expected: '', replacement: 'x' }))],
])('v2 HTTP refuses %s before source resolution', async (code, invalid) => {
  const item = await fixtureService();
  try {
    const response = await item.service.fetch(post(intent(item.fixture, { operations: invalid })), peer);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(code);
    expect(item.service.stats().pendingEntries).toBe(0);
  } finally { await item.close(); }
});


test('v1 and v2 consume the same sender work balance rather than independent endpoint credits', async () => {
  const item = await fixtureService({ perSenderOperationBudget: 2 });
  try {
    expect((await item.service.fetch(post(item.fixture.intent(), '/v1/corrections'), peer)).status).toBe(202);
    const blocked = await item.service.fetch(post(intent(item.fixture)), peer);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe('rate-limited');
    expect(item.service.stats().pendingEntries).toBe(1);
  } finally { await item.close(); }
});

test('v2 uses the same challenge header, binding and no-secret-retention boundary', async () => {
  const item = await fixtureService();
  let challenged;
  try {
    await item.service.close();
    const secretFile = path.join(item.fixture.root, 'synthetic-challenge-secret');
    await writeFile(secretFile, 'synthetic-intake-challenge-secret\n', { mode: 0o600 });
    const config = validateConfig(configInput(item.fixture.root, {
      botCheck: { provider: 'turnstile', secretFile, expectedHostnames: ['wiki.example'], expectedAction: 'suggest-correction', timeoutMs: 3000 },
    }));
    let calls = 0;
    challenged = await openIntakeService({ config, fetch: async (_url, options) => {
      calls += 1;
      expect(options.body.get('response')).toBe('synthetic-browser-token');
      expect(options.body.get('remoteip')).toBe(peer.address);
      return Response.json({ success: true, hostname: 'wiki.example', action: 'suggest-correction' });
    } });
    const preflight = await challenged.fetch(request('/v2/suggestions', { method: 'OPTIONS', origin: FORM_ORIGIN,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, cyberbaser-challenge-token' } }), peer);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('cyberbaser-challenge-token');
    expect((await challenged.fetch(post(intent(item.fixture)), peer)).status).toBe(403);
    expect(calls).toBe(0);
    const approved = post(intent(item.fixture)); approved.headers.set('Cyberbaser-Challenge-Token', 'synthetic-browser-token');
    const response = await challenged.fetch(approved, peer);
    expect(response.status).toBe(202);
    expect(calls).toBe(1);
    const { receipt } = await response.json();
    const entry = await challenged.review.load(receipt.queueId);
    expect(JSON.stringify(entry)).not.toContain('synthetic-browser-token');
    expect(JSON.stringify(entry)).not.toContain('synthetic-intake-challenge-secret');
  } finally { await challenged?.close(); await item.close(); }
});

test('v2 shares bounded streaming deadline behavior', async () => {
  const checked = validateConfig(configInput('/srv/cyberbaser/intake-v2-deadline'));
  const service = await openIntakeService({
    config: { ...checked, limits: { ...checked.limits, requestTimeoutMs: 25 } },
    validatePaths: false, queue: { enqueue: async () => { throw new Error('must not reach queue'); }, close: async () => {} },
    bindings: { resolve: async () => { throw new Error('must not resolve source'); } },
  });
  try {
    const body = new ReadableStream({ pull: () => new Promise(() => {}) });
    const response = await service.fetch(request('/v2/suggestions', { method: 'POST', origin: FORM_ORIGIN,
      headers: { 'Content-Type': 'application/json' }, body }), peer);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('request-deadline');
  } finally { await service.close(); }
});
