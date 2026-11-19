// Trusted adapters attest identities in-process. A deserialized object with
// matching fields is not an authenticated principal.
export function createBootstrapPrincipalAdapter() {
  const verified = new WeakSet();
  return Object.freeze({
    fromSession({ id, sessionId, authenticatedAt }) {
      if (typeof id !== 'string' || !id || typeof sessionId !== 'string' || !sessionId
        || !Number.isSafeInteger(authenticatedAt) || authenticatedAt < 0) {
        throw new TypeError('verified bootstrap session metadata is required');
      }
      const principal = Object.freeze({ id, method: 'bootstrap-session', sessionId, authenticatedAt });
      verified.add(principal);
      return principal;
    },
    isVerified(principal) {
      return verified.has(principal);
    },
  });
}
