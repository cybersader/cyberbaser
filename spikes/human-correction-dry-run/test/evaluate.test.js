import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CorrectionError } from '@cyberbaser/correction';
import { evaluateCorrection } from '../src/evaluate.js';
import { SYNTHETIC_CASE, SYNTHETIC_OWNER_POLICY } from '../src/verification.js';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixtureFile = fileURLToPath(new URL('../fixtures/public-typo.md', import.meta.url));

async function evaluate(caseData = SYNTHETIC_CASE, overrides = {}) {
  return evaluateCorrection({
    caseData,
    checkoutDir: fixturesDir,
    ownerPolicy: SYNTHETIC_OWNER_POLICY,
    policyRevision: 'test-policy-v1',
    ...overrides,
  });
}

describe('no-write correction evaluation', () => {
  test('prepares and applies exactly one in-memory splice', async () => {
    const record = await evaluate();
    expect(record.anchor.resolvedExactlyOnce).toBe(true);
    expect(record.anchor.expectedOldBytesVerified).toBe(true);
    expect(record.splice.exactlyOneFile).toBe(true);
    expect(record.splice.exactlyOneSplice).toBe(true);
    expect(record.splice.replacementByteLength).toBe(record.splice.removedByteLength + 1);
    expect(record.candidate.byteLength).toBe(record.base.byteLength + 1);
  });

  test('proves prefix and suffix byte identity and performs no source write', async () => {
    const before = await readFile(fixtureFile);
    const record = await evaluate();
    const after = await readFile(fixtureFile);
    expect(record.splice.prefixIdentical).toBe(true);
    expect(record.splice.suffixIdentical).toBe(true);
    expect(record.noWrite).toEqual({
      sourceWritePerformed: false,
      sourceBytesUnchangedAfterEvaluation: true,
      candidateExistsInMemoryOnly: true,
    });
    expect(after.equals(before)).toBe(true);
  });

  test('calls OFM and trust with the injected owner policy', async () => {
    const record = await evaluate();
    expect(record.ofm.verdict).toBe('clean');
    expect(record.ofm.findings).toEqual([]);
    expect(record.trust.policyRevision).toBe('test-policy-v1');
    expect(record.trust.authorType).toBe('anonymous');
    expect(record.trust.tier).toBe('anonymous');
    expect(record.trust.route).toBe('full-review');
    expect(record.trust.checks.typoClass).toBe(true);
  });

  test('supports an exact owner-supplied absolute source mapping without exposing it in public case data', async () => {
    const record = await evaluate({ ...SYNTHETIC_CASE, sourcePath: fixtureFile });
    expect(record.source.ownerSuppliedMapping).toBe(true);
    expect(record.source.repositoryRelativePath).toBe('public-typo.md');
    expect(JSON.stringify(record.case)).not.toContain(fixturesDir);
  });

  test('returns a deeply immutable record', async () => {
    const record = await evaluate();
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.anchor.selector)).toBe(true);
    expect(Object.isFrozen(record.trust.checks.perFile)).toBe(true);
    expect(() => { record.trust.route = 'auto-merge'; }).toThrow(TypeError);
  });

  test('fails closed on an ambiguous quote', async () => {
    const ambiguous = {
      ...SYNTHETIC_CASE,
      sourcePath: 'public-ambiguous.md',
      publicUrl: 'https://example.org/duplicate',
      quote: 'teh',
      replacement: 'the',
    };
    try {
      await evaluate(ambiguous);
    } catch (error) {
      expect(error).toBeInstanceOf(CorrectionError);
      expect(error.code).toBe('quote-ambiguous');
      return;
    }
    throw new Error('expected quote-ambiguous');
  });

  test('requires the owner policy instead of inventing one', async () => {
    expect(evaluateCorrection({
      caseData: SYNTHETIC_CASE,
      checkoutDir: fixturesDir,
      ownerPolicy: null,
      policyRevision: 'test-policy-v1',
    })).rejects.toMatchObject({ code: 'invalid-owner-policy' });
  });
});
