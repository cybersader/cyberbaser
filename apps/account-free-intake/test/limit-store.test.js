import { expect, test } from 'bun:test';
import { createInMemoryLimitStore, MAX_LIMIT_KEYS } from '../src/limit-store/in-memory.js';
import { createLayeredAbuseLimiter } from '../src/abuse.js';
import { parseIp } from '../src/client-address.js';
import { LAYERED_LIMIT_DEFAULTS } from '../src/config.js';
import { limitStoreConformance } from './conformance/limit-store.js';

limitStoreConformance('in-memory', { createStore: createInMemoryLimitStore, size: (store) => store.size });

test('in-memory store rejects invalid memory bounds', () => {
  for (const maxKeys of [0, -1, 1.5, '2', MAX_LIMIT_KEYS + 1]) {
    expect(() => createInMemoryLimitStore({ maxKeys })).toThrow('invalid abuse key bound');
  }
});

test('in-memory default bound remains finite under churn', () => {
  const store = createInMemoryLimitStore();
  for (let index = 0; index < MAX_LIMIT_KEYS + 10; index += 1) {
    store.take(`opaque-${index}`, { capacity: 1, refillPerMs: 0 }, 0);
  }
  expect(store.size).toBe(MAX_LIMIT_KEYS);
});

test('core sends stores only scope-separated HMAC keys, policies and clock values', () => {
  const calls = [];
  const stores = [];
  const limiter = createLayeredAbuseLimiter({
    limits: LAYERED_LIMIT_DEFAULTS, now: () => 1234, maxKeys: 2,
    createStore(options) {
      stores.push(options);
      return { take(key, policy, nowMs) { calls.push({ key, policy, nowMs }); return true; } };
    },
  });
  expect(limiter.trySender(parseIp('192.0.2.1'))).toBe(true);
  expect(limiter.tryPage('private-page-id')).toBe(true);
  expect(stores).toEqual([{ maxKeys: 2 }, { maxKeys: 2 }, { maxKeys: 2 }]);
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map(({ key }) => key)).size).toBe(3);
  for (const call of calls) {
    expect(call.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(call.nowMs).toBe(1234);
    expect(JSON.stringify(call)).not.toContain('192.0.2.1');
    expect(JSON.stringify(call)).not.toContain('private-page-id');
  }
  expect(calls[0].policy).toEqual({ capacity: 3, refillPerMs: 3 / 3_600_000 });
  expect(calls[1].policy).toEqual({ capacity: 10, refillPerMs: 10 / 86_400_000 });
  expect(calls[2].policy).toEqual({ capacity: 2, refillPerMs: 2 / 86_400_000 });
});

test('store truthiness does not grant quota admission', () => {
  const limiter = createLayeredAbuseLimiter({ limits: LAYERED_LIMIT_DEFAULTS, createStore: () => ({ take: () => 'true' }) });
  expect(limiter.trySender(parseIp('192.0.2.1'))).toBe(false);
  expect(limiter.tryPage('page')).toBe(false);
});
