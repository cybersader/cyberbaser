import { randomBytes } from 'node:crypto';
import { OwnerAlphaError } from '../errors.js';

export function createMemoryEditSessionStore({
  ttlMs = 10 * 60 * 1000,
  maxEntries = 64,
  now = () => Date.now(),
  createToken = () => randomBytes(32).toString('base64url'),
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('edit session store limits must be positive integers');
  }
  const entries = new Map();

  function prune() {
    const current = now();
    for (const [id, entry] of entries) if (entry.expiresAt <= current) entries.delete(id);
  }

  return Object.freeze({
    create(value) {
      prune();
      if (entries.size >= maxEntries) throw new OwnerAlphaError('edit-session-capacity', 'too many active edit sessions');
      let id;
      do id = createToken(); while (entries.has(id));
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(id)) throw new TypeError('edit session token factory returned an invalid token');
      const expiresAt = now() + ttlMs;
      entries.set(id, { value, expiresAt });
      return Object.freeze({ id, expiresAt });
    },
    get(id) {
      prune();
      return entries.get(id)?.value ?? null;
    },
    delete(id) {
      return entries.delete(id);
    },
  });
}
