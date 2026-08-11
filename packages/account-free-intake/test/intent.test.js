import { expect, test } from 'bun:test';
import {
  ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
  ACCOUNT_FREE_INTENT_MAX_BYTES,
  AccountFreeIntakeError,
  parseCorrectionIntent,
  serializeCorrectionIntent,
  validateCorrectionIntent,
} from '../src/index.js';
import { sha256Digest } from '../src/contract.js';
import { makeIntent } from './fixtures.js';

const BINDING_DIGEST = sha256Digest(Buffer.from('binding'));
const PAGE_ID = `page-v1:${Buffer.alloc(32, 7).toString('base64url')}`;

function valid(overrides = {}) {
  return makeIntent({
    bindingDigest: BINDING_DIGEST,
    pageId: PAGE_ID,
    ...overrides,
  });
}

function expectCode(callback, code) {
  try {
    callback();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AccountFreeIntakeError);
    expect(error.code).toBe(code);
  }
}

test('strict intent accepts only the approved fixed shape and deeply freezes it', () => {
  const intent = validateCorrectionIntent(valid({
    idempotencyKey: 'aB_9'.repeat(8),
  }));
  expect(Object.keys(intent)).toEqual([
    'schemaVersion',
    'artifactType',
    'bindingDigest',
    'pageId',
    'selection',
    'replacement',
    'rationale',
    'evidence',
    'idempotencyKey',
  ]);
  expect(intent.artifactType).toBe(ACCOUNT_FREE_INTENT_ARTIFACT_TYPE);
  expect(Object.isFrozen(intent)).toBe(true);
  expect(Object.isFrozen(intent.selection)).toBe(true);
  expect(Object.isFrozen(intent.evidence)).toBe(true);
});

test('intent rejects caller-selected authority and identity fields', () => {
  for (const injected of [
    { repository: 'https://evil.invalid/wiki.git' },
    { revision: '1'.repeat(40) },
    { path: 'private.md' },
    { start: 0 },
    { baseDigest: BINDING_DIGEST },
    { identity: { email: 'reader@example.invalid' } },
    { trustRoute: 'auto-merge' },
    { decision: 'accept' },
    { refspec: 'HEAD:main' },
    { command: 'git push' },
  ]) {
    expectCode(() => validateCorrectionIntent({ ...valid(), ...injected }), 'unknown-field');
  }
  expectCode(() => validateCorrectionIntent({
    ...valid(),
    selection: { ...valid().selection, offset: 12 },
  }), 'unknown-field');
});

test('intent requires explicit nullable context and idempotency fields', () => {
  const missingPrefix = valid();
  delete missingPrefix.selection.prefix;
  expectCode(() => validateCorrectionIntent(missingPrefix), 'missing-field');
  const missingKey = valid();
  delete missingKey.idempotencyKey;
  expectCode(() => validateCorrectionIntent(missingKey), 'missing-field');
  expectCode(() => validateCorrectionIntent(valid({ idempotencyKey: 'short' })), 'invalid-idempotency-key');
  expect(validateCorrectionIntent(valid({ prefix: null, suffix: null })).selection).toEqual({
    quote: 'teh',
    prefix: null,
    suffix: null,
  });
});

test('intent enforces narrow field and evidence limits', () => {
  expectCode(() => validateCorrectionIntent(valid({ quote: 'q'.repeat(16 * 1024 + 1) })), 'string-too-large');
  expectCode(() => validateCorrectionIntent(valid({ replacement: 'r'.repeat(16 * 1024 + 1) })), 'string-too-large');
  expectCode(() => validateCorrectionIntent(valid({ prefix: 'p'.repeat(4 * 1024 + 1) })), 'string-too-large');
  expectCode(() => validateCorrectionIntent(valid({ rationale: 'r'.repeat(16 * 1024 + 1) })), 'string-too-large');
  expectCode(() => validateCorrectionIntent(valid({ evidence: Array.from({ length: 9 }, (_, index) => `https://example.invalid/${index}`) })), 'invalid-evidence');
  expectCode(() => validateCorrectionIntent(valid({ evidence: ['http://example.invalid/'] })), 'invalid-url-scheme');
  expectCode(() => validateCorrectionIntent(valid({ evidence: ['https://user:secret@example.invalid/'] })), 'credentialed-url');
  expectCode(() => validateCorrectionIntent(valid({ evidence: ['https://example.invalid/a', 'https://example.invalid/a'] })), 'duplicate-evidence');
});

test('intent parsing requires exact canonical UTF-8 bytes within 96 KiB', () => {
  const text = serializeCorrectionIntent(valid());
  expect(parseCorrectionIntent(text)).toEqual(validateCorrectionIntent(valid()));
  expectCode(() => parseCorrectionIntent(JSON.stringify(valid())), 'noncanonical-correction-intent');
  expectCode(() => parseCorrectionIntent(`﻿${text}`), 'utf8-bom');
  expectCode(() => parseCorrectionIntent(Buffer.alloc(ACCOUNT_FREE_INTENT_MAX_BYTES + 1, 0x20)), 'correction-intent-too-large');
});
