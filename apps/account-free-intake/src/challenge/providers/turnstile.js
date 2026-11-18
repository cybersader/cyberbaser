import { exactObject, exactInteger, normalizedAbsolutePath, fail } from '../../control-config.js';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Public fixture secrets cannot validate real tokens. Do not broaden this to
// prefixes, site keys, environment modes, or arbitrary secret values.
const TEST_SECRETS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

export const turnstile = Object.freeze({
  id: 'turnstile',
  // Trusted browser metadata for reader CSP, never operator-supplied URLs.
  scriptOrigin: new URL(SCRIPT_URL).origin,
  validateOptions(input) {
    exactObject(input, ['secretFile', 'expectedHostnames', 'expectedAction', 'timeoutMs'], 'botCheck');
    if (!Array.isArray(input.expectedHostnames) || input.expectedHostnames.length < 1 || input.expectedHostnames.length > 100
      || input.expectedHostnames.some((host) => typeof host !== 'string' || host.length > 253
        || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host)
        || host.split('.').some((label) => label.length > 63 || label.startsWith('-') || label.endsWith('-') || label.length === 0))
      || new Set(input.expectedHostnames).size !== input.expectedHostnames.length) {
      fail('invalid-config', 'botCheck.expectedHostnames must contain unique canonical hostnames without ports');
    }
    if (input.expectedAction !== 'suggest-correction') fail('invalid-config', 'botCheck.expectedAction must be suggest-correction');
    return Object.freeze({
      secretFile: normalizedAbsolutePath(input.secretFile, 'botCheck.secretFile'),
      expectedHostnames: Object.freeze([...input.expectedHostnames]),
      expectedAction: input.expectedAction,
      timeoutMs: exactInteger(input.timeoutMs, 3000, 'botCheck.timeoutMs'),
    });
  },
  async create(options, { fetch, readSecretFile }) {
    const secret = await readSecretFile(options.secretFile);
    const testSecret = TEST_SECRETS.has(secret);
    const hostnames = new Set(options.expectedHostnames);
    return Object.freeze({
      async verify({ token, clientAddress, signal }) {
        const fields = new URLSearchParams({ secret, response: token });
        if (clientAddress !== null) fields.set('remoteip', clientAddress.address);
        const response = await fetch(SITEVERIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: fields,
          signal,
          redirect: 'error',
        });
        if (!response.ok) return { outcome: 'unavailable' };
        const result = await response.json();
        const bound = testSecret
          ? result?.hostname === 'example.com' && !Object.hasOwn(result, 'action')
          : hostnames.has(result?.hostname) && result?.action === options.expectedAction;
        return { outcome: result?.success === true && bound ? 'pass' : 'fail' };
      },
    });
  },
});
