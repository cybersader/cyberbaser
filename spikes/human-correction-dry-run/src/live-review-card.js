import { deepFreeze, stableStringify } from './case.js';
import { scanPublicValue } from './public-safety.js';
import { buildReviewEvidence } from './review-card.js';

export class LiveReviewCardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiveReviewCardError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LiveReviewCardError(code, message);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildLiveReviewEvidence(liveRun) {
  if (!liveRun || liveRun.artifactType !== 'private-local-rendered-correction-run') {
    fail('invalid-live-run', 'live review card requires a completed local rendered correction run');
  }

  const mechanical = buildReviewEvidence(liveRun.evaluation);
  const evidence = {
    schemaVersion: 1,
    artifactType: 'local-static-rendered-correction-review-evidence',
    caseId: mechanical.caseId,
    status: 'pending-owner; no source write or public deployment has occurred',
    scope: 'internal agentic evidence only; not a human pilot result or product runtime',
    target: mechanical.target,
    exactChange: mechanical.exactChange,
    sourceBinding: mechanical.sourceBinding,
    byteProof: mechanical.byteProof,
    ofm: mechanical.ofm,
    trust: mechanical.trust,
    sourceIsolation: {
      cleanBefore: liveRun.sourceCheckout.cleanBefore,
      cleanAfter: liveRun.sourceCheckout.cleanAfter,
      sourceBytesUnchangedAfter: liveRun.sourceCheckout.sourceBytesUnchangedAfter,
      suppliedCheckoutWritePerformed: liveRun.noWrite.suppliedCheckoutWritePerformed,
      candidateAppliedOnlyToTemporaryCandidateCopy:
        liveRun.noWrite.candidateAppliedOnlyToTemporaryCandidateCopy,
      cleanupCompleted: liveRun.cleanup.completed,
      temporaryWorkspacesRetained: liveRun.cleanup.temporaryWorkspacesRetained,
    },
    projection: {
      baseline: clonePlain(liveRun.projection.baseline),
      candidate: clonePlain(liveRun.projection.candidate),
    },
    rendering: {
      renderer: liveRun.renderer.baseline.renderer,
      pin: liveRun.renderer.baseline.pin,
      isolatedWorkspaces: liveRun.renderer.isolatedWorkspaces,
      publicDeploymentPerformed: liveRun.renderer.publicDeploymentPerformed,
      baselineSite: clonePlain(liveRun.siteChecks.baseline),
      candidateSite: clonePlain(liveRun.siteChecks.candidate),
      linkDelta: clonePlain(liveRun.siteChecks.linkDelta),
      targetEvidence: clonePlain(liveRun.renderedTarget),
    },
  };

  scanPublicValue(evidence, { label: 'live review evidence', fail });
  return deepFreeze(evidence);
}

function row(label, value) {
  return `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function candidateOnlyRows(items) {
  if (items.length === 0) return '<p class="pass">No candidate-only broken links.</p>';
  return `<ul>${items.map((item) => `<li><code>${escapeHtml(item.page)}</code> → <code>${escapeHtml(item.href)}</code> (${escapeHtml(item.class)})</li>`).join('')}</ul>`;
}

export function renderLiveReviewCardHtml(liveRun) {
  const evidence = buildLiveReviewEvidence(liveRun);
  const exact = evidence.exactChange;
  const target = evidence.rendering.targetEvidence;
  const delta = evidence.rendering.linkDelta;
  const oldWithContext = `${exact.selectorPrefix}${exact.oldText}${exact.selectorSuffix}`;
  const newWithContext = `${exact.selectorPrefix}${exact.replacement}${exact.selectorSuffix}`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<title>${escapeHtml(evidence.caseId)} rendered correction review</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#111827;color:#e5e7eb}body{margin:0;padding:2rem}.card{max-width:920px;margin:auto;border:1px solid #475569;border-radius:14px;overflow:hidden;background:#0f172a}.head,.section{padding:1rem 1.25rem}.head{display:flex;justify-content:space-between;gap:1rem;background:#1e293b}.badge{font-weight:700;color:#fbbf24}.notice{padding:.75rem 1.25rem;background:#3f2d0b;color:#fde68a}.section{border-top:1px solid #334155}h1,h2,p,dl{margin:.2rem 0 .8rem}h1{font-size:1.2rem}h2{font-size:1rem;color:#cbd5e1}.diff{font-family:ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;padding:.75rem;margin:.5rem 0}.old{background:#451a1a;color:#fecaca}.new{background:#052e16;color:#bbf7d0}.row{display:grid;grid-template-columns:minmax(12rem,1fr) minmax(0,2fr);gap:.75rem;padding:.35rem 0}.row>*{margin:0;min-width:0;overflow-wrap:anywhere}dt{color:#94a3b8}dd,code{font-family:ui-monospace,SFMono-Regular,monospace}.pass{color:#86efac;font-weight:700}.footer{padding:1rem 1.25rem;border-top:1px solid #334155;color:#fca5a5;font-weight:700}@media(max-width:640px){body{padding:.75rem}.row{grid-template-columns:1fr}.head{display:block}}
</style>
</head>
<body>
<main class="card">
<header class="head"><h1>${escapeHtml(evidence.caseId)} rendered correction review</h1><span class="badge">pending owner</span></header>
<div class="notice">Internal agentic evidence only. No source write or public deployment has occurred.</div>
<section class="section"><h2>Exact proposed change</h2><div class="diff old">- ${escapeHtml(oldWithContext)}</div><div class="diff new">+ ${escapeHtml(newWithContext)}</div><p>${escapeHtml(exact.rationale)}</p></section>
<section class="section"><h2>Rendered target comparison</h2><dl>${row('Rendered page', target.baseline.page)}${row('Baseline old / replacement', `${target.baseline.quoteOccurrences} / ${target.baseline.replacementOccurrences}`)}${row('Candidate old / replacement', `${target.candidate.quoteOccurrences} / ${target.candidate.replacementOccurrences}`)}${row('Same rendered page', target.comparable.sameRenderedPage)}${row('Renderer pin', `${evidence.rendering.renderer} ${evidence.rendering.pin}`)}</dl></section>
<section class="section"><h2>Candidate-only link delta</h2><dl>${row('Baseline broken', delta.counts.baseline)}${row('Candidate broken', delta.counts.candidate)}${row('Candidate-only', delta.counts.candidateOnly)}${row('Baseline-only', delta.counts.baselineOnly)}${row('Comparison tuple', delta.tuple.join(' / '))}</dl>${candidateOnlyRows(delta.candidateOnly)}</section>
<section class="section"><h2>Isolation and cleanup</h2><dl>${row('Checkout clean before / after', `${evidence.sourceIsolation.cleanBefore} / ${evidence.sourceIsolation.cleanAfter}`)}${row('Source bytes unchanged', evidence.sourceIsolation.sourceBytesUnchangedAfter)}${row('Candidate application', 'temporary candidate copy only')}${row('Quartz workspaces', 'separate baseline and candidate')}${row('Temporary cleanup', evidence.sourceIsolation.cleanupCompleted)}${row('Public deployment', evidence.rendering.publicDeploymentPerformed)}</dl></section>
<footer class="footer">Owner decision and any owner-controlled local application happen separately.</footer>
</main>
</body>
</html>
`;

  if (/<script\b|\s(?:src|href|action)\s*=/iu.test(html)) {
    fail('active-content', 'generated live review HTML contains active or remote-resource markup');
  }
  scanPublicValue(html, { label: 'live review HTML', fail });
  return html;
}

export function buildLiveReviewCard(liveRun) {
  const evidence = buildLiveReviewEvidence(liveRun);
  return deepFreeze({
    evidence,
    json: stableStringify(evidence),
    html: renderLiveReviewCardHtml(liveRun),
  });
}
