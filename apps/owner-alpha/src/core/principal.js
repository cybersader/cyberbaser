import { createSignedRequestVerifier } from './signed-request.js';

// Trusted adapters attest identities in-process. Their issuance scopes stay
// separate, and neither can attest an already-constructed principal object.
function createAttestation() {
  const verified = new WeakSet();
  return {
    attest(fields) {
      const principal = Object.freeze(fields);
      verified.add(principal);
      return principal;
    },
    isVerified: (principal) => verified.has(principal),
  };
}

export function createBootstrapPrincipalAdapter() {
  const { attest, isVerified } = createAttestation();
  return Object.freeze({
    fromSession({ id, sessionId, authenticatedAt }) {
      if (typeof id !== 'string' || !id || typeof sessionId !== 'string' || !sessionId
        || !Number.isSafeInteger(authenticatedAt) || authenticatedAt < 0) {
        throw new TypeError('verified bootstrap session metadata is required');
      }
      return attest({ id, method: 'bootstrap-session', sessionId, authenticatedAt });
    },
    isVerified,
  });
}

export function createDevicePrincipalAdapter(options) {
  const verifier = createSignedRequestVerifier(options);
  const { attest, isVerified } = createAttestation();
  const requests = new WeakMap();
  function bind(connection) {
    return (envelope, acceptsCommand) => {
      const { command, input, key, authenticatedAt } = connection.verify(envelope, acceptsCommand);
      const { actor, keyId } = key;
      const id = actor.kind === 'owner-device' ? verifier.ownerId : actor.id;
      const principal = attest({ id, method: 'device-key', keyId, actor, authenticatedAt });
      requests.set(principal, { grants: key.grants, command, input, consumed: false });
      return Object.freeze({ command, input, principal });
    };
  }
  return Object.freeze({
    ownerId: verifier.ownerId,
    verify: bind(verifier),
    forChannel: (binding) => Object.freeze({ verify: bind(verifier.forChannel(binding)) }),
    isVerified,
    hasGrant: (principal, grant) => requests.get(principal)?.grants.includes(grant) === true,
    consumeRequest(principal, command, input) {
      const request = requests.get(principal);
      if (!request || request.consumed || request.command !== command || !Object.is(request.input, input)) return false;
      request.consumed = true;
      return true;
    },
  });
}
