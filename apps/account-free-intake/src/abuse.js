import { createHmac, randomBytes } from 'node:crypto';
import { networkIdentity } from './client-address.js';
import { createInMemoryLimitStore, MAX_LIMIT_KEYS } from './limit-store/in-memory.js';

const PROCESS_SALT = randomBytes(32);

export function createGlobalAbuseLimiter({
  capacity = 20,
  refillPerSecond = 1,
  maxConcurrent = 4,
  now = () => performance.now(),
} = {}) {
  let tokens = capacity;
  let lastRefill = now();
  let active = 0;

  function refill() {
    const current = now();
    const elapsedSeconds = Math.max(0, current - lastRefill) / 1000;
    tokens = Math.min(capacity, tokens + elapsedSeconds * refillPerSecond);
    lastRefill = current;
  }

  return Object.freeze({
    tryTake() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    tryEnter() {
      if (active >= maxConcurrent) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    snapshot() {
      refill();
      return Object.freeze({ tokens, active });
    },
  });
}

export const MAX_ABUSE_KEYS = MAX_LIMIT_KEYS;

export function createLayeredAbuseLimiter({ limits, now = () => performance.now(), maxKeys = MAX_ABUSE_KEYS, createStore = createInMemoryLimitStore } = {}) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > MAX_ABUSE_KEYS) throw new Error('invalid abuse key bound');
  const hash = (scope, value) => createHmac('sha256', PROCESS_SALT).update(`${scope}\0${value}`).digest('hex');
  // Keep independent per-scope capacity/eviction and clock semantics. Stores
  // receive HMACs only; identity normalization and secret salt remain in core.
  const bucket = (capacity, refillPerMs) => {
    const store = createStore({ maxKeys });
    return (key) => store.take(key, { capacity, refillPerMs }, now()) === true;
  };
  const sender = bucket(limits.perSenderCapacity, limits.perSenderRefillPerHour / 3_600_000);
  const network = bucket(limits.perNetworkCapacity, limits.perNetworkRefillPerDay / 86_400_000);
  const page = bucket(limits.perPageCapacity, limits.perPageRefillPerDay / 86_400_000);
  return Object.freeze({
    trySender(ip) {
      const identity = ip === null ? 'unknown' : `${ip.family}:${ip.numeric}`;
      return sender(hash('sender', identity)) && network(hash('network', networkIdentity(ip)));
    },
    tryPage(pageId) { return page(hash('page', pageId)); },
  });
}
