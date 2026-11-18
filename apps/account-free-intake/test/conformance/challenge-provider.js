import { describe, expect, test } from 'bun:test';
import { ChallengeError, createChallengeVerifier } from '../../src/bot-check.js';
import { parseIp } from '../../src/client-address.js';

const TOKEN = 'synthetic-conformance-token';
const clientAddress = parseIp('192.0.2.1');
const request = (token = TOKEN) => new Request('https://intake.example/v1/corrections', {
  headers: token === null ? {} : { 'Cyberbaser-Challenge-Token': token },
});
const deadline = (controller = new AbortController(), remaining = 1000) => ({
  signal: controller.signal, remaining: () => remaining,
});
function assertFrozen(value) {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) assertFrozen(nested);
  }
}
async function rejected(verify, expectedCode, expectedStatus, req = request(), budget = deadline()) {
  try {
    await verify(req, clientAddress, budget);
    throw new Error('unexpected challenge pass');
  } catch (error) {
    expect(error).toBeInstanceOf(ChallengeError);
    expect(error.code).toBe(expectedCode);
    expect(error.status).toBe(expectedStatus);
  }
}

// Harness: { options, invalidOptions[], malformedOutcome, transport(scenario) }.
// transport returns { deps: { fetch, readSecretFile }, calls[], signal() } and
// implements pass/fail/malformed/slow/throw without network or real secrets.
// slow intentionally ignores abort, so core must independently bound the wait.
export function challengeProviderConformance(provider, harness) {
  describe(`${provider.id} challenge provider conformance`, () => {
    const options = () => provider.validateOptions(structuredClone(harness.options));

    test('exports the provider contract and deeply frozen cloned options', () => {
      expect(typeof provider.id).toBe('string');
      expect(provider.id.length).toBeGreaterThan(0);
      expect(typeof provider.validateOptions).toBe('function');
      expect(typeof provider.create).toBe('function');
      const input = structuredClone(harness.options);
      const validated = provider.validateOptions(input);
      assertFrozen(validated);
      expect(input).toEqual(harness.options);
      expect(Object.isFrozen(input)).toBe(false);
    });

    test('invalid provider options throw invalid-config', () => {
      expect(harness.invalidOptions.length).toBeGreaterThan(0);
      for (const input of harness.invalidOptions) {
        try {
          provider.validateOptions(structuredClone(input));
          throw new Error('unexpected valid config');
        } catch (error) {
          expect(error.code).toBe('invalid-config');
        }
      }
    });

    for (const scenario of ['pass', 'fail', 'malformed']) {
      test(`${scenario} transport obeys provider and core contract`, async () => {
        const transport = harness.transport(scenario);
        const instance = await provider.create(options(), transport.deps);
        expect(typeof instance.verify).toBe('function');
        const outcome = scenario === 'malformed' ? harness.malformedOutcome : scenario;
        expect(['fail', 'unavailable']).toContain(harness.malformedOutcome);
        expect(await instance.verify({ token: TOKEN, clientAddress, signal: new AbortController().signal })).toEqual({ outcome });
        const verify = await createChallengeVerifier(provider, options(), transport.deps);
        if (outcome === 'pass') await verify(request(), clientAddress, deadline());
        else await rejected(verify, `challenge-${outcome === 'fail' ? 'failed' : 'unavailable'}`, outcome === 'fail' ? 403 : 503);
      });
    }

    test('provider transport throw is unavailable, never pass or a leaked exception', async () => {
      const transport = harness.transport('throw');
      const verify = await createChallengeVerifier(provider, options(), transport.deps);
      await rejected(verify, 'challenge-unavailable', 503);
    });

    test('core times out and aborts even when provider transport ignores cancellation', async () => {
      const transport = harness.transport('slow');
      const verify = await createChallengeVerifier(provider, { ...options(), timeoutMs: 10 }, transport.deps);
      await rejected(verify, 'challenge-unavailable', 503);
      expect(transport.signal().aborted).toBe(true);
    });

    test('shared deadline caps provider budget', async () => {
      const transport = harness.transport('slow');
      const verify = await createChallengeVerifier(provider, options(), transport.deps);
      await rejected(verify, 'challenge-unavailable', 503, request(), deadline(new AbortController(), 10));
      expect(transport.signal().aborted).toBe(true);
    });

    test('shared abort promptly ends an uncooperative provider', async () => {
      const transport = harness.transport('slow');
      const verify = await createChallengeVerifier(provider, options(), transport.deps);
      const controller = new AbortController();
      const pending = rejected(verify, 'challenge-unavailable', 503, request(), deadline(controller));
      await Promise.resolve();
      controller.abort();
      await pending;
      expect(transport.signal().aborted).toBe(true);
    });

    test('already aborted or expired deadlines never invoke provider transport', async () => {
      const transport = harness.transport('pass');
      const verify = await createChallengeVerifier(provider, options(), transport.deps);
      const controller = new AbortController();
      controller.abort();
      await rejected(verify, 'challenge-unavailable', 503, request(), deadline(controller));
      await rejected(verify, 'challenge-unavailable', 503, request(), deadline(new AbortController(), 0));
      expect(transport.calls).toHaveLength(0);
    });

    test.each([null, '', 'two,tokens', 'token with spaces', 'x'.repeat(2049)])('core rejects malformed token before provider transport', async (token) => {
      const transport = harness.transport('pass');
      const verify = await createChallengeVerifier(provider, options(), transport.deps);
      await rejected(verify, 'challenge-failed', 403, request(token));
      expect(transport.calls).toHaveLength(0);
    });

    test('unknown, malformed, inherited, accessor and extra-field provider results cannot pass', async () => {
      const extraSymbol = { outcome: 'pass', [Symbol('extra')]: true };
      const results = [undefined, null, true, 'pass', [], { outcome: true }, { outcome: 'PASS' },
        { outcome: 'unavailable' }, { outcome: 'pass', extra: true }, extraSymbol,
        Object.create({ outcome: 'pass' }), Object.create({ outcome: 'fail' }),
        Object.assign([], { outcome: 'pass' }), { get outcome() { return 'pass'; } },
        { get outcome() { return 'fail'; } },
        { get outcome() { throw new Error('private diagnostic'); } }];
      for (const result of results) {
        const broken = { ...provider, async create() { return { async verify() { return result; } }; } };
        await rejected(await createChallengeVerifier(broken, options()), 'challenge-unavailable', 503);
      }
    });

    test('provider cannot forge the public error classification by throwing ChallengeError', async () => {
      for (const failure of [new Error('private diagnostic'), new ChallengeError('challenge-failed', 403)]) {
        const broken = { ...provider, async create() { return { verify() { throw failure; } }; } };
        await rejected(await createChallengeVerifier(broken, options()), 'challenge-unavailable', 503);
      }
    });

    test('provider cannot return a pass after aborting the shared deadline', async () => {
      const controller = new AbortController();
      const broken = { ...provider, async create() { return { async verify() {
        controller.abort();
        return { outcome: 'pass' };
      } }; } };
      await rejected(await createChallengeVerifier(broken, options()), 'challenge-unavailable', 503, request(), deadline(controller));
    });
  });
}
