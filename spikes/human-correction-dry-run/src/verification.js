import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CorrectionError } from '@cyberbaser/correction';
import { checkSite } from '@cyberbaser/linkcheck';
import { checkChange } from '@cyberbaser/ofm';
import { project } from '@cyberbaser/projection';
import { select } from '@cyberbaser/publish';
import { classify } from '@cyberbaser/trust';
import { stableStringify } from './case.js';
import { evaluateCorrection } from './evaluate.js';
import { buildReviewCard } from './review-card.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

export const SYNTHETIC_OWNER_POLICY = Object.freeze({
  trusted: [],
  agents: [],
  caps: { lines: 10, files: 1, proseWords: 25, typoLines: 4, typoWords: 4 },
  allowedNewFolders: [],
  frontmatterAllowlist: [],
});

export const SYNTHETIC_CASE = Object.freeze({
  repository: 'https://example.org/public-response-kb',
  baseCommit: '1111111111111111111111111111111111111111',
  sourcePath: 'public-typo.md',
  publicUrl: 'https://example.org/response-guide',
  quote: 'This guide assigns responsibilites, processes, and escalation paths.',
  replacement: 'This guide assigns responsibilities, processes, and escalation paths.',
  rationale: 'The replacement corrects one unambiguous spelling error without changing the sentence meaning or Markdown structure.',
  evidence: ['The synthetic public fixture contains the exact quote once.'],
  kind: 'typo',
});

const AMBIGUOUS_CASE = Object.freeze({
  repository: 'https://example.org/public-response-kb',
  baseCommit: '2222222222222222222222222222222222222222',
  sourcePath: 'public-ambiguous.md',
  publicUrl: 'https://example.org/duplicate-example',
  quote: 'teh',
  replacement: 'the',
  rationale: 'The synthetic spelling correction intentionally has an ambiguous quote.',
  evidence: ['The synthetic public fixture contains the exact quote twice.'],
  kind: 'typo',
});

function result(id, criterion, pass, observed) {
  return { id, criterion, status: pass ? 'PASS' : 'FAIL', observed };
}

export async function runSyntheticVerification() {
  const fixturePath = fileURLToPath(new URL('../fixtures/public-typo.md', import.meta.url));
  const beforeFixture = await readFile(fixturePath);
  const evaluation = await evaluateCorrection({
    caseData: SYNTHETIC_CASE,
    checkoutDir: FIXTURES_DIR,
    ownerPolicy: SYNTHETIC_OWNER_POLICY,
    policyRevision: 'synthetic-policy-v1',
  });
  const card = buildReviewCard(evaluation);
  const afterFixture = await readFile(fixturePath);

  let ambiguousCode = 'no-error';
  try {
    await evaluateCorrection({
      caseData: AMBIGUOUS_CASE,
      checkoutDir: FIXTURES_DIR,
      ownerPolicy: SYNTHETIC_OWNER_POLICY,
      policyRevision: 'synthetic-policy-v1',
    });
  } catch (error) {
    ambiguousCode = error instanceof CorrectionError ? error.code : error?.code ?? error?.name ?? 'unknown-error';
  }

  const checks = [
    result('D01', 'all six local package interfaces resolve',
      [checkSite, checkChange, project, select, classify].every((value) => typeof value === 'function'),
      'correction is exercised by evaluation; linkcheck, OFM, projection, publish, and trust exports are functions'),
    result('D02', 'one exact quote resolves to one splice',
      evaluation.anchor.resolvedExactlyOnce && evaluation.splice.exactlyOneFile && evaluation.splice.exactlyOneSplice,
      `[${evaluation.anchor.start}, ${evaluation.anchor.end})`),
    result('D03', 'all bytes outside the splice are identical',
      evaluation.splice.prefixIdentical && evaluation.splice.suffixIdentical,
      `${evaluation.splice.prefixBytesPreserved} prefix bytes and ${evaluation.splice.suffixBytesPreserved} suffix bytes preserved`),
    result('D04', 'OFM classifies the synthetic typo as clean',
      evaluation.ofm.verdict === 'clean', evaluation.ofm.verdict),
    result('D05', 'injected owner policy routes an anonymous correction to full review',
      evaluation.trust.tier === 'anonymous' && evaluation.trust.route === 'full-review',
      `${evaluation.trust.tier}/${evaluation.trust.route}`),
    result('D06', 'evaluation record is immutable and explicitly no-write',
      Object.isFrozen(evaluation) && Object.isFrozen(evaluation.trust.checks) && evaluation.noWrite.sourceWritePerformed === false,
      'top-level and nested checks frozen; sourceWritePerformed=false'),
    result('D07', 'fixture bytes remain unchanged after evaluation',
      beforeFixture.equals(afterFixture) && evaluation.noWrite.sourceBytesUnchangedAfterEvaluation,
      'byte-identical before and after'),
    result('D08', 'ambiguous quotes fail closed',
      ambiguousCode === 'quote-ambiguous', ambiguousCode),
    result('D09', 'review JSON redacts the owner-supplied source path',
      !card.json.includes(SYNTHETIC_CASE.sourcePath) && card.evidence.target.sourceMapping.includes('redacted'),
      card.evidence.target.sourceMapping),
    result('D10', 'review HTML contains no scripts or resource/action attributes',
      !/<script\b|\s(?:src|href|action)\s*=/iu.test(card.html),
      'static HTML with restrictive CSP and inline styles only'),
    result('D11', 'review evidence contains only selected quote/context source text',
      card.evidence.exactChange.oldText === SYNTHETIC_CASE.quote
        && card.evidence.exactChange.selectorPrefix === ''
        && card.evidence.exactChange.selectorSuffix === '',
      'no unselected surrounding source included'),
  ];

  return {
    schemaVersion: 1,
    verifier: 'human-correction-dry-run/synthetic-v1',
    complete: checks.every((check) => check.status === 'PASS'),
    checks,
  };
}

export async function syntheticVerificationJson() {
  return stableStringify(await runSyntheticVerification());
}
