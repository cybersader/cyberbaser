import { expect, test } from 'bun:test';
import { openIntakeService } from '../src/server.js';
import { configInput, FORM_ORIGIN, request } from './helpers.js';
import { validateConfig } from '../src/config.js';
import { createLayeredAbuseLimiter } from '../src/abuse.js';
import { parseIp } from '../src/client-address.js';

const config = validateConfig(configInput('/srv/cyberbaser/account-free-test'));
const receipt = Object.freeze({
  queueId: 'Q-00000000-0000-4000-8000-000000000001',
  proposalDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
  receivedAt: '2026-08-10T12:00:00Z',
  expiresAt: '2026-09-09T12:00:00Z',
});

function intent() {
  return {
    schemaVersion: 1,
    artifactType: 'cyberbaser-account-free-correction-intent',
    bindingDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    pageId: `page-v1:${'A'.repeat(43)}`,
    selection: { quote: 'old', prefix: null, suffix: null },
    replacement: 'new',
    rationale: 'Correct this text.',
    evidence: [],
    idempotencyKey: 'A'.repeat(32),
  };
}

function post() {
  return request('/v1/corrections', {
    method: 'POST',
    origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(intent()),
  });
}

function fakeQueue(enqueue) {
  return Object.freeze({
    enqueue,
    stats: () => Object.freeze({ pendingEntries: 0, expiredEntries: 0, retainedBytes: 0, sourcePartitions: 0 }),
    close: async () => {},
  });
}

test('global token bucket bounds all public preflights', async () => {
  const service = await openIntakeService({
    config,
    validatePaths: false,
    bindings: Object.freeze({ resolve: async () => null }),
    queue: fakeQueue(async () => ({ replayed: false, receipt: null })),
  });
  try {
    for (let index = 0; index < 20; index += 1) {
      const response = await service.fetch(request('/v1/corrections', {
        method: 'OPTIONS',
        origin: FORM_ORIGIN,
        headers: {
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }));
      expect(response.status).toBe(204);
    }
    const limited = await service.fetch(request('/v1/corrections', {
      method: 'OPTIONS',
      origin: FORM_ORIGIN,
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(await limited.json()).toEqual({ error: { code: 'rate-limited' } });
  } finally {
    await service.close();
  }
});

test('rejects a fifth active public request globally', async () => {
  const waiting = [];
  const service = await openIntakeService({
    config: { ...config, limits: { ...config.limits, perSenderCapacity: 10, perPageCapacity: 10 } },
    validatePaths: false,
    bindings: Object.freeze({ resolve: async () => null }),
    queue: fakeQueue(() => new Promise((resolve) => waiting.push(resolve))),
  });
  try {
    const active = [service.fetch(post()), service.fetch(post()), service.fetch(post()), service.fetch(post())];
    while (waiting.length < 4) await Bun.sleep(1);
    const limited = await service.fetch(post());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: 'too-many-active-requests' } });
    for (const resolve of waiting) resolve({ replayed: true, receipt });
    expect((await Promise.all(active)).map((response) => response.status)).toEqual([200, 200, 200, 200]);
  } finally {
    await service.close();
  }
});

async function layeredService(limits = {}, options = {}) {
  let time = 0;
  const service = await openIntakeService({
    config: { ...config, limits: { ...config.limits, ...limits } },
    validatePaths: false,
    now: () => time,
    bindings: { resolve() { throw new Error('replays must not derive'); } },
    queue: fakeQueue(async () => ({ replayed: true, receipt })),
    ...options,
  });
  return { service, advance(ms) { time += ms; } };
}

async function assertRateLimited(response) {
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: { code: 'rate-limited' } });
}

test('per-sender bucket returns 429 and refills with an injected clock', async () => {
  const { service, advance } = await layeredService({ perPageCapacity: 100 });
  const peer = { address: '192.0.2.1' };
  try {
    for (let i = 0; i < 3; i++) expect((await service.fetch(post(), peer)).status).toBe(200);
    await assertRateLimited(await service.fetch(post(), peer));
    // A different sender in the same network remains independently eligible.
    expect((await service.fetch(post(), { address: '192.0.2.2' })).status).toBe(200);
    advance(1_200_000);
    expect((await service.fetch(post(), peer)).status).toBe(200);
    await assertRateLimited(await service.fetch(post(), peer));
  } finally { await service.close(); }
});

test.each(['ipv4', 'ipv6'])('per-network %s bucket returns 429 across senders and refills', async (family) => {
  const { service, advance } = await layeredService({ perPageCapacity: 100 });
  const address = (i) => family === 'ipv4' ? `192.0.2.${i}` : `2001:db8:1:2::${i.toString(16)}`;
  try {
    for (let i = 1; i <= 10; i++) expect((await service.fetch(post(), { address: address(i) })).status).toBe(200);
    await assertRateLimited(await service.fetch(post(), { address: address(11) }));
    const otherNetwork = family === 'ipv4' ? '192.0.3.1' : '2001:db8:1:3::1';
    expect((await service.fetch(post(), { address: otherNetwork })).status).toBe(200);
    advance(8_640_000);
    expect((await service.fetch(post(), { address: address(12) })).status).toBe(200);
    await assertRateLimited(await service.fetch(post(), { address: address(13) }));
  } finally { await service.close(); }
});

test('per-page bucket applies across senders and counts replays, with daily refill', async () => {
  const { service, advance } = await layeredService();
  try {
    for (let i = 1; i <= 2; i++) expect((await service.fetch(post(), { address: `192.0.${i}.1` })).status).toBe(200);
    await assertRateLimited(await service.fetch(post(), { address: '192.0.3.1' }));
    advance(43_200_000);
    expect((await service.fetch(post(), { address: '192.0.4.1' })).status).toBe(200);
    await assertRateLimited(await service.fetch(post(), { address: '192.0.5.1' }));
    const otherPage = { ...intent(), pageId: `page-v1:${'B'.repeat(43)}` };
    expect((await service.fetch(request('/v1/corrections', {
      method: 'POST', origin: FORM_ORIGIN, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(otherPage),
    }), { address: '192.0.6.1' })).status).toBe(200);
  } finally { await service.close(); }
});

test('trusted client addresses key sender limits; untrusted and malformed headers cannot rotate buckets', async () => {
  const { service } = await layeredService({ perPageCapacity: 100, perNetworkCapacity: 100 }, {
    config: { ...config, clientAddress: { source: 'header', header: 'cf-connecting-ip', trustedPeers: ['10.0.0.0/8'] },
      limits: { ...config.limits, perPageCapacity: 100, perNetworkCapacity: 100 } },
  });
  const forwarded = (ip) => request('/v1/corrections', {
    method: 'POST', origin: FORM_ORIGIN, headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(intent()),
  });
  try {
    for (let i = 0; i < 3; i++) expect((await service.fetch(forwarded('198.51.100.1'), { address: '10.0.0.1' })).status).toBe(200);
    await assertRateLimited(await service.fetch(forwarded('198.51.100.1'), { address: '10.0.0.2' }));
    expect((await service.fetch(forwarded('198.51.100.2'), { address: '10.0.0.1' })).status).toBe(200);
    for (let i = 1; i <= 3; i++) expect((await service.fetch(forwarded(`198.51.100.${i}`), { address: '203.0.113.1' })).status).toBe(200);
    await assertRateLimited(await service.fetch(forwarded('198.51.100.99'), { address: '203.0.113.1' }));
    for (let i = 1; i <= 3; i++) expect((await service.fetch(forwarded(`malformed-${i}`), { address: '10.0.0.3' })).status).toBe(200);
    await assertRateLimited(await service.fetch(forwarded('another-malformed'), { address: '10.0.0.3' }));
  } finally { await service.close(); }
});


test('bounded bucket maps evict the oldest key instead of retaining unbounded identities', () => {
  const limiter = createLayeredAbuseLimiter({ limits: { ...config.limits, perSenderCapacity: 1, perNetworkCapacity: 100 }, maxKeys: 2, now: () => 0 });
  expect(limiter.trySender(parseIp('192.0.2.1'))).toBe(true);
  expect(limiter.trySender(parseIp('192.0.2.1'))).toBe(false);
  expect(limiter.trySender(parseIp('192.0.2.2'))).toBe(true);
  expect(limiter.trySender(parseIp('192.0.2.3'))).toBe(true);
  expect(limiter.trySender(parseIp('192.0.2.1'))).toBe(true);
  expect(limiter.tryPage('page-one')).toBe(true);
  expect(limiter.tryPage('page-one')).toBe(true);
  expect(limiter.tryPage('page-one')).toBe(false);
  expect(limiter.tryPage('page-two')).toBe(true);
  expect(limiter.tryPage('page-three')).toBe(true);
  expect(limiter.tryPage('page-one')).toBe(true);
});

test('alternate IPv6 spellings and IPv4-mapped peers cannot reset sender quota', () => {
  const limiter = createLayeredAbuseLimiter({ limits: { ...config.limits, perSenderCapacity: 1 }, now: () => 0 });
  expect(limiter.trySender(parseIp('2001:db8::1'))).toBe(true);
  expect(limiter.trySender(parseIp('2001:0DB8:0:0:0:0:0:0001'))).toBe(false);
  expect(limiter.trySender(parseIp('192.0.2.1'))).toBe(true);
  expect(limiter.trySender(parseIp('::ffff:c000:201'))).toBe(false);
});


test.each(['queue-pending-capacity', 'queue-source-capacity', 'queue-retained-capacity'])('retains the %s inbox circuit breaker response', async (code) => {
  const { service } = await layeredService({}, { queue: fakeQueue(async () => { throw Object.assign(new Error('private queue details'), { code }); }) });
  try {
    const response = await service.fetch(post(), { address: '192.0.2.1' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'queue-capacity' } });
  } finally { await service.close(); }
});


test('weighted sender work uses normalized HMAC identity and hourly refill independently of attempt quotas', () => {
  let time = 0;
  const limiter = createLayeredAbuseLimiter({ limits: { ...config.limits, perSenderOperationBudget: 5, perSenderByteBudget: 10 }, now: () => time });
  expect(limiter.tryWork(parseIp('192.0.2.1'), 2, 5)).toBe(true);
  expect(limiter.tryWork(parseIp('::ffff:c000:201'), 2, 5)).toBe(true);
  expect(limiter.tryWork(parseIp('192.0.2.1'), 2, 1)).toBe(false);
  expect(limiter.tryWork(parseIp('192.0.2.2'), 5, 10)).toBe(true);
  time = 3_600_000;
  expect(limiter.tryWork(parseIp('192.0.2.1'), 5, 10)).toBe(true);
  expect(limiter.tryWork(parseIp('192.0.2.1'), 1, 1)).toBe(false);
});
