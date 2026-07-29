import { describe, expect, test } from 'bun:test';
import { DryRunCaseError, caseId, publicSafeCase, stableStringify, validateCase } from '../src/case.js';
import { SYNTHETIC_CASE } from '../src/verification.js';

function expectCaseError(input, code) {
  try {
    validateCase(input);
  } catch (error) {
    expect(error).toBeInstanceOf(DryRunCaseError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected DryRunCaseError(${code})`);
}

describe('strict correction case validation', () => {
  test('normalizes, freezes, and preserves exact text', () => {
    const value = validateCase({ ...SYNTHETIC_CASE, prefix: 'prefix ', suffix: ' suffix' });
    expect(value.quote).toBe(SYNTHETIC_CASE.quote);
    expect(value.prefix).toBe('prefix ');
    expect(value.suffix).toBe(' suffix');
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.evidence)).toBe(true);
  });

  test('accepts an owner-supplied absolute POSIX mapping for a caller-supplied checkout', () => {
    const value = validateCase({ ...SYNTHETIC_CASE, sourcePath: '/tmp/owner-checkout/public-typo.md' });
    expect(value.sourcePath).toBe('/tmp/owner-checkout/public-typo.md');
  });

  test('rejects unknown fields, traversal, credentials, no-op changes, and malformed commits', () => {
    expectCaseError({ ...SYNTHETIC_CASE, surprise: true }, 'unknown-case-field');
    expectCaseError({ ...SYNTHETIC_CASE, sourcePath: '../private.md' }, 'unsafe-source-path');
    expectCaseError({ ...SYNTHETIC_CASE, publicUrl: 'https://user:secret@example.org/page' }, 'credentialed-url');
    expectCaseError({ ...SYNTHETIC_CASE, replacement: SYNTHETIC_CASE.quote }, 'no-op-replacement');
    expectCaseError({ ...SYNTHETIC_CASE, baseCommit: 'ABC' }, 'invalid-base-commit');
  });

  test('public-safe JSON omits raw evidence and source paths', () => {
    const input = {
      ...SYNTHETIC_CASE,
      sourcePath: '/tmp/private-checkout/public-typo.md',
      evidence: ['/tmp/private-proof.txt contains local verification details.'],
    };
    const publicValue = publicSafeCase(input);
    const json = stableStringify(publicValue);
    expect(json).not.toContain('/tmp/');
    expect(json).not.toContain('private-proof');
    expect(publicValue.evidenceItems).toBe(1);
    expect(publicValue.sourceMapping).toContain('redacted');
  });

  test('stable JSON and case identifiers are deterministic', () => {
    const reordered = Object.fromEntries(Object.entries(SYNTHETIC_CASE).reverse());
    expect(stableStringify(publicSafeCase(reordered))).toBe(stableStringify(publicSafeCase(SYNTHETIC_CASE)));
    expect(caseId(reordered)).toBe(caseId(SYNTHETIC_CASE));
  });
});
