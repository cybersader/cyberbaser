import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyCorrection,
  CorrectionError,
  prepareCorrection,
} from '@cyberbaser/correction';
import { DryRunCaseError, validateCase } from '../src/case.js';
import { evaluateCorrection } from '../src/evaluate.js';
import { buildReviewCard, ReviewCardError } from '../src/review-card.js';
import { SYNTHETIC_OWNER_POLICY } from '../src/verification.js';

const temporaryDirectories = [];
const COMMIT = '5555555555555555555555555555555555555555';
const REPOSITORY = 'https://example.org/adversarial-kb';

function representationDigest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

async function temporaryCheckout(prefix = 'correction-adversarial-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function caseFor(sourcePath, quote, replacement, overrides = {}) {
  return {
    repository: REPOSITORY,
    baseCommit: COMMIT,
    sourcePath,
    publicUrl: 'https://example.org/kb/target',
    quote,
    replacement,
    rationale: 'Synthetic adversarial rationale for a bounded correction.',
    evidence: ['Synthetic local evidence only.'],
    kind: 'wording',
    ...overrides,
  };
}

async function evaluate(checkoutDir, caseData) {
  return evaluateCorrection({
    caseData,
    checkoutDir,
    ownerPolicy: SYNTHETIC_OWNER_POLICY,
    policyRevision: 'adversarial-policy-v1',
  });
}

async function expectCorrectionFailure(promise, code) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CorrectionError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected CorrectionError(${code})`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('adversarial exact-anchor and source-binding failures', () => {
  test('duplicate quote ambiguity fails closed without changing source bytes or producing an evaluation', async () => {
    const checkout = await temporaryCheckout();
    const source = path.join(checkout, 'duplicate.md');
    await writeFile(source, 'alpha repeated omega\nalpha repeated omega\n', 'utf8');
    const before = await readFile(source);

    await expectCorrectionFailure(
      evaluate(checkout, caseFor('duplicate.md', 'repeated', 'corrected')),
      'quote-ambiguous',
    );

    expect((await readFile(source)).equals(before)).toBe(true);
  });

  test('missing quote fails closed instead of trimming, guessing, or fuzzy matching', async () => {
    const checkout = await temporaryCheckout();
    await writeFile(path.join(checkout, 'missing.md'), 'The exact source sentence is here.\n', 'utf8');

    await expectCorrectionFailure(
      evaluate(checkout, caseFor('missing.md', 'the exact source sentence is here', 'replacement')),
      'quote-not-found',
    );
  });

  test('an owner mapping mismatch does not fall back to URL, title, slug, or repository search', async () => {
    const checkout = await temporaryCheckout();
    await mkdir(path.join(checkout, 'docs'), { recursive: true });
    const quote = 'The owner-confirmed source contains this exact sentence.';
    await writeFile(path.join(checkout, 'docs', 'target.md'), `# Target\n\n${quote}\n`, 'utf8');
    await writeFile(path.join(checkout, 'docs', 'wrong.md'), '# Wrong mapping\n\nDifferent text.\n', 'utf8');

    await expectCorrectionFailure(
      evaluate(checkout, caseFor('docs/wrong.md', quote, 'Corrected sentence.', {
        publicUrl: 'https://example.org/kb/target',
      })),
      'quote-not-found',
    );
  });

  test('a prepared correction rejects a stale same-length base by digest', () => {
    const base = Buffer.from('left old right', 'utf8');
    const stale = Buffer.from('LEFT old right', 'utf8');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old' },
      replacement: 'new',
    });

    expect(stale.length).toBe(base.length);
    expect(() => applyCorrection(stale, correction)).toThrow(CorrectionError);
    try {
      applyCorrection(stale, correction);
    } catch (error) {
      expect(error.code).toBe('base-digest-mismatch');
    }
  });

  test('a tampered prepared candidate digest fails before a candidate is returned', () => {
    const base = Buffer.from('left old right', 'utf8');
    const correction = prepareCorrection(base, {
      selector: { quote: 'old' },
      replacement: 'new',
    });
    const tampered = {
      ...correction,
      candidateDigest: representationDigest(Buffer.from('left BAD right', 'utf8')),
    };

    expect(() => applyCorrection(base, tampered)).toThrow(CorrectionError);
    try {
      applyCorrection(base, tampered);
    } catch (error) {
      expect(error.code).toBe('candidate-digest-mismatch');
    }
  });
});

describe('adversarial byte preservation and review minimization', () => {
  test('preserves UTF-8, CRLF, emoji, combining characters, and all bytes outside the splice', async () => {
    const checkout = await temporaryCheckout();
    const source = path.join(checkout, 'unicode.md');
    const prefix = '---\r\ntitle: Café 👩🏽‍💻\r\n---\r\n\r\nBefore ';
    const quote = '😀 old é';
    const replacement = '😀 new 漢字';
    const suffix = ' after\r\nTail with two spaces  \r\n';
    const base = Buffer.from(`${prefix}${quote}${suffix}`, 'utf8');
    await writeFile(source, base);

    const record = await evaluate(checkout, caseFor('unicode.md', quote, replacement));
    const prepared = prepareCorrection(base, { selector: { quote }, replacement });
    const candidate = applyCorrection(base, prepared);
    const candidateSuffixStart = prepared.start + prepared.replacementBytes.length;

    expect(record.anchor.start).toBe(Buffer.byteLength(prefix, 'utf8'));
    expect(record.anchor.end - record.anchor.start).toBe(Buffer.byteLength(quote, 'utf8'));
    expect(candidate.subarray(0, prepared.start).equals(base.subarray(0, prepared.start))).toBe(true);
    expect(candidate.subarray(candidateSuffixStart).equals(base.subarray(prepared.end))).toBe(true);
    expect(record.base.digest).toBe(representationDigest(base));
    expect(record.candidate.digest).toBe(representationDigest(candidate));
    expect((await readFile(source)).equals(base)).toBe(true);
  });

  test('escapes script-shaped quote and rationale text without emitting executable markup', async () => {
    const checkout = await temporaryCheckout();
    const quote = 'Close </div><script>alert("quote")</script> safely.';
    const rationale = 'Rationale </p><script>alert("rationale")</script> remains literal.';
    await writeFile(path.join(checkout, 'injection.md'), `# Public\n\n${quote}\n`, 'utf8');

    const record = await evaluate(checkout, caseFor('injection.md', quote, 'Close safely.', { rationale }));
    const card = buildReviewCard(record);

    expect(card.html).toContain('&lt;script&gt;alert(&quot;quote&quot;)&lt;/script&gt;');
    expect(card.html).toContain('&lt;script&gt;alert(&quot;rationale&quot;)&lt;/script&gt;');
    expect(card.html).not.toMatch(/<script\b[^>]*>\s*alert/iu);
    expect(card.html).not.toMatch(/\s(?:src|href|action)\s*=/iu);
  });

  test('fails closed on attribute-bearing HTML injection even after text escaping', async () => {
    const checkout = await temporaryCheckout();
    const quote = '<img src=x onerror=alert(1)> should remain text.';
    await writeFile(path.join(checkout, 'active-attribute.md'), `${quote}\n`, 'utf8');
    const record = await evaluate(checkout, caseFor('active-attribute.md', quote, 'Safe text.'));

    try {
      buildReviewCard(record);
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewCardError);
      expect(error.code).toBe('active-content');
      return;
    }
    throw new Error('expected ReviewCardError(active-content)');
  });

  test('rejects an injected public-credit field rather than silently adding unmodeled review content', () => {
    const input = caseFor('credit.md', 'old', 'new', {
      credit: '<img src=x onerror=alert("credit")>',
    });

    try {
      validateCase(input);
    } catch (error) {
      expect(error).toBeInstanceOf(DryRunCaseError);
      expect(error.code).toBe('unknown-case-field');
      return;
    }
    throw new Error('expected DryRunCaseError(unknown-case-field)');
  });

  test('review artifacts contain only the selected quote and explicit adjacent context from source', async () => {
    const checkout = await temporaryCheckout();
    const quote = 'The visible sentence needs correction.';
    const secretBefore = 'PRIVATE-BEFORE-CANARY-7f2d';
    const secretAfter = 'PRIVATE-AFTER-CANARY-9a41';
    await writeFile(
      path.join(checkout, 'minimized.md'),
      `# Hidden heading\n\n${secretBefore}\n\nSELECTED ${quote} CONTEXT\n\n${secretAfter}\n`,
      'utf8',
    );

    const record = await evaluate(checkout, caseFor('minimized.md', quote, 'The visible sentence is corrected.', {
      prefix: 'SELECTED ',
      suffix: ' CONTEXT',
    }));
    const card = buildReviewCard(record);

    for (const artifact of [card.json, card.html]) {
      expect(artifact).not.toContain(secretBefore);
      expect(artifact).not.toContain(secretAfter);
      expect(artifact).not.toContain('# Hidden heading');
    }
    expect(card.evidence.exactChange).toMatchObject({
      selectorPrefix: 'SELECTED ',
      oldText: quote,
      selectorSuffix: ' CONTEXT',
    });
  });
});
