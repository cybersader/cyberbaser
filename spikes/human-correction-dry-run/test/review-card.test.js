import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateCorrection } from '../src/evaluate.js';
import { buildReviewCard, ReviewCardError } from '../src/review-card.js';
import { SYNTHETIC_OWNER_POLICY } from '../src/verification.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function maliciousEvaluation(overrides = {}) {
  const checkoutDir = await mkdtemp(path.join(os.tmpdir(), 'correction-card-'));
  temporaryDirectories.push(checkoutDir);
  const quote = 'Public <script>alert("x")</script> & text.';
  const selectedPassage = `${overrides.prefix ?? ''}${quote}${overrides.suffix ?? ''}`;
  await writeFile(path.join(checkoutDir, 'malicious.md'), `# Public fixture\n\n${selectedPassage}\n`, 'utf8');
  return evaluateCorrection({
    caseData: {
      repository: 'https://example.org/public-kb',
      baseCommit: '3333333333333333333333333333333333333333',
      sourcePath: 'malicious.md',
      publicUrl: 'https://example.org/public-fixture',
      quote,
      replacement: 'Public safe & corrected text.',
      rationale: 'The synthetic fixture checks deterministic escaping.',
      evidence: ['The public synthetic quote occurs once.'],
      kind: 'wording',
      ...overrides,
    },
    checkoutDir,
    ownerPolicy: SYNTHETIC_OWNER_POLICY,
    policyRevision: 'test-policy-v1',
  });
}

describe('deterministic local review card', () => {
  test('escapes selected text and emits no active or remote-resource markup', async () => {
    const evaluation = await maliciousEvaluation();
    const card = buildReviewCard(evaluation);
    expect(card.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; text.');
    expect(card.html).not.toMatch(/<script\b/iu);
    expect(card.html).not.toMatch(/\s(?:src|href|action)\s*=/iu);
    expect(card.html).toContain('Content-Security-Policy');
    expect(card.html).toContain('Exact proposed change');
    expect(card.html).not.toContain('Exact approved change');
  });

  test('redacts source paths and raw evidence from both artifacts', async () => {
    const evaluation = await maliciousEvaluation({
      evidence: ['/tmp/private-evidence/report.json was reviewed locally.'],
    });
    const card = buildReviewCard(evaluation);
    for (const artifact of [card.json, card.html]) {
      expect(artifact).not.toContain('/tmp/');
      expect(artifact).not.toContain('private-evidence');
      expect(artifact).not.toContain('malicious.md');
    }
    expect(card.evidence.target.sourceMapping).toBe('owner-supplied; path redacted');
    expect(card.evidence.exactChange.supportingEvidenceItems).toBe(1);
  });

  test('includes no source text outside the selected quote and optional context', async () => {
    const evaluation = await maliciousEvaluation({ prefix: 'SELECTED ', suffix: ' CONTEXT' });
    const card = buildReviewCard(evaluation);
    expect(card.evidence.exactChange.selectorPrefix).toBe('SELECTED ');
    expect(card.evidence.exactChange.oldText).toBe('Public <script>alert("x")</script> & text.');
    expect(card.evidence.exactChange.selectorSuffix).toBe(' CONTEXT');
    expect(card.json).not.toContain('# Public fixture');
  });

  test('JSON and HTML are deterministic for the same immutable evaluation', async () => {
    const evaluation = await maliciousEvaluation();
    const first = buildReviewCard(evaluation);
    const second = buildReviewCard(evaluation);
    expect(second.json).toBe(first.json);
    expect(second.html).toBe(first.html);
  });

  test('fails closed if public-facing text contains credential-like material', async () => {
    const evaluation = await maliciousEvaluation({ rationale: 'Use Bearer abc.def.ghi to verify this.' });
    expect(() => buildReviewCard(evaluation)).toThrow(ReviewCardError);
  });
});
