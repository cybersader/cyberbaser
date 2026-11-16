import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computePolicyRevision, policyDocument, validateOwnerAlphaConfig } from '../src/config.js';
import { deriveIntakeConfig, suggestionChallengeOrigin } from '../src/suggestions.js';
import { suggestionEnvironment } from '../src/quartz-renderer.js';
import { createReaderHandler } from '../src/server.js';
import { validateConfig as validateIntakeConfig } from '../../account-free-intake/src/config.js';
import { getChallengeProvider } from '../../account-free-intake/src/challenge/registry.js';

const EXAMPLE = path.resolve(import.meta.dir, '../owner-alpha.example.json');
const cleanup = [];
const CHALLENGE = {
  provider: 'turnstile', siteKey: 'synthetic-public-key',
  secretFile: '/synthetic/challenge-secret', expectedHostnames: ['127.0.0.1', 'wiki.example'],
};
async function rawConfig(challenge = CHALLENGE) {
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  raw.proposalReview.enabled = true;
  raw.proposalReview.socketPath = '/synthetic/review.sock';
  raw.suggestions.form = { enabled: true, ...(challenge === undefined ? {} : { challenge: structuredClone(challenge) }) };
  return raw;
}
async function plainConfig() {
  const raw = await rawConfig();
  delete raw.suggestions.form.challenge;
  return raw;
}
afterEach(async () => {
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('private suggestion challenge policy', () => {
  test('strictly normalizes and freezes without mutation, and permits portable provider ids', async () => {
    const raw = await rawConfig();
    const before = structuredClone(raw);
    const config = validateOwnerAlphaConfig(raw);
    expect(raw).toEqual(before);
    expect(config.suggestions.form.challenge).toEqual(CHALLENGE);
    expect(config.suggestions.form.challenge).not.toBe(raw.suggestions.form.challenge);
    expect(config.suggestions.form.challenge.expectedHostnames).not.toBe(raw.suggestions.form.challenge.expectedHostnames);
    expect(Object.isFrozen(config.suggestions.form.challenge.expectedHostnames)).toBe(true);
    expect(validateOwnerAlphaConfig(config)).toEqual(config);
    raw.suggestions.form.challenge.provider = 'future-provider-2';
    expect(validateOwnerAlphaConfig(raw).suggestions.form.challenge.provider).toBe('future-provider-2');
  });

  test('every challenge setting participates in policy identity while absence stays unchanged', async () => {
    const plain = await plainConfig();
    const config = await rawConfig();
    const revision = computePolicyRevision(config);
    expect(validateOwnerAlphaConfig(plain).suggestions.form).toEqual({ enabled: true });
    expect(policyDocument(plain).suggestions.form).not.toHaveProperty('challenge');
    expect(revision).not.toBe(computePolicyRevision(plain));
    expect(policyDocument(config).suggestions.form.challenge).toEqual(CHALLENGE);
    for (const [key, value] of Object.entries({
      provider: 'future-provider', siteKey: 'different-public-key',
      secretFile: '/synthetic/other-secret', expectedHostnames: ['other.example'],
    })) {
      const changed = structuredClone(config);
      changed.suggestions.form.challenge[key] = value;
      expect(computePolicyRevision(changed)).not.toBe(revision);
    }
  });

  test('rejects unknown/missing fields, disabled form, malformed keys, paths and hostnames', async () => {
    const raw = await rawConfig();
    const changes = [
      (c) => { c.challenge = null; },
      (c) => { c.challenge = []; },
      (c) => { delete c.challenge.provider; },
      (c) => { c.challenge.extra = true; },
      (c) => { c.challenge.scriptOrigin = 'https://untrusted.example'; },
      (c) => { c.enabled = false; },
      ...['', 'UPPER', ' with-space', '__proto__', 'a'.repeat(65), 42].map((v) => (c) => { c.challenge.provider = v; }),
      ...['', 'a b', 'bad\nkey', 'a'.repeat(257), null].map((v) => (c) => { c.challenge.siteKey = v; }),
      ...['relative', '/', '/key', '/synthetic/../key', '/synthetic/key/', '/synthetic/key\0suffix'].map((v) => (c) => { c.challenge.secretFile = v; }),
      ...[[], ['wiki.example', 'wiki.example'], ['UPPER.example'], ['wiki.example:443'],
        ['https://wiki.example'], ['-bad.example'], ['bad-.example'], ['a..example'], ['*.example'],
        ['a'.repeat(64) + '.example'], ['wiki.example.'], [1], 'wiki.example', Array.from({ length: 101 }, (_, i) => `host${i}.example`)]
        .map((v) => (c) => { c.challenge.expectedHostnames = v; }),
    ];
    for (const change of changes) {
      const input = structuredClone(raw);
      change(input.suggestions.form);
      expect(() => validateOwnerAlphaConfig(input)).toThrow();
    }
  });

  test('derives only server bot-check settings and validates against the authoritative intake registry', async () => {
    const raw = await rawConfig();
    const derived = deriveIntakeConfig(raw, '/synthetic/project');
    expect(derived.botCheck).toEqual({
      provider: CHALLENGE.provider, secretFile: CHALLENGE.secretFile, expectedHostnames: CHALLENGE.expectedHostnames,
      expectedAction: 'suggest-correction', timeoutMs: 3000,
    });
    expect(derived.botCheck).not.toHaveProperty('siteKey');
    expect(validateIntakeConfig(structuredClone(derived)).botCheck).toEqual(derived.botCheck);
    expect(deriveIntakeConfig(await plainConfig(), '/synthetic/project')).not.toHaveProperty('botCheck');
    raw.suggestions.form.challenge.provider = 'not-registered';
    expect(() => validateIntakeConfig(structuredClone(deriveIntakeConfig(raw, '/synthetic/project')))).toThrow(/registered/);
    expect(() => suggestionChallengeOrigin(raw)).toThrow(/registered/);
  });
});

describe('public-only challenge renderer inputs', () => {
  const binding = {
    intakeOrigin: 'http://127.0.0.1:4319', bindingDigest: `sha-256=:${Buffer.alloc(32, 7).toString('base64')}:`,
    sourceRepository: 'https://github.com/owner/vault.git', sourceRevision: 'a'.repeat(40),
  };
  test('absent challenge produces exactly the previous environment and off produces none', () => {
    expect(suggestionEnvironment(null)).toEqual({});
    expect(suggestionEnvironment(binding)).toEqual({
      CYBERBASER_ACCOUNT_FREE_INTAKE: 'enabled', CYBERBASER_SOURCE_PROVENANCE: 'enabled',
      CYBERBASER_ACCOUNT_FREE_INTAKE_ORIGIN: binding.intakeOrigin,
      CYBERBASER_ACCOUNT_FREE_BINDING_DIGEST: binding.bindingDigest,
      CYBERBASER_ACCOUNT_FREE_SOURCE_REPOSITORY: binding.sourceRepository,
      CYBERBASER_ACCOUNT_FREE_SOURCE_REVISION: binding.sourceRevision,
    });
  });
  test('passes provider and public key, never secret path or hostname policy', () => {
    const environment = suggestionEnvironment({ ...binding, challenge: CHALLENGE });
    expect(environment).toEqual({ ...suggestionEnvironment(binding),
      CYBERBASER_SUGGESTION_CHALLENGE_PROVIDER: CHALLENGE.provider,
      CYBERBASER_SUGGESTION_CHALLENGE_SITE_KEY: CHALLENGE.siteKey,
    });
    expect(JSON.stringify(environment)).not.toContain(CHALLENGE.secretFile);
    expect(JSON.stringify(environment)).not.toContain('wiki.example');
  });
});

describe('provider-owned private reader CSP', () => {
  async function csp(config) {
    const siteRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-challenge-csp-'));
    cleanup.push(siteRoot);
    await writeFile(path.join(siteRoot, 'index.html'), '<h1>Synthetic private reader</h1>');
    const handler = createReaderHandler({ config, siteRoot });
    const response = await handler(new Request('http://127.0.0.1:4318/cyberbase/', { headers: { Host: '127.0.0.1:4318' } }));
    expect(response.status).toBe(200);
    return response.headers.get('Content-Security-Policy');
  }
  test('allows only the selected provider script/frame origin when the challenge is on', async () => {
    const origin = getChallengeProvider(CHALLENGE.provider).scriptOrigin;
    const plain = await plainConfig();
    const offCsp = await csp(plain);
    expect(offCsp).not.toContain(origin);
    expect(offCsp).not.toContain('frame-src');
    const onCsp = await csp(await rawConfig());
    expect(onCsp).toBe(`${offCsp.replace("script-src 'self'", `script-src 'self' ${origin}`)}; frame-src ${origin}`);
    expect(onCsp).toContain("connect-src 'self' http://127.0.0.1:4319;");
    expect(onCsp).toContain("frame-ancestors 'none'");
    expect(onCsp).toContain("form-action 'none'");
    plain.suggestions.form.enabled = false;
    const formOff = await csp(plain);
    expect(formOff).not.toContain('4319');
    expect(formOff).not.toContain(origin);
    expect(suggestionChallengeOrigin(plain)).toBeNull();
  });
  test('an unknown provider fails closed before a reader handler is returned', async () => {
    const raw = await rawConfig();
    raw.suggestions.form.challenge.provider = 'not-registered';
    expect(() => createReaderHandler({ config: raw })).toThrow(/registered/);
  });
});
