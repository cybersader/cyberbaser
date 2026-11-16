import { expect, test } from 'bun:test';
import { challengeProviders, getChallengeProvider } from '../src/challenge/registry.js';
import { turnstile } from '../src/challenge/providers/turnstile.js';
import { challengeProviderConformance } from './conformance/challenge-provider.js';
import { turnstileHarness } from './harnesses/turnstile.js';

challengeProviderConformance(turnstile, turnstileHarness);

test('challenge registry is frozen, owns ids, and rejects inherited object properties', () => {
  expect(Object.isFrozen(challengeProviders)).toBe(true);
  for (const [id, provider] of Object.entries(challengeProviders)) {
    expect(provider.id).toBe(id);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(getChallengeProvider(id)).toBe(provider);
  }
  for (const id of ['constructor', '__proto__', 'toString', 'unknown', null]) {
    expect(() => getChallengeProvider(id)).toThrow(/registered challenge provider/);
  }
});
