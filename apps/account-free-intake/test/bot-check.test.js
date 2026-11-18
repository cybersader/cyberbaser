import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { openIntakeService } from '../src/server.js';
import { configInput, createFixture, FORM_ORIGIN, request } from './helpers.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});
const SECRET = 'synthetic-server-only-secret';
const TOKEN = 'synthetic-browser-token';
const valid = { success: true, hostname: 'wiki.example', action: 'suggest-correction' };
const receipt = {
  queueId: 'Q-00000000-0000-4000-8000-000000000001',
  proposalDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
  receivedAt: '2026-08-10T12:00:00Z', expiresAt: '2026-09-09T12:00:00Z',
};
function intent() {
  return {
    schemaVersion: 1, artifactType: 'cyberbaser-account-free-correction-intent',
    bindingDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    pageId: `page-v1:${'A'.repeat(43)}`, selection: { quote: 'old', prefix: null, suffix: null },
    replacement: 'new', rationale: 'Correct this text.', evidence: [], idempotencyKey: 'A'.repeat(32),
  };
}
function post({ token = TOKEN, ...headers } = {}) {
  return request('/v1/corrections', {
    method: 'POST', origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { 'Cyberbaser-Challenge-Token': token }), ...headers },
    body: JSON.stringify(intent()),
  });
}
async function setup({ enabled = true, fetch = async () => Response.json(valid), timeoutMs = 3000, clientAddress, limits = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-challenge-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const secretFile = path.join(root, 'secret');
  await writeFile(secretFile, `${SECRET}\n`, { mode: 0o600 });
  const raw = configInput(root, {
    botCheck: enabled ? { provider: 'turnstile', secretFile, expectedHostnames: ['wiki.example'], expectedAction: 'suggest-correction', timeoutMs: 3000 } : null,
    ...(clientAddress ? { clientAddress } : {}),
  });
  raw.limits = { ...raw.limits, ...limits };
  const checked = validateConfig(raw);
  const config = enabled ? { ...checked, botCheck: { ...checked.botCheck, timeoutMs } } : checked;
  let queueCalls = 0;
  const service = await openIntakeService({
    config, validatePaths: false, fetch,
    queue: { async enqueue() { queueCalls += 1; return { replayed: true, receipt }; }, async close() {} },
    bindings: { resolve() { throw new Error('must never derive a replay or rejected request'); } },
  });
  cleanups.push(() => service.close());
  return { service, config, secretFile, queueCalls: () => queueCalls };
}

test('bot check off retains the header-free flow and never calls siteverify', async () => {
  const { service } = await setup({ enabled: false, fetch() { throw new Error('must not call'); } });
  expect((await service.fetch(post({ token: null }))).status).toBe(200);
});

test('valid bot check posts canonical fields and honors only a trusted client header', async () => {
  const calls = [];
  const { service } = await setup({
    clientAddress: { source: 'header', header: 'cf-connecting-ip', trustedPeers: ['10.20.0.0/16'] },
    fetch: async (url, options) => { calls.push({ url, options }); return Response.json(valid); },
  });
  const response = await service.fetch(post({ 'cf-connecting-ip': '198.51.100.7' }), { address: '10.20.1.2' });
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  expect(calls[0].options.method).toBe('POST');
  expect(calls[0].options.redirect).toBe('error');
  expect(calls[0].options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(Object.fromEntries(calls[0].options.body)).toEqual({ secret: SECRET, response: TOKEN, remoteip: '198.51.100.7' });
  expect(await response.text()).not.toContain(SECRET);
});

test.each([
  ['untrusted', '203.0.113.4', '198.51.100.7'],
  ['malformed', '10.20.1.2', '198.51.100.7, 192.0.2.1'],
])('%s peer/header falls back to socket for Turnstile remoteip', async (_, peer, header) => {
  let fields;
  const { service } = await setup({
    clientAddress: { source: 'header', header: 'cf-connecting-ip', trustedPeers: ['10.20.0.0/16'] },
    fetch: async (_url, options) => { fields = Object.fromEntries(options.body); return Response.json(valid); },
  });
  expect((await service.fetch(post({ 'cf-connecting-ip': header }), { address: peer })).status).toBe(200);
  expect(fields.remoteip).toBe(peer);
});

test.each([null, '', 'two,tokens', 'token with spaces', 'x'.repeat(2049)])('missing or malformed challenge token fails before siteverify', async (token) => {
  let calls = 0;
  const { service, queueCalls } = await setup({ fetch: async () => { calls += 1; return Response.json(valid); } });
  const response = await service.fetch(post({ token }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: 'challenge-failed' } });
  expect(calls).toBe(0);
  expect(queueCalls()).toBe(0);
});

test.each([
  { ...valid, success: false }, { ...valid, success: 'true' },
  { ...valid, hostname: 'evil.example' }, { ...valid, action: 'login' }, null,
])('rejects unsuccessful or incorrectly bound siteverify results', async (result) => {
  const { service, queueCalls } = await setup({ fetch: async () => Response.json(result) });
  const response = await service.fetch(post());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: 'challenge-failed' } });
  expect(queueCalls()).toBe(0);
});

test.each(['network', 'non-json', 'http', 'timeout', 'slow-json'])('siteverify %s failure returns only challenge-unavailable', async (kind) => {
  let signal;
  const logs = [];
  const spies = ['log', 'warn', 'error'].map((method) => spyOn(console, method).mockImplementation((...args) => logs.push(args.join(' '))));
  try {
    const { service, queueCalls } = await setup({ timeoutMs: 15, fetch: async (_url, options) => {
      signal = options.signal;
      if (kind === 'network') throw new Error(SECRET);
      if (kind === 'http') return new Response(SECRET, { status: 502 });
      if (kind === 'non-json') return new Response(SECRET);
      if (kind === 'slow-json') return { ok: true, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    } });
    const response = await service.fetch(post());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":{"code":"challenge-unavailable"}}\n');
    expect(queueCalls()).toBe(0);
    if (kind === 'timeout' || kind === 'slow-json') expect(signal.aborted).toBe(true);
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(TOKEN);
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});

test('bot verification shares the enclosing deadline, even if the injected fetch ignores abort', async () => {
  const { service, config } = await setup({ fetch: async () => new Promise(() => {}) });
  config.limits = { ...config.limits, requestTimeoutMs: 15 };
  const response = await service.fetch(post());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: 'challenge-unavailable' } });
});

test.each([false, true])('preflight includes challenge header only when enabled=%s', async (enabled) => {
  const { service } = await setup({ enabled });
  for (const requested of ['Content-Type', 'Content-Type, Cyberbaser-Challenge-Token']) {
    const response = await service.fetch(request('/v1/corrections', {
      method: 'OPTIONS', origin: FORM_ORIGIN,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': requested },
    }));
    expect(response.status).toBe(!enabled && requested.includes(',') ? 403 : 204);
    if (response.status === 204) {
      expect(response.headers.get('access-control-allow-headers')).toBe(enabled ? 'content-type, cyberbaser-challenge-token' : 'content-type');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    }
  }
});

test('cheap host, origin, method, and body checks precede siteverify', async () => {
  let calls = 0;
  const { service } = await setup({ fetch: async () => { calls += 1; return Response.json(valid); } });
  for (const req of [
    request('/v1/corrections', { method: 'GET' }),
    request('/v1/corrections', { method: 'POST', host: 'evil.example', origin: FORM_ORIGIN, body: '{}' }),
    request('/v1/corrections', { method: 'POST', origin: 'https://evil.example', body: '{}' }),
    post({ 'Content-Length': '98305' }),
  ]) expect((await service.fetch(req)).status).not.toBe(200);
  expect(calls).toBe(0);
});

test('secret files fail closed on startup without exposing their contents', async () => {
  const { config, secretFile } = await setup();
  const link = `${secretFile}.link`;
  await symlink(secretFile, link);
  for (const file of [link, path.dirname(secretFile)]) {
    await expect(openIntakeService({ config: { ...config, botCheck: { ...config.botCheck, secretFile: file } }, validatePaths: false })).rejects.toThrow(/symlink-free secret file/);
  }
  await writeFile(secretFile, `${SECRET} invalid whitespace`);
  try {
    await openIntakeService({ config, validatePaths: false });
    throw new Error('expected startup failure');
  } catch (error) {
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('secret file');
  }
});

test('valid challenge gates real durable derivation without retaining token or secret', async () => {
  const fixture = await createFixture();
  cleanups.push(fixture.cleanup);
  const secretFile = path.join(fixture.root, 'turnstile.secret');
  await writeFile(secretFile, SECRET, { mode: 0o600 });
  const config = validateConfig(configInput(fixture.root, {
    botCheck: { provider: 'turnstile', secretFile, expectedHostnames: ['wiki.example'], expectedAction: 'suggest-correction', timeoutMs: 3000 },
  }));
  const service = await openIntakeService({ config, fetch: async () => Response.json(valid) });
  cleanups.push(() => service.close());
  const response = await service.fetch(request('/v1/corrections', {
    method: 'POST', origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json', 'Cyberbaser-Challenge-Token': TOKEN },
    body: JSON.stringify(fixture.intent()),
  }), { address: '192.0.2.10' });
  expect(response.status).toBe(202);
  const text = await response.text();
  const entry = await service.queue.load(JSON.parse(text).receipt.queueId);
  for (const value of [text, JSON.stringify(entry)]) {
    expect(value).not.toContain(SECRET);
    expect(value).not.toContain(TOKEN);
    expect(value).not.toContain('192.0.2.10');
  }
});


test('sender rejection happens before siteverify, even when prior tokens were missing', async () => {
  let calls = 0;
  const { service } = await setup({ limits: { perSenderCapacity: 1 }, fetch: async () => { calls += 1; return Response.json(valid); } });
  expect((await service.fetch(post({ token: null }), { address: '192.0.2.1' })).status).toBe(403);
  const limited = await service.fetch(post(), { address: '192.0.2.1' });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ error: { code: 'rate-limited' } });
  expect(calls).toBe(0);
});

test('network rejection precedes siteverify across distinct senders', async () => {
  let calls = 0;
  const { service } = await setup({ limits: { perNetworkCapacity: 1 }, fetch: async () => { calls += 1; return Response.json(valid); } });
  expect((await service.fetch(post(), { address: '192.0.2.1' })).status).toBe(200);
  const limited = await service.fetch(post(), { address: '192.0.2.2' });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ error: { code: 'rate-limited' } });
  expect(calls).toBe(1);
});

test('failed challenges do not consume page quota; page admission follows verification', async () => {
  let calls = 0;
  const { service, queueCalls } = await setup({ limits: { perSenderCapacity: 10 }, fetch: async () => {
    calls += 1;
    return Response.json(calls === 1 ? { ...valid, success: false } : valid);
  } });
  expect((await service.fetch(post())).status).toBe(403);
  expect((await service.fetch(post())).status).toBe(200);
  expect((await service.fetch(post())).status).toBe(200);
  const limited = await service.fetch(post());
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ error: { code: 'rate-limited' } });
  expect(calls).toBe(4);
  expect(queueCalls()).toBe(2);
});
