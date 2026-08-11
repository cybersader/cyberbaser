import { expect, test } from 'bun:test';
import { openIntakeService } from '../src/server.js';
import { configInput, FORM_ORIGIN, request } from './helpers.js';
import { validateConfig } from '../src/config.js';

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
    config,
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
