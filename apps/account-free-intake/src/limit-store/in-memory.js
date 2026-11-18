// Each store retains only opaque HMAC keys and at most 10,000 entries.
export const MAX_LIMIT_KEYS = 10_000;

export function createInMemoryLimitStore({ maxKeys = MAX_LIMIT_KEYS } = {}) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > MAX_LIMIT_KEYS) throw new Error('invalid abuse key bound');
  const entries = new Map();
  return Object.freeze({
    take(key, { capacity, refillPerMs, cost = 1 }, nowMs) {
      // The same store seam accepts weighted units; omitted cost preserves v1.
      if (!Number.isSafeInteger(cost) || cost < 1 || !Number.isFinite(capacity) || capacity < 1
        || !Number.isFinite(refillPerMs) || refillPerMs < 0 || !Number.isFinite(nowMs)) return false;
      let bucket = entries.get(key);
      if (bucket === undefined) {
        // FIFO eviction bounds memory; hot traffic does not refresh insertion order.
        if (entries.size >= maxKeys) entries.delete(entries.keys().next().value);
        bucket = { tokens: capacity, lastRefill: nowMs };
        entries.set(key, bucket);
      }
      bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, nowMs - bucket.lastRefill) * refillPerMs);
      bucket.lastRefill = Math.max(nowMs, bucket.lastRefill);
      if (bucket.tokens < cost) return false;
      bucket.tokens -= cost;
      return true;
    },
    // Diagnostics for bounded-memory conformance; never expose retained keys.
    get size() { return entries.size; },
  });
}
