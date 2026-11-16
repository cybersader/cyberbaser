import { describe, expect, test } from 'bun:test';

// createStore({maxKeys}) -> synchronous { take(key, policy, nowMs) -> boolean }.
// size(store) is harness-only instrumentation, not a required runtime method.
export function limitStoreConformance(name, { createStore, size }) {
  describe(`${name} limit store conformance`, () => {
    const policy = { capacity: 2, refillPerMs: 0.001 };

    test('capacity is exact and exhausted takes remain false', () => {
      const store = createStore({ maxKeys: 4 });
      expect(store.take('opaque-a', policy, 0)).toBe(true);
      expect(store.take('opaque-a', policy, 0)).toBe(true);
      expect(store.take('opaque-a', policy, 0)).toBe(false);
      expect(store.take('opaque-a', policy, 0)).toBe(false);
    });

    test('fractional refill accumulates and never exceeds capacity', () => {
      const store = createStore({ maxKeys: 4 });
      store.take('opaque-a', policy, 0);
      store.take('opaque-a', policy, 0);
      expect(store.take('opaque-a', policy, 500)).toBe(false);
      expect(store.take('opaque-a', policy, 1000)).toBe(true);
      expect(store.take('opaque-a', policy, 1000)).toBe(false);
      expect(store.take('opaque-a', policy, 100_000)).toBe(true);
      expect(store.take('opaque-a', policy, 100_000)).toBe(true);
      expect(store.take('opaque-a', policy, 100_000)).toBe(false);
    });

    test('keys and stores have independent capacity and policies', () => {
      const store = createStore({ maxKeys: 4 });
      const other = createStore({ maxKeys: 4 });
      const one = { capacity: 1, refillPerMs: 0 };
      expect(store.take('opaque-a', one, 0)).toBe(true);
      expect(store.take('opaque-a', one, 0)).toBe(false);
      expect(store.take('opaque-b', policy, 0)).toBe(true);
      expect(store.take('opaque-b', policy, 0)).toBe(true);
      expect(store.take('opaque-b', policy, 0)).toBe(false);
      expect(other.take('opaque-a', one, 0)).toBe(true);
    });

    test('clock regression cannot manufacture refill credit', () => {
      const store = createStore({ maxKeys: 4 });
      const one = { capacity: 1, refillPerMs: 0.001 };
      expect(store.take('opaque-a', one, 1000)).toBe(true);
      expect(store.take('opaque-a', one, 0)).toBe(false);
      expect(store.take('opaque-a', one, 1000)).toBe(false);
      expect(store.take('opaque-a', one, 2000)).toBe(true);
    });

    test('retained memory stays bounded and FIFO eviction forgets oldest quota', () => {
      const store = createStore({ maxKeys: 2 });
      const one = { capacity: 1, refillPerMs: 0 };
      expect(store.take('opaque-oldest', one, 0)).toBe(true);
      expect(store.take('opaque-second', one, 0)).toBe(true);
      expect(store.take('opaque-oldest', one, 0)).toBe(false);
      expect(store.take('opaque-third', one, 0)).toBe(true);
      expect(store.take('opaque-second', one, 0)).toBe(false);
      expect(store.take('opaque-oldest', one, 0)).toBe(true);
      for (let index = 0; index < 100; index += 1) {
        expect(store.take(`opaque-${index}`, one, 0)).toBe(true);
        expect(size(store)).toBeLessThanOrEqual(2);
      }
    });
  });
}
