// Synthetic fixtures only. No network, filesystem secret, or provider account.
export const TURNSTILE_TEST_SECRETS = Object.freeze([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

function harness(secret, testKey = false) {
  return Object.freeze({
    options: {
      secretFile: '/synthetic/turnstile-secret', expectedHostnames: ['wiki.example'],
      expectedAction: 'suggest-correction', timeoutMs: 3000,
    },
    invalidOptions: [{}, { secretFile: 'relative' }],
    // Well-formed JSON with missing result fields remains a provider failure.
    malformedOutcome: 'fail',
    transport(scenario) {
      const calls = [];
      let signal;
      return {
        calls,
        signal: () => signal,
        deps: {
          async readSecretFile(file) {
            if (file !== '/synthetic/turnstile-secret') throw new Error('unexpected secret path');
            return secret;
          },
          async fetch(url, options) {
            calls.push({ url, options });
            signal = options.signal;
            if (scenario === 'throw') throw new Error('synthetic private transport diagnostic');
            if (scenario === 'slow') return new Promise(() => {});
            if (scenario === 'malformed') return Response.json(null);
            return Response.json({ success: scenario === 'pass', ...(testKey
              ? { hostname: 'example.com' }
              : { hostname: 'wiki.example', action: 'suggest-correction' }) });
          },
        },
      };
    },
  });
}

export const turnstileHarness = harness('synthetic-conformance-secret');
export const turnstileTestKeyHarness = harness(TURNSTILE_TEST_SECRETS[0], true);
