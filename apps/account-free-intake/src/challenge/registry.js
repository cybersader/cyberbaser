import { isRecord, fail } from '../control-config.js';
import { turnstile } from './providers/turnstile.js';

// Modules are trusted code, never operator-loaded scripts. Add one entry per id.
export const challengeProviders = Object.freeze({ turnstile });

export function getChallengeProvider(id) {
  if (typeof id !== 'string' || !Object.hasOwn(challengeProviders, id)) {
    fail('invalid-config', 'botCheck.provider must name a registered challenge provider');
  }
  return challengeProviders[id];
}

export function validateChallengeConfig(input) {
  if (input === null || input === undefined) return null;
  if (!isRecord(input)) fail('invalid-config', 'botCheck must be an object');
  const { provider: id, ...options } = input;
  const provider = getChallengeProvider(id);
  return Object.freeze({ provider: id, ...provider.validateOptions(options) });
}
