import { deepFreeze, stableStringify } from './case.js';
import { scanPublicValue } from './public-safety.js';

export class ReviewCardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReviewCardError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReviewCardError(code, message);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function compactTrustChecks(checks) {
  return {
    ofmVerdict: checks?.ofm?.verdict ?? 'unknown',
    changedLines: checks?.lines?.changed ?? null,
    fileCount: checks?.files?.count ?? null,
    structuralChange: checks?.structural?.changed ?? null,
    typoClass: checks?.typoClass ?? null,
  };
}

export function buildReviewEvidence(evaluation) {
  if (!evaluation || evaluation.artifactType !== 'private-no-write-correction-evaluation') {
    fail('invalid-evaluation', 'review card requires a correction evaluation record');
  }

  const evidence = {
    schemaVersion: 1,
    artifactType: 'local-static-correction-review-evidence',
    caseId: evaluation.caseId,
    status: 'pending-owner; no source write has occurred',
    scope: 'internal agentic evidence only; not a human pilot result or product runtime',
    target: {
      repository: evaluation.case.repository,
      baseCommit: evaluation.case.baseCommit,
      publicUrl: evaluation.case.publicUrl,
      sourceMapping: 'owner-supplied; path redacted',
    },
    exactChange: {
      selectorPrefix: evaluation.case.prefix ?? '',
      oldText: evaluation.case.quote,
      selectorSuffix: evaluation.case.suffix ?? '',
      replacement: evaluation.case.replacement,
      deletion: evaluation.case.replacement.length === 0,
      rationale: evaluation.case.rationale,
      kind: evaluation.case.kind,
      supportingEvidenceItems: evaluation.case.evidenceItems,
    },
    sourceBinding: {
      baseByteLength: evaluation.base.byteLength,
      baseDigest: evaluation.base.digest,
      candidateByteLength: evaluation.candidate.byteLength,
      candidateDigest: evaluation.candidate.digest,
      halfOpenByteRange: [evaluation.anchor.start, evaluation.anchor.end],
      expectedOldBytesVerified: evaluation.anchor.expectedOldBytesVerified,
      quoteResolvedExactlyOnce: evaluation.anchor.resolvedExactlyOnce,
    },
    byteProof: {
      prefixBytesPreserved: evaluation.splice.prefixBytesPreserved,
      suffixBytesPreserved: evaluation.splice.suffixBytesPreserved,
      prefixIdentical: evaluation.splice.prefixIdentical,
      suffixIdentical: evaluation.splice.suffixIdentical,
      exactlyOneFile: evaluation.splice.exactlyOneFile,
      exactlyOneSplice: evaluation.splice.exactlyOneSplice,
    },
    ofm: {
      verdict: evaluation.ofm.verdict,
      findingCount: evaluation.ofm.findings.length,
      findingTypes: evaluation.ofm.findings.map((finding) => finding.type),
      stats: evaluation.ofm.stats,
    },
    trust: {
      policyRevision: evaluation.trust.policyRevision,
      authorType: evaluation.trust.authorType,
      tier: evaluation.trust.tier,
      route: evaluation.trust.route,
      reasons: evaluation.trust.reasons,
      checks: compactTrustChecks(evaluation.trust.checks),
    },
    noWrite: evaluation.noWrite,
  };

  scanPublicValue(evidence, { label: 'review evidence', fail });
  return deepFreeze(evidence);
}

function row(label, value) {
  return `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

export function renderReviewCardHtml(evaluation) {
  const evidence = buildReviewEvidence(evaluation);
  const exact = evidence.exactChange;
  const oldWithContext = `${exact.selectorPrefix}${exact.oldText}${exact.selectorSuffix}`;
  const newWithContext = `${exact.selectorPrefix}${exact.replacement}${exact.selectorSuffix}`;
  const findings = evidence.ofm.findingTypes.length === 0 ? 'none' : evidence.ofm.findingTypes.join(', ');
  const reasons = evidence.trust.reasons.length === 0 ? 'none' : evidence.trust.reasons.join(', ');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<title>${escapeHtml(evidence.caseId)} correction review</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#111827;color:#e5e7eb}body{margin:0;padding:2rem}.card{max-width:820px;margin:auto;border:1px solid #475569;border-radius:14px;overflow:hidden;background:#0f172a}.head,.section{padding:1rem 1.25rem}.head{display:flex;justify-content:space-between;gap:1rem;background:#1e293b}.badge{font-weight:700;color:#fbbf24}.notice{padding:.75rem 1.25rem;background:#3f2d0b;color:#fde68a}.section{border-top:1px solid #334155}h1,h2,p,dl{margin:.2rem 0 .8rem}h1{font-size:1.2rem}h2{font-size:1rem;color:#cbd5e1}.diff{font-family:ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;padding:.75rem;margin:.5rem 0}.old{background:#451a1a;color:#fecaca}.new{background:#052e16;color:#bbf7d0}.row{display:grid;grid-template-columns:minmax(9rem,1fr) minmax(0,2fr);gap:.75rem;padding:.35rem 0}.row>*{margin:0;min-width:0;overflow-wrap:anywhere}dt{color:#94a3b8}dd{font-family:ui-monospace,SFMono-Regular,monospace}.footer{padding:1rem 1.25rem;border-top:1px solid #334155;color:#fca5a5;font-weight:700}@media(max-width:600px){body{padding:.75rem}.row{grid-template-columns:1fr}.head{display:block}}
</style>
</head>
<body>
<main class="card">
<header class="head"><h1>${escapeHtml(evidence.caseId)} correction review</h1><span class="badge">pending owner</span></header>
<div class="notice">Internal agentic evidence only. This is not a human pilot result or product runtime.</div>
<section class="section"><h2>Exact proposed change</h2><div class="diff old">- ${escapeHtml(oldWithContext)}</div><div class="diff new">+ ${escapeHtml(newWithContext)}</div><p>${escapeHtml(exact.rationale)}</p></section>
<section class="section"><h2>Target and binding</h2><dl>${row('Public page', evidence.target.publicUrl)}${row('Repository', evidence.target.repository)}${row('Base commit', evidence.target.baseCommit)}${row('Source path', evidence.target.sourceMapping)}${row('Byte range', `[${evidence.sourceBinding.halfOpenByteRange.join(', ')})`)}${row('Base digest', evidence.sourceBinding.baseDigest)}${row('Candidate digest', evidence.sourceBinding.candidateDigest)}</dl></section>
<section class="section"><h2>Mechanical checks</h2><dl>${row('Outside-splice bytes', evidence.byteProof.prefixIdentical && evidence.byteProof.suffixIdentical ? 'identical' : 'not identical')}${row('OFM', `${evidence.ofm.verdict}; findings: ${findings}`)}${row('Trust route', `${evidence.trust.route}; ${reasons}`)}${row('Policy revision', evidence.trust.policyRevision)}${row('Files / splices', `${evidence.byteProof.exactlyOneFile ? 1 : 0} / ${evidence.byteProof.exactlyOneSplice ? 1 : 0}`)}</dl></section>
<footer class="footer">No source write has occurred. Owner decision and any local application happen separately.</footer>
</main>
</body>
</html>
`;

  if (/<script\b|\s(?:src|href|action)\s*=/iu.test(html)) {
    fail('active-content', 'generated review HTML contains active or remote-resource markup');
  }
  scanPublicValue(html, { label: 'review HTML', fail });
  return html;
}

export function buildReviewCard(evaluation) {
  const evidence = buildReviewEvidence(evaluation);
  return deepFreeze({
    evidence,
    json: stableStringify(evidence),
    html: renderReviewCardHtml(evaluation),
  });
}
