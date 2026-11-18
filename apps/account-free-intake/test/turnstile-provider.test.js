import { describe, expect, test } from 'bun:test';
import { turnstile } from '../src/challenge/providers/turnstile.js';
import { turnstile as browserTurnstile } from '../../../renderers/quartz-cyberbase/components/challenge/providers/turnstile.ts';
import { challengeProviderConformance } from './conformance/challenge-provider.js';
import { TURNSTILE_TEST_SECRETS, turnstileHarness, turnstileTestKeyHarness } from './harnesses/turnstile.js';

// The ordinary-secret harness already runs in challenge-provider.test.js. Run
// the same provider/core contract for the published test-response shape too.
challengeProviderConformance(turnstile, turnstileTestKeyHarness);

async function verifyResponse(secret, result, hosts = ['wiki.example']) {
  const options = turnstile.validateOptions({ ...turnstileHarness.options, expectedHostnames: hosts });
  const verifier = await turnstile.create(options, {
    readSecretFile: async () => secret,
    fetch: async () => Response.json(result),
  });
  return verifier.verify({ token: 'synthetic-token', clientAddress: null, signal: new AbortController().signal });
}

describe('Turnstile exact published test-secret exception', () => {
  test.each(TURNSTILE_TEST_SECRETS)('accepts the fixture shape only for the exact public secret %s', async (secret) => {
    expect(await verifyResponse(secret, { success: true, hostname: 'example.com' })).toEqual({ outcome: 'pass' });
    // Test-key binding is exactly the documented fixture, not arbitrary origins
    // or explicit null/empty/wrong actions from a malformed response.
    for (const result of [
      { success: true, hostname: 'wiki.example' },
      { success: true, hostname: 'example.com', action: null },
      { success: true, hostname: 'example.com', action: '' },
      { success: true, hostname: 'example.com', action: 'wrong-action' },
      { success: false, hostname: 'example.com' },
      { success: 'true', hostname: 'example.com' },
      {}, null,
    ]) expect(await verifyResponse(secret, result)).toEqual({ outcome: 'fail' });
  });

  test('ordinary and near-match secrets retain strict hostname and action binding', async () => {
    const realLooking = 'synthetic-private-secret-not-a-public-fixture';
    for (const secret of [realLooking, ...TURNSTILE_TEST_SECRETS.map((value) => `${value}x`),
      TURNSTILE_TEST_SECRETS[0].replace('AA', 'AB')]) {
      // Even an expected example.com hostname cannot waive a missing action.
      expect(await verifyResponse(secret, { success: true, hostname: 'example.com' }, ['example.com']))
        .toEqual({ outcome: 'fail' });
      expect(await verifyResponse(secret, { success: true, hostname: 'wiki.example' })).toEqual({ outcome: 'fail' });
      expect(await verifyResponse(secret, { success: true, hostname: 'wiki.example', action: 'suggest-correction' }))
        .toEqual({ outcome: 'pass' });
      expect(await verifyResponse(secret, { success: true, hostname: 'other.example', action: 'suggest-correction' }))
        .toEqual({ outcome: 'fail' });
      expect(await verifyResponse(secret, { success: true, hostname: 'wiki.example', action: 'other-action' }))
        .toEqual({ outcome: 'fail' });
    }
  });

  test.each(['invalid-input-response', 'timeout-or-duplicate'])('failure codes cannot turn a rejected test token into success (%s)', async (code) => {
    for (const secret of TURNSTILE_TEST_SECRETS) {
      expect(await verifyResponse(secret, { success: false, hostname: 'example.com', 'error-codes': [code] }))
        .toEqual({ outcome: 'fail' });
    }
  });

  test('publishes a constant credential-free HTTPS browser origin as provider metadata', () => {
    const origin = new URL(turnstile.scriptOrigin);
    expect(origin.origin).toBe(new URL(browserTurnstile.scriptUrl).origin);
    expect(origin.protocol).toBe('https:');
    expect(origin.origin).toBe(turnstile.scriptOrigin);
    expect(origin.username).toBe('');
    expect(origin.password).toBe('');
  });
});
