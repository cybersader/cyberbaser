import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  resolveQuoteAnchor,
  prepareCorrection,
  prepareOffsetCorrection,
  deriveContiguousCorrection,
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

  test('applies offset-bound operations without weakening quote-bound selector checks', () => {
    const base = bytes('left old right');
    const offsetCorrection = prepareOffsetCorrection(base, {
      start: 5,
      end: 8,
      replacement: 'new',
    });
    expect(Object.hasOwn(offsetCorrection, 'selector')).toBe(false);
    expect(applyCorrection(base, offsetCorrection).equals(bytes('left new right'))).toBe(true);

    const quoteCorrection = prepareCorrection(base, {
      selector: { quote: 'old', prefix: 'left ', suffix: ' right' },
      replacement: 'new',
    });
    expectCorrectionError(
      () => applyCorrection(base, {
        ...quoteCorrection,
        selector: { ...quoteCorrection.selector, prefix: 'wrong ' },
      }),
      'selector-prefix-mismatch',
    );
    const { selector: _selector, ...selectorRemoved } = quoteCorrection;
    expectCorrectionError(() => applyCorrection(base, selectorRemoved), 'missing-selector');
    expectCorrectionError(
      () => applyCorrection(base, { ...quoteCorrection, operationType: 'offset' }),
      'unexpected-operation-type',
    );
  });

  test('rejects stale and tampered offset-bound operations', () => {
    const base = bytes('left old right');
    const correction = prepareOffsetCorrection(base, {
      start: 5,
      end: 8,
      replacement: 'new',
    });

    expectCorrectionError(
      () => applyCorrection(bytes('LEFT old right'), correction),
      'base-digest-mismatch',
    );
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, expectedOldBytes: bytes('OLD') }),
      'old-bytes-mismatch',
    );
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, replacementBytes: bytes('NEW') }),
      'candidate-digest-mismatch',
    );
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, candidateDigest: digest(bytes('wrong')) }),
      'candidate-digest-mismatch',
    );
    const { operationType: _operationType, ...typeRemoved } = correction;
    expectCorrectionError(() => applyCorrection(base, typeRemoved), 'missing-selector');
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, operationType: 'other' }),
      'missing-selector',
    );
  });

  test('rejects even a no-op offset that is inside a UTF-8 sequence', () => {
    const base = bytes('é');
    const correction = prepareOffsetCorrection(base, { start: 0, end: 0, replacement: '' });
    expectCorrectionError(
      () => applyCorrection(base, { ...correction, start: 1, end: 1 }),
      'offset-not-utf8-boundary',
    );
  });
});

describe('prepareOffsetCorrection', () => {
  test.each([
    ['insertion', 'alpha omega', 6, 6, 'middle ', 'alpha middle omega'],
    ['deletion', 'alpha DELETE omega', 6, 13, '', 'alpha omega'],
    ['replacement', 'alpha old omega', 6, 9, 'new', 'alpha new omega'],
    ['empty-file insertion', '', 0, 0, 'new', 'new'],
    ['whole-file deletion', 'old', 0, 3, '', ''],
    ['no-op', 'unchanged', 9, 9, '', 'unchanged'],
  ])('prepares and applies an exact %s', (_, source, start, end, replacement, expected) => {
    const base = bytes(source);
    const correction = prepareOffsetCorrection(base, { start, end, replacement });

    expect(correction.operationType).toBe('offset');
    expect(correction.start).toBe(start);
    expect(correction.end).toBe(end);
    expect(correction.expectedOldBytes.equals(base.subarray(start, end))).toBe(true);
    expect(correction.replacementBytes.equals(bytes(replacement))).toBe(true);
    expect(correction.baseDigest).toBe(digest(base));
    expect(correction.candidateDigest).toBe(digest(bytes(expected)));
    expect(applyCorrection(base, correction).equals(bytes(expected))).toBe(true);
  });

  test('uses UTF-8 byte offsets for emoji and combining marks', () => {
    const prefix = bytes('A👩🏽‍💻 ');
    const old = bytes('é');
    const base = Buffer.concat([prefix, old, bytes(' Z')]);
    const correction = prepareOffsetCorrection(base, {
      start: prefix.length,
      end: prefix.length + old.length,
      replacement: 'é漢字',
    });

    expect(correction.expectedOldBytes.equals(old)).toBe(true);
    expect(applyCorrection(base, correction).equals(bytes('A👩🏽‍💻 é漢字 Z'))).toBe(true);
  });

  test('preserves CRLF bytes and permits primitive CRLF edits without normalization', () => {
    const base = bytes('first\r\nsecond\r\n');
    const crOffset = bytes('first').length;
    const correction = prepareOffsetCorrection(base, {
      start: crOffset,
      end: crOffset + 1,
      replacement: '',
    });
    const result = applyCorrection(base, correction);

    expect(result.equals(bytes('first\nsecond\r\n'))).toBe(true);
    expect(result.includes(bytes('\r\nsecond\r\n'))).toBe(false);
    expect(result.subarray(crOffset).equals(base.subarray(crOffset + 1))).toBe(true);
  });

  test('rejects offsets inside UTF-8 code units', () => {
    const base = bytes('Aé👩‍💻Z');
    const eStart = bytes('A').length;
    const emojiStart = bytes('Aé').length;

    expectCorrectionError(
      () => prepareOffsetCorrection(base, { start: eStart + 1, end: eStart + 1, replacement: '' }),
      'offset-not-utf8-boundary',
    );
    expectCorrectionError(
      () => prepareOffsetCorrection(base, { start: emojiStart, end: emojiStart + 1, replacement: '' }),
      'offset-not-utf8-boundary',
    );
  });

  test('rejects invalid ranges, replacement values, base bytes, and Unicode', () => {
    const base = bytes('abc');
    for (const request of [
      { start: -1, end: 0, replacement: '' },
      { start: 2, end: 1, replacement: '' },
      { start: 0, end: 4, replacement: '' },
    ]) {
      expectCorrectionError(() => prepareOffsetCorrection(base, request), 'splice-out-of-bounds');
    }
    expectCorrectionError(
      () => prepareOffsetCorrection(base, { start: 0.5, end: 1, replacement: '' }),
      'invalid-offset',
    );
    expectCorrectionError(
      () => prepareOffsetCorrection(base, { start: 0, end: 1 }),
      'missing-replacement',
    );
    expectCorrectionError(
      () => prepareOffsetCorrection(base, { start: 0, end: 1, replacement: bytes('x') }),
      'invalid-string',
    );
    expectCorrectionError(
      () => prepareOffsetCorrection(base, { start: 0, end: 1, replacement: '\ud800' }),
      'invalid-utf8',
    );
    expectCorrectionError(
      () => prepareOffsetCorrection(Buffer.from([0xff]), { start: 0, end: 0, replacement: '' }),
      'invalid-utf8',
    );
  });
});

describe('deriveContiguousCorrection', () => {
  test.each([
    ['middle insertion', 'alpha omega', 'alpha middle omega'],
    ['middle deletion', 'alpha DELETE omega', 'alpha omega'],
    ['middle replacement', 'alpha old omega', 'alpha new omega'],
    ['leading insertion', 'omega', 'alpha omega'],
    ['trailing insertion', 'alpha', 'alpha omega'],
    ['leading deletion', 'alpha omega', 'omega'],
    ['trailing deletion', 'alpha omega', 'alpha'],
    ['empty-file insertion', '', 'new'],
    ['whole-file deletion', 'old', ''],
    ['whole-file replacement', 'old', 'new'],
  ])('derives one exact %s', (_, source, edited) => {
    const base = bytes(source);
    const correction = deriveContiguousCorrection(base, edited);
    expect(applyCorrection(base, correction).equals(bytes(edited))).toBe(true);
  });

  test('derives minimal boundary-safe Unicode, emoji, and combining-mark changes', () => {
    const cases = [
      ['café', 'cafê'],
      ['A👩🏽‍💻Z', 'A🧑🏽‍🔬Z'],
      ['café noir', 'café noir'],
      ['é', 'ê'],
      ['é', 'A©'],
    ];

    for (const [source, edited] of cases) {
      const base = bytes(source);
      const correction = deriveContiguousCorrection(base, edited);
      expect(applyCorrection(base, correction).equals(bytes(edited))).toBe(true);
      expect(correction.start === 0 || (base[correction.start] & 0xc0) !== 0x80).toBe(true);
      expect(
        correction.end === base.length || (base[correction.end] & 0xc0) !== 0x80,
      ).toBe(true);
    }
  });

  test('derives CRLF changes as primitive byte edits and never normalizes other lines', () => {
    const base = bytes('one\r\ntwo\r\nthree\r\n');
    const edited = 'one\r\ntwo\nthree\r\n';
    const correction = deriveContiguousCorrection(base, edited);

    expect(correction.expectedOldBytes.equals(bytes('\r'))).toBe(true);
    expect(correction.replacementBytes.length).toBe(0);
    expect(applyCorrection(base, correction).equals(bytes(edited))).toBe(true);
  });

  test('rejects an unchanged editor value', () => {
    expectCorrectionError(
      () => deriveContiguousCorrection(bytes('unchanged 👩‍💻'), 'unchanged 👩‍💻'),
      'no-op-edit',
    );
  });

  test('preserves every byte outside the derived contiguous operation', () => {
    const prefix = bytes('---\r\ntitle: café\r\n---\r\n👩🏽‍💻 ');
    const old = bytes('old é text');
    const suffix = bytes('\r\n\t[[Exact Link|alias]]  \r\n');
    const base = Buffer.concat([prefix, old, suffix]);
    const edited = `${prefix.toString('utf8')}replacement 漢字${suffix.toString('utf8')}`;
    const correction = deriveContiguousCorrection(base, edited);
    const result = applyCorrection(base, correction);

    expect(result.subarray(0, correction.start).equals(base.subarray(0, correction.start))).toBe(true);
    expect(
      result.subarray(correction.start + correction.replacementBytes.length)
        .equals(base.subarray(correction.end)),
    ).toBe(true);
    expect(result.equals(bytes(edited))).toBe(true);
  });

  test('enforces base, edited, old, replacement, and aggregate changed-byte limits', () => {
    const base = bytes('alpha old omega');
    const edited = 'alpha replacement omega';
    const passing = deriveContiguousCorrection(base, edited, {
      maxBaseBytes: base.length,
      maxEditedBytes: bytes(edited).length,
      maxOldBytes: bytes('old').length,
      maxReplacementBytes: bytes('replacement').length,
      maxChangedBytes: bytes('replacement').length,
      maxChangedLines: 1,
    });
    expect(applyCorrection(base, passing).equals(bytes(edited))).toBe(true);

    const failures = [
      [{ maxBaseBytes: base.length - 1 }, 'maxBaseBytes'],
      [{ maxEditedBytes: bytes(edited).length - 1 }, 'maxEditedBytes'],
      [{ maxOldBytes: bytes('old').length - 1 }, 'maxOldBytes'],
      [{ maxReplacementBytes: bytes('replacement').length - 1 }, 'maxReplacementBytes'],
      [{ maxChangedBytes: bytes('replacement').length - 1 }, 'maxChangedBytes'],
      [{ maxChangedLines: 0 }, 'maxChangedLines'],
    ];
    for (const [limits, limit] of failures) {
      const error = expectCorrectionError(
        () => deriveContiguousCorrection(base, edited, limits),
        'limit-exceeded',
      );
      expect(error.phase).toBe('derive');
      expect(error.details.limit).toBe(limit);
    }
  });

  test('enforces changed-line limits on the larger old or replacement span', () => {
    const base = bytes('before\none\ntwo\nafter');
    expectCorrectionError(
      () => deriveContiguousCorrection(base, 'before\nreplacement\nafter', {
        maxChangedLines: 1,
      }),
      'limit-exceeded',
    );
    const correction = deriveContiguousCorrection(base, 'before\nreplacement\nafter', {
      maxChangedLines: 3,
    });
    expect(applyCorrection(base, correction).equals(bytes('before\nreplacement\nafter'))).toBe(true);
  });

  test('counts UTF-8 bytes rather than JavaScript code units for limits', () => {
    const base = bytes('A👩‍💻Z');
    const replacement = '🧑‍🔬';
    const edited = `A${replacement}Z`;

    expectCorrectionError(
      () => deriveContiguousCorrection(base, edited, {
        maxReplacementBytes: bytes(replacement).length - 1,
      }),
      'limit-exceeded',
    );
    const correction = deriveContiguousCorrection(base, edited, {
      maxReplacementBytes: bytes(replacement).length,
    });
    expect(applyCorrection(base, correction).equals(bytes(edited))).toBe(true);
  });

  test('rejects no-op edits and actual changes that exceed a zero limit', () => {
    const base = bytes('same');
    expectCorrectionError(
      () => deriveContiguousCorrection(base, 'same', {
        maxOldBytes: 0,
        maxReplacementBytes: 0,
        maxChangedBytes: 0,
      }),
      'no-op-edit',
    );
    expectCorrectionError(
      () => deriveContiguousCorrection(base, 'same!', { maxChangedBytes: 0 }),
      'limit-exceeded',
    );
  });

  test('rejects invalid limits, invalid edited text, and invalid base UTF-8', () => {
    const base = bytes('base');
    for (const limits of [null, [], { maxBaseBytes: -1 }, { maxEditedBytes: 1.5 }]) {
      const code = limits === null || Array.isArray(limits) ? 'invalid-record' : 'invalid-limit';
      expectCorrectionError(() => deriveContiguousCorrection(base, 'edit', limits), code);
    }
    expectCorrectionError(
      () => deriveContiguousCorrection(base, 'edit', { maxChangeBytes: 1 }),
      'unknown-limit',
    );
    expectCorrectionError(
      () => deriveContiguousCorrection(base, '\ud800'),
      'invalid-utf8',
    );
    expectCorrectionError(
      () => deriveContiguousCorrection(Buffer.from([0xff]), 'edit'),
      'invalid-utf8',
    );
  });

  test('does not mutate the base and returns independent operation buffers', () => {
    const base = bytes('before old after');
    const snapshot = Buffer.from(base);
    const correction = deriveContiguousCorrection(base, 'before new after');
    const expectedSnapshot = Buffer.from(correction.expectedOldBytes);
    const replacementSnapshot = Buffer.from(correction.replacementBytes);

    applyCorrection(base, correction);

    expect(base.equals(snapshot)).toBe(true);
    expect(correction.expectedOldBytes.equals(expectedSnapshot)).toBe(true);
    expect(correction.replacementBytes.equals(replacementSnapshot)).toBe(true);
    expect(correction.expectedOldBytes.buffer).not.toBe(base.buffer);
  });
});
