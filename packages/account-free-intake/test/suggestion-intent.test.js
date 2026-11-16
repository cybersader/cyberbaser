import { expect, test } from 'bun:test';
import { applyChangeSetProposal, parseVersionedProposal } from '@cyberbaser/proposal';
import {
  validateSuggestionIntent, serializeSuggestionIntent, parseSuggestionIntent,
  suggestionIntentDigest, versionedIntentDigest, deriveAccountFreeProposal,
  sourceBindingDigest, createBareGitObjectResolver,
} from '../src/index.js';
import { createBareFixture } from './fixtures.js';

const digest = `sha-256=:${Buffer.alloc(32).toString('base64')}:`;
function intent(overrides = {}) {
  return {
    schemaVersion: 2, artifactType: 'cyberbaser-account-free-correction-intent',
    bindingDigest: digest, pageId: `page-v1:${'A'.repeat(43)}`,
    operations: [
      { operationId: 'first', start: 2, end: 5, expected: 'teh', replacement: 'the' },
      { operationId: 'second', start: 9, end: 13, expected: '🙂', replacement: '😀' },
    ],
    idempotencyKey: 'A'.repeat(32), ...overrides,
  };
}

test('v2 strict intent normalizes optional metadata and roundtrips canonical bytes', () => {
  const value = validateSuggestionIntent(intent());
  expect(value.rationale).toBeNull();
  expect(value.evidence).toEqual([]);
  expect(Object.isFrozen(value.operations[0])).toBe(true);
  expect(parseSuggestionIntent(serializeSuggestionIntent(value))).toEqual(value);
  expect(versionedIntentDigest(value)).toBe(suggestionIntentDigest(value));
  expect(suggestionIntentDigest(intent({ rationale: 'Two corrections.' }))).not.toBe(suggestionIntentDigest(value));
  expect(() => parseSuggestionIntent(JSON.stringify(value))).toThrow(/fixed-order/);
});

test.each([
  ['unknown top-level field', (v) => ({ ...v, source: {} }), 'unknown-field'],
  ['missing idempotency', ({ idempotencyKey, ...v }) => v, 'missing-field'],
  ['unknown operation field', (v) => ({ ...v, operations: [{ ...v.operations[0], selector: {} }] }), 'unknown-field'],
  ['overlap', (v) => ({ ...v, operations: [v.operations[0], { ...v.operations[1], start: 4, end: 8 }] }), 'overlap'],
  ['reverse order', (v) => ({ ...v, operations: [...v.operations].reverse() }), 'noncanonical-order'],
  ['duplicate id', (v) => ({ ...v, operations: [v.operations[0], { ...v.operations[1], operationId: 'first' }] }), 'duplicate-operation-id'],
  ['empty batch', (v) => ({ ...v, operations: [] }), 'operation-count'],
  ['51 operations', (v) => ({ ...v, operations: Array.from({ length: 51 }, (_, i) => ({ operationId: `op-${i}`, start: i, end: i, expected: '', replacement: 'x' })) }), 'operation-count'],
  ['large span', (v) => ({ ...v, operations: [{ operationId: 'large', start: 0, end: 0, expected: '', replacement: 'x'.repeat(16 * 1024 + 1) }] }), 'string-too-large'],
  ['aggregate size', (v) => ({ ...v, operations: Array.from({ length: 5 }, (_, i) => ({ operationId: `op-${i}`, start: i, end: i, expected: '', replacement: 'x'.repeat(16 * 1024) })) }), 'changed-bytes-too-large'],
  ['invalid Unicode', (v) => ({ ...v, operations: [{ ...v.operations[0], replacement: '\ud800' }] }), 'invalid-unicode'],
  ['null evidence', (v) => ({ ...v, evidence: null }), 'invalid-evidence'],
])('v2 intent refuses %s', (_, change, code) => {
  expect(() => validateSuggestionIntent(change(intent()))).toThrow(expect.objectContaining({ code }));
});

test('v2 derives exact emoji/CRLF operations against retained Git source with anonymous combined-file classification', async () => {
  const fixture = await createBareFixture();
  try {
    const base = fixture.baseBytes;
    const operations = [['teh', 'the'], ['🙂', '😀']].map(([expected, replacement], i) => {
      const start = base.indexOf(Buffer.from(expected));
      return { operationId: `edit-${i}`, start, end: start + Buffer.byteLength(expected), expected, replacement };
    });
    const bindingDigest = sourceBindingDigest(fixture.manifest);
    const result = await deriveAccountFreeProposal({
      intent: intent({ bindingDigest, pageId: fixture.page.pageId, operations }),
      bindings: { resolve: async () => ({ bindingDigest, manifest: fixture.manifest, page: fixture.page }) },
      git: createBareGitObjectResolver({ gitDirectory: fixture.bare, repository: fixture.manifest.source.repository }),
      proposalId: 'account-free:batch-test', submittedAt: '2026-08-10T12:34:56Z',
    });
    expect(parseVersionedProposal(result.proposalText).version).toBe(2);
    expect(result.classification.tier).toBe('anonymous');
    expect(result.classification.route).toBe('full-review');
    expect(result.proposal.submission.identityClaim).toBeNull();
    expect(result.proposal.changeSet.files[0].operations).toEqual(operations);
    expect(applyChangeSetProposal(base, result.proposal).toString()).toBe(base.toString().replace('teh', 'the').replace('🙂', '😀'));
    for (let i = 0; i < operations.length; i++) {
      const wrong = operations.map((op, index) => index === i ? { ...op, expected: 'x'.repeat(Buffer.byteLength(op.expected)) } : op);
      await expect(deriveAccountFreeProposal({
        intent: intent({ bindingDigest, pageId: fixture.page.pageId, operations: wrong }),
        bindings: { resolve: async () => ({ bindingDigest, manifest: fixture.manifest, page: fixture.page }) },
        git: { resolve: async () => ({ baseBytes: base, policy: { status: 'valid', digest: fixture.manifest.trustPolicy.digest, config: { trusted: [], agents: [] } } }) },
        proposalId: 'account-free:wrong-batch', submittedAt: '2026-08-10T12:34:56Z',
      })).rejects.toMatchObject({ code: 'old-bytes-mismatch' });
    }
  } finally { await fixture.cleanup(); }
});
