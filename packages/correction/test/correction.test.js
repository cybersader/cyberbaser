import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  resolveQuoteAnchor,
  prepareCorrection,
  applyCorrection,
  CorrectionError,
} from '../src/index.js';

const bytes = (value) => Buffer.from(value, 'utf8');
const digest = (value) => `sha-256=:${createHash('sha256').update(value).digest('base64')}:`;

function expectCorrectionError(fn, code) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CorrectionError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected CorrectionError(${code})`);
}

describe('resolveQuoteAnchor', () => {
  test('resolves an exact ASCII quote to half-open byte offsets', () => {
    const base = bytes('alpha beta gamma');
    expect(resolveQuoteAnchor(base, { quote: 'beta' })).toEqual({ start: 6, end: 10 });
  });

  test('reports byte offsets rather than JavaScript character offsets', () => {
    const base = bytes('é漢字 target');
    const start = bytes('é漢字 ').length;
    expect(resolveQuoteAnchor(base, { quote: 'target' })).toEqual({
      start,
      end: start + bytes('target').length,
    });
  });

  test('matches emoji and combining characters as their exact UTF-8 bytes', () => {
    const quote = '👩🏽‍💻 é';
    const base = bytes(`before ${quote} after`);
    const start = bytes('before ').length;
    expect(resolveQuoteAnchor(base, { quote })).toEqual({
      start,
      end: start + bytes(quote).length,
    });
  });

  test('preserves CRLF and requires selectors to match it exactly', () => {
    const base = bytes('first\r\nsecond\r\nthird\r\n');
    expect(resolveQuoteAnchor(base, { quote: 'second\r\n' })).toEqual({
      start: bytes('first\r\n').length,
      end: bytes('first\r\nsecond\r\n').length,
    });
    expectCorrectionError(
      () => resolveQuoteAnchor(base, { quote: 'second\n' }),
      'quote-not-found',
    );
  });

  test('does not normalize NFC and NFD text', () => {
    const nfc = 'café';
    const nfd = 'café';
    const base = bytes(`${nfc}|${nfd}`);
    expect(resolveQuoteAnchor(base, { quote: nfc })).toEqual({
      start: 0,
      end: bytes(nfc).length,
    });
    expect(resolveQuoteAnchor(base, { quote: nfd })).toEqual({
      start: bytes(`${nfc}|`).length,
      end: base.length,
    });
  });

  test('uses immediately adjacent prefix and suffix to disambiguate', () => {
    const base = bytes('left [same] middle [same] right');
    const start = bytes('left [same] middle [').length;
    expect(resolveQuoteAnchor(base, {
      quote: 'same',
      prefix: 'middle [',
      suffix: '] right',
    })).toEqual({ start, end: start + 4 });

    expectCorrectionError(
      () => resolveQuoteAnchor(bytes('xx same yy'), {
        quote: 'same',
        prefix: 'xx',
      }),
      'quote-not-found',
    );
  });

  test('fails closed when context still leaves multiple matches', () => {
    expectCorrectionError(
      () => resolveQuoteAnchor(bytes('x [same] y [same] z'), {
        quote: 'same',
        prefix: '[',
        suffix: ']',
      }),
      'quote-ambiguous',
    );
  });

  test('fails closed when the quote is absent', () => {
    expectCorrectionError(
      () => resolveQuoteAnchor(bytes('alpha'), { quote: 'beta' }),
      'quote-not-found',
    );
  });

  test('requires a present, non-empty quote without trimming it', () => {
    expectCorrectionError(() => resolveQuoteAnchor(bytes('x'), {}), 'missing-quote');
    expectCorrectionError(() => resolveQuoteAnchor(bytes('x'), { quote: '' }), 'empty-quote');
    expect(resolveQuoteAnchor(bytes('a   b'), { quote: '   ' })).toEqual({ start: 1, end: 4 });
  });

  test('rejects invalid UTF-8 base bytes', () => {
    expectCorrectionError(
      () => resolveQuoteAnchor(Buffer.from([0x61, 0xff, 0x62]), { quote: 'a' }),
      'invalid-utf8',
    );
  });
});

describe('prepareCorrection', () => {
  test('binds the base, exact old bytes, replacement, selector, and candidate', () => {
    const base = bytes('the old value');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old', prefix: 'the ', suffix: ' value' },
      replacement: 'new',
    });
    const candidate = bytes('the new value');

    expect(correction).toEqual({
      baseByteLength: base.length,
      baseDigest: digest(base),
      start: 4,
      end: 7,
      expectedOldBytes: bytes('old'),
      replacementBytes: bytes('new'),
      selector: { quote: 'old', prefix: 'the ', suffix: ' value' },
      candidateByteLength: candidate.length,
      candidateDigest: digest(candidate),
    });
  });

  test('requires an exact replacement string and rejects invalid Unicode', () => {
    expectCorrectionError(
      () => prepareCorrection(bytes('old'), { selector: { quote: 'old' } }),
      'missing-replacement',
    );
    expectCorrectionError(
      () => prepareCorrection(bytes('old'), {
        selector: { quote: 'old' },
        replacement: bytes('new'),
      }),
      'invalid-string',
    );
    expectCorrectionError(
      () => prepareCorrection(bytes('old'), {
        selector: { quote: 'old' },
        replacement: '\ud800',
      }),
      'invalid-utf8',
    );
  });

  test('supports an empty replacement as an exact deletion', () => {
    const base = bytes('keep DELETE keep');
    const correction = prepareCorrection(base, {
      selector: { quote: 'DELETE ' },
      replacement: '',
    });
    expect(correction.replacementBytes.length).toBe(0);
    expect(applyCorrection(base, correction).equals(bytes('keep keep'))).toBe(true);
  });
});

describe('applyCorrection', () => {
  test('applies one splice and returns a new Buffer', () => {
    const base = bytes('alpha old omega');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old' },
      replacement: 'NEW',
    });
    const result = applyCorrection(base, correction);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.equals(bytes('alpha NEW omega'))).toBe(true);
    expect(result).not.toBe(base);
  });

  test('rejects a stale same-length base by digest rather than guessing or rebasing', () => {
    const base = bytes('left old right');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old' },
      replacement: 'new',
    });
    const stale = bytes('LEFT old right');
    expect(stale.length).toBe(base.length);
    expectCorrectionError(() => applyCorrection(stale, correction), 'base-digest-mismatch');
  });

  test('validates the bound base length and digest shape', () => {
    const base = bytes('left old right');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old' },
      replacement: 'new',
    });
    expectCorrectionError(
      () => applyCorrection(bytes('short'), correction),
      'base-length-mismatch',
    );
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, baseDigest: 'sha-256=:not-a-digest:' }),
      'invalid-base-digest',
    );
  });

  test('rejects tampered expected old bytes', () => {
    const base = bytes('left old right');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old' },
      replacement: 'new',
    });
    const tampered = { ...correction, expectedOldBytes: bytes('OLD') };
    expectCorrectionError(() => applyCorrection(base, tampered), 'old-bytes-mismatch');
  });

  test('rejects offsets outside the bound base', () => {
    const base = bytes('left old right');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old' },
      replacement: 'new',
    });
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, end: base.length + 1 }),
      'splice-out-of-bounds',
    );
  });

  test('validates candidate length and digest', () => {
    const base = bytes('old');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old' },
      replacement: 'new',
    });
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, candidateByteLength: 99 }),
      'candidate-length-mismatch',
    );
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, candidateDigest: digest(bytes('bad')) }),
      'candidate-digest-mismatch',
    );
  });

  test('rejects invalid UTF-8 in the base and in a tampered replacement', () => {
    const base = bytes('old');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old' },
      replacement: 'new',
    });
    expectCorrectionError(
      () => applyCorrection(Buffer.from([0xff, 0x00, 0x00]), correction),
      'invalid-utf8',
    );
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, replacementBytes: Buffer.from([0xff]) }),
      'invalid-utf8',
    );
  });

  test('does not mutate source, request, correction buffers, or selector input', () => {
    const base = bytes('before old after');
    const baseSnapshot = Buffer.from(base);
    const selector = { quote: 'old', prefix: 'before ', suffix: ' after' };
    const request = { selector, replacement: 'new' };
    const correction = prepareCorrection(base, request);
    const oldSnapshot = Buffer.from(correction.expectedOldBytes);
    const preparedReplacementSnapshot = Buffer.from(correction.replacementBytes);

    const result = applyCorrection(base, correction);

    expect(base.equals(baseSnapshot)).toBe(true);
    expect(request).toEqual({ selector, replacement: 'new' });
    expect(selector).toEqual({ quote: 'old', prefix: 'before ', suffix: ' after' });
    expect(correction.expectedOldBytes.equals(oldSnapshot)).toBe(true);
    expect(correction.replacementBytes.equals(preparedReplacementSnapshot)).toBe(true);
    expect(result.equals(bytes('before new after'))).toBe(true);
  });

  test('preserves every byte outside the splice exactly', () => {
    const prefix = Buffer.concat([
      bytes('---\r\ntitle: café\r\n---\r\n'),
      bytes('👩🏽‍💻 '),
    ]);
    const old = bytes('replace é');
    const suffix = bytes('\r\n\t[[Exact Link|alias]]  \r\n');
    const base = Buffer.concat([prefix, old, suffix]);
    const correction = prepareCorrection(base, {
      selector: { quote: 'replace é' },
      replacement: 'replacement 漢字',
    });
    const result = applyCorrection(base, correction);

    expect(result.subarray(0, correction.start).equals(base.subarray(0, correction.start))).toBe(true);
    const resultSuffix = result.subarray(correction.start + correction.replacementBytes.length);
    expect(resultSuffix.equals(base.subarray(correction.end))).toBe(true);
  });
});
