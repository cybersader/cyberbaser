import { getChallengeProvider } from './challenge/registry.js';
import { readSecretFile } from './challenge/secret-file.js';

// Core-owned header and maximum budget are independent of provider transport.
export const CHALLENGE_TOKEN_HEADER = 'cyberbaser-challenge-token';
export const CHALLENGE_TIMEOUT_MS = 3000;

export class ChallengeError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Exported for shared conformance tests; runtime selection uses only the registry.
export async function createChallengeVerifier(provider, options, deps = {}) {
  const verifier = await provider.create(options, { fetch: globalThis.fetch, readSecretFile, ...deps });
  return async (request, clientAddress, deadline) => {
    const token = request.headers.get(CHALLENGE_TOKEN_HEADER);
    if (token === null || token.length === 0 || token.length > 2048 || /[\s,]/u.test(token)) {
      throw new ChallengeError('challenge-failed', 403);
    }
    const controller = new AbortController();
    let timer;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => {
      controller.abort();
      rejectAbort(new Error('challenge aborted'));
    };
    deadline.signal.addEventListener('abort', abort, { once: true });
    try {
      const budget = Math.min(CHALLENGE_TIMEOUT_MS, options.timeoutMs ?? CHALLENGE_TIMEOUT_MS, deadline.remaining());
      if (deadline.signal.aborted || !Number.isFinite(budget) || budget <= 0) throw new Error();
      timer = setTimeout(abort, budget);
      timer.unref?.();
      const result = await Promise.race([
        Promise.resolve().then(() => verifier.verify({ token, clientAddress, signal: controller.signal })),
        aborted,
      ]);
      // Reject even a late pass from a provider that ignores cancellation.
      if (controller.signal.aborted || deadline.signal.aborted || deadline.remaining() <= 0) throw new Error();
      if (result === null || typeof result !== 'object') throw new Error();
      const outcome = Object.getOwnPropertyDescriptor(result, 'outcome')?.value;
      if (outcome === 'fail') throw failedResult;
      // A pass must be exactly one own data field, not a truthy value, getter,
      // inherited outcome, array or extra-field result. Inspection may throw.
      const prototype = Object.getPrototypeOf(result);
      if ((prototype !== Object.prototype && prototype !== null)
        || Reflect.ownKeys(result).length !== 1 || outcome !== 'pass') throw new Error();
    } catch (error) {
      // Provider exceptions, including forged ChallengeErrors, cannot select a
      // public error or pass. Only the explicit fail result maps to 403 below.
      if (error === failedResult) throw new ChallengeError('challenge-failed', 403);
      throw new ChallengeError('challenge-unavailable', 503);
    } finally {
      clearTimeout(timer);
      deadline.signal.removeEventListener('abort', abort);
    }
  };
}

const failedResult = Symbol('explicit provider failure');

export async function createBotVerifier(config, deps = {}) {
  if (config === null || config === undefined) return async () => {};
  const { provider: id, ...options } = config;
  return createChallengeVerifier(getChallengeProvider(id), options, deps);
}
