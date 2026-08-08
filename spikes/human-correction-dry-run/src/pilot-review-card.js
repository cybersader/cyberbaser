import { deepFreeze, stableStringify } from './case.js';

export class PilotReviewCardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PilotReviewCardError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PilotReviewCardError(code, message);
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

function compactRenderEvidence(renderEvidence) {
  if (!renderEvidence) return null;
  if (renderEvidence.artifactType === 'private-local-rendered-correction-run') {
    return {
      mode: 'cyberbase-pinned-live-lane',
      renderer: clonePlain(renderEvidence.renderer),
      projection: clonePlain(renderEvidence.projection),
      siteChecks: clonePlain(renderEvidence.siteChecks),
      renderedTarget: clonePlain(renderEvidence.renderedTarget),
      sourceCheckout: clonePlain(renderEvidence.sourceCheckout),
      cleanup: clonePlain(renderEvidence.cleanup),
    };
  }
  if (renderEvidence.artifactType === 'private-owner-static-output-render-evidence') {
    return clonePlain(renderEvidence);
  }
  fail('invalid-render-evidence', 'owner review requires recognized render evidence');
}

function present(value) {
  return value !== undefined && value !== null;
}

export function cyberbaserBoundaryEvidenceComplete(renderEvidence) {
  const lanes = [renderEvidence?.projection?.baseline, renderEvidence?.projection?.candidate];
  return renderEvidence?.artifactType === 'private-local-rendered-correction-run'
    && renderEvidence?.sourceCheckout?.publishConfigPresent === true
    && lanes.every((lane) => lane?.mode === 'cyberbaser-select-project-verify'
      && lane?.selection?.sourcePublished === true
      && lane?.projection?.ok === true
      && lane?.projection?.verification?.ok === true);
}

export function reviewCardContractMissing({ operator, evaluation, renderEvidence }) {
  if (!renderEvidence) return ['rendering'];
  const missing = [];
  const requireField = (condition, name) => { if (!condition) missing.push(name); };
  requireField(Number.isSafeInteger(evaluation?.base?.byteLength), 'sourceBinding.baseByteLength');
  requireField(typeof evaluation?.base?.digest === 'string', 'sourceBinding.baseDigest');
  requireField(Number.isSafeInteger(evaluation?.candidate?.byteLength), 'sourceBinding.candidateByteLength');
  requireField(typeof evaluation?.candidate?.digest === 'string', 'sourceBinding.candidateDigest');
  requireField(evaluation?.anchor?.expectedOldBytesVerified === true, 'anchor.expectedOldBytesVerified');
  requireField(evaluation?.anchor?.resolvedExactlyOnce === true, 'anchor.resolvedExactlyOnce');
  requireField(Number.isSafeInteger(evaluation?.anchor?.quoteOccurrencesWithoutContext), 'anchor.quoteOccurrencesWithoutContext');
  requireField(typeof evaluation?.anchor?.contextRequired === 'boolean', 'anchor.contextRequired');
  requireField(evaluation?.anchor?.selector && typeof evaluation.anchor.selector === 'object', 'anchor.selector');
  requireField(evaluation?.splice?.prefixIdentical === true && evaluation?.splice?.suffixIdentical === true, 'byteProof.outsideSplice');
  requireField(typeof evaluation?.ofm?.verdict === 'string', 'ofm.verdict');
  requireField(Array.isArray(evaluation?.ofm?.findings), 'ofm.findings');
  requireField(typeof evaluation?.ofm?.stats?.churn === 'number', 'ofm.stats.churn');
  requireField(Number.isSafeInteger(evaluation?.ofm?.stats?.escapesBefore), 'ofm.stats.escapesBefore');
  requireField(Number.isSafeInteger(evaluation?.ofm?.stats?.escapesAfter), 'ofm.stats.escapesAfter');
  requireField(Array.isArray(evaluation?.trust?.reasons), 'trust.reasons');
  requireField(evaluation?.trust?.checks && typeof evaluation.trust.checks === 'object', 'trust.checks');
  requireField(typeof renderEvidence?.ownerRecordedBuildCommand === 'string'
    || renderEvidence?.artifactType === 'private-local-rendered-correction-run', 'rendering.buildCommand');
  requireField(renderEvidence?.renderedTarget?.comparable?.sameRenderedPage === true, 'rendering.sameRenderedPage');
  requireField(typeof renderEvidence?.renderedTarget?.baseline?.observedExactText === 'string', 'rendering.baselineView');
  requireField(typeof renderEvidence?.renderedTarget?.candidate?.observedExactText === 'string', 'rendering.candidateView');
  requireField(Number.isSafeInteger(renderEvidence?.renderedTarget?.baseline?.byteLength), 'rendering.baselineByteLength');
  requireField(Number.isSafeInteger(renderEvidence?.renderedTarget?.candidate?.byteLength), 'rendering.candidateByteLength');
  requireField(Number.isSafeInteger(renderEvidence?.siteChecks?.baseline?.broken), 'links.baselineBroken');
  requireField(Number.isSafeInteger(renderEvidence?.siteChecks?.candidate?.broken), 'links.candidateBroken');
  requireField(Number.isSafeInteger(renderEvidence?.siteChecks?.linkDelta?.counts?.candidateOnly), 'links.candidateOnly');
  if (operator.publicationBoundary === 'cyberbaser') {
    requireField(
      cyberbaserBoundaryEvidenceComplete(renderEvidence),
      'projection.cyberbaserBoundary',
    );
  } else {
    requireField(renderEvidence?.artifactType === 'private-owner-static-output-render-evidence', 'projection.notApplicable');
    requireField(renderEvidence?.preparedSourceBinding?.snapshotsRevalidated === true, 'rendering.preparedSnapshots');
    requireField(renderEvidence?.preparedSourceBinding?.currentPinnedSourceRevalidated === true, 'rendering.currentPinnedSource');
    requireField(renderEvidence?.ownerRenderAttestation?.builtFromPreparedSnapshots === true, 'rendering.ownerSnapshotAttestation');
    requireField(renderEvidence?.ownerRenderAttestation?.builtInIsolatedWorkspaces === true, 'rendering.ownerIsolationAttestation');
  }
  return missing;
}

export function buildPilotOwnerEvidence({ submission, operator, evaluation, status, renderEvidence = null }) {
  if (!evaluation || evaluation.artifactType !== 'private-no-write-correction-evaluation') {
    fail('invalid-evaluation', 'owner review requires a correction evaluation');
  }
  if (!status || status.artifactType !== 'private-human-correction-pilot-preparation') {
    fail('invalid-status', 'owner review requires pilot status');
  }
  const rendered = compactRenderEvidence(renderEvidence);
  const contractMissing = renderEvidence
    ? reviewCardContractMissing({ operator, evaluation, renderEvidence })
    : ['rendering'];
  return deepFreeze({
    schemaVersion: 1,
    artifactType: rendered
      ? 'private-human-correction-pilot-rendered-owner-review'
      : 'private-human-correction-pilot-owner-review',
    attempt: {
      attemptId: status.attemptId,
      profile: status.profile,
      countsTowardPilot: status.countsTowardPilot,
      evidenceClass: status.evidenceClass,
      countsTowardHumanPilot: status.countsTowardHumanPilot,
      independentOwnerEvidence: status.independentOwnerEvidence,
      claimBoundary: status.claimBoundary,
      readerUnaided: operator.readerUnaided,
      accessInterruption: operator.accessInterruption,
      independentOwnerAttested: operator.independentOwnerAttested,
      openedAt: submission.openedAt,
      submittedAt: submission.submittedAt,
      elapsedMs: submission.elapsedMs,
    },
    status: {
      ownerDecision: 'pending-human-owner',
      ownerDecisionEligible: status.ownerDecisionEligible,
      blockingReasons: [...status.blockingReasons],
      noSourceWriteOccurred: true,
      noPublicDeploymentOccurred: true,
    },
    mapping: {
      repository: operator.repository,
      checkoutDir: operator.checkoutDir,
      sourcePath: operator.sourcePath,
      publicUrl: operator.publicUrl,
      baseCommit: operator.baseCommit,
      sourceAuthorizedForLocalProcessing: operator.sourceAuthorizedForLocalProcessing,
      publicationBoundary: operator.publicationBoundary,
      rendererProfile: operator.renderer.profile,
      rendererBuildCommand: operator.renderer.buildCommand,
    },
    participantContext: {
      rationale: submission.rationale,
      factualSource: submission.factualSource,
      publicCreditName: submission.publicCreditName,
      creditConsent: submission.creditConsent,
      creditAffectsTrust: false,
    },
    exactChange: {
      prefix: evaluation.case.prefix ?? '',
      quote: evaluation.case.quote,
      suffix: evaluation.case.suffix ?? '',
      replacement: evaluation.case.replacement,
      deletion: evaluation.case.replacement.length === 0,
      correctionKind: operator.correctionKind,
    },
    sourceBinding: {
      mechanicalCaseId: evaluation.caseId,
      baseByteLength: evaluation.base.byteLength,
      baseDigest: evaluation.base.digest,
      candidateByteLength: evaluation.candidate.byteLength,
      candidateDigest: evaluation.candidate.digest,
      halfOpenByteRange: [evaluation.anchor.start, evaluation.anchor.end],
      expectedOldBytesVerified: evaluation.anchor.expectedOldBytesVerified,
      quoteResolvedExactlyOnce: evaluation.anchor.resolvedExactlyOnce,
    },
    anchorStatus: {
      quoteOccurrencesWithoutContext: evaluation.anchor.quoteOccurrencesWithoutContext,
      contextRequired: evaluation.anchor.contextRequired,
      prefix: evaluation.anchor.selector.prefix ?? '',
      suffix: evaluation.anchor.selector.suffix ?? '',
      finalSelectorResolvedExactlyOnce: evaluation.anchor.resolvedExactlyOnce,
    },
    byteProof: {
      prefixBytesPreserved: evaluation.splice.prefixBytesPreserved,
      suffixBytesPreserved: evaluation.splice.suffixBytesPreserved,
      prefixIdentical: evaluation.splice.prefixIdentical,
      suffixIdentical: evaluation.splice.suffixIdentical,
      exactlyOneFile: evaluation.splice.exactlyOneFile,
      exactlyOneSplice: evaluation.splice.exactlyOneSplice,
    },
    ofm: clonePlain(evaluation.ofm),
    trust: {
      policyRevision: evaluation.trust.policyRevision,
      authorType: evaluation.trust.authorType,
      tier: evaluation.trust.tier,
      route: evaluation.trust.route,
      reasons: [...evaluation.trust.reasons],
      checks: clonePlain(evaluation.trust.checks),
      informationalOnly: true,
    },
    rendering: rendered ?? {
      status: 'not-run',
      requiredBeforeOwnerDecision: true,
      rendererProfile: operator.renderer.profile,
      basePath: operator.renderer.basePath,
      ownerRecordedBuildCommand: operator.renderer.buildCommand,
    },
    reviewCardContract: {
      complete: contractMissing.length === 0,
      missing: contractMissing,
    },
    noWrite: clonePlain(status.noWrite),
  });
}

function row(label, value) {
  return `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderSection(evidence) {
  if (evidence.rendering.status === 'not-run') {
    return `<section class="section"><h2>Rendering and links</h2><p class="blocked">Not run. Full render evidence is required before an owner decision is eligible.</p><dl>${row('Renderer profile', evidence.rendering.rendererProfile)}${row('Base path', evidence.rendering.basePath)}${row('Owner-recorded command', evidence.rendering.ownerRecordedBuildCommand)}</dl></section>`;
  }
  const target = evidence.rendering.renderedTarget;
  const checks = evidence.rendering.siteChecks;
  const delta = checks.linkDelta;
  const rendererProfile = evidence.rendering.ownerRecordedRendererProfile
    ?? evidence.rendering.renderer?.candidate?.renderer
    ?? 'recorded in operator mapping';
  const buildCommand = evidence.rendering.ownerRecordedBuildCommand
    ?? evidence.mapping.rendererBuildCommand;
  return `<section class="section"><h2>Rendered baseline and candidate</h2><dl>${row('Render mode', evidence.rendering.mode)}${row('Renderer profile / version', rendererProfile)}${row('Recorded build command', buildCommand)}${row('Rendered page', target.baseline.page)}${row('Baseline observed passage', target.baseline.observedExactText)}${row('Candidate observed passage', target.candidate.observedExactText === '' ? '(deleted)' : (target.candidate.observedExactText ?? '(missing)'))}${row('Baseline output bytes / SHA-256', `${target.baseline.byteLength} / ${target.baseline.sha256}`)}${row('Candidate output bytes / SHA-256', `${target.candidate.byteLength} / ${target.candidate.sha256}`)}${row('Baseline old / replacement', `${target.baseline.quoteOccurrences} / ${target.baseline.replacementOccurrences}`)}${row('Candidate old / replacement', `${target.candidate.quoteOccurrences} / ${target.candidate.replacementOccurrences}`)}${row('Baseline broken links', checks.baseline.broken)}${row('Candidate broken links', checks.candidate.broken)}${row('Candidate-only broken links', delta.counts.candidateOnly)}</dl></section>`;
}

function publicationSection(evidence) {
  if (evidence.mapping.publicationBoundary === 'not-applicable') {
    return `<section class="section"><h2>Publication boundary</h2><dl>${row('Status', 'not applicable; independent owner did not adopt Cyberbaser projection')}</dl></section>`;
  }
  const baseline = evidence.rendering.projection?.baseline;
  const candidate = evidence.rendering.projection?.candidate;
  return `<section class="section"><h2>Publication boundary</h2><dl>${row('Boundary', evidence.mapping.publicationBoundary)}${row('Baseline selection', JSON.stringify(baseline?.selection ?? null))}${row('Baseline projection / verification', JSON.stringify(baseline?.projection ?? null))}${row('Candidate selection', JSON.stringify(candidate?.selection ?? null))}${row('Candidate projection / verification', JSON.stringify(candidate?.projection ?? null))}</dl></section>`;
}

export function renderPilotOwnerReviewHtml(input) {
  const evidence = buildPilotOwnerEvidence(input);
  const exact = evidence.exactChange;
  const before = `${exact.prefix}${exact.quote}${exact.suffix}`;
  const after = `${exact.prefix}${exact.replacement}${exact.suffix}`;
  const blockers = evidence.status.blockingReasons.length === 0
    ? 'none'
    : evidence.status.blockingReasons.join(', ');
  const credit = evidence.participantContext.creditConsent === 'yes'
    ? evidence.participantContext.publicCreditName
    : `${evidence.participantContext.publicCreditName || '(none)'} (no public consent)`;
  const title = `${evidence.attempt.attemptId} owner review`;
  const artifactNotice = evidence.attempt.evidenceClass === 'owner-self-dogfood'
    ? 'Owner self-dogfood artifact. This is private maintainer operational evidence, not independent human validation, a product console, or an automatic source writer.'
    : 'Private concierge study artifact. This is not a product console, public pilot result, or automatic source writer.';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#111827;color:#e5e7eb}body{margin:0;padding:1.25rem}.card{max-width:960px;margin:auto;border:1px solid #475569;border-radius:14px;overflow:hidden;background:#0f172a}.head,.section,.notice,.footer{padding:1rem 1.25rem}.head{display:flex;justify-content:space-between;gap:1rem;background:#1e293b}.badge,.blocked{color:#fbbf24;font-weight:700}.notice{background:#3f2d0b;color:#fde68a}.section{border-top:1px solid #334155}h1,h2,p,dl{margin:.2rem 0 .8rem}h1{font-size:1.2rem}h2{font-size:1rem;color:#cbd5e1}.diff{font-family:ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;padding:.75rem;margin:.5rem 0}.old{background:#451a1a;color:#fecaca}.new{background:#052e16;color:#bbf7d0}.row{display:grid;grid-template-columns:minmax(12rem,1fr) minmax(0,2fr);gap:.75rem;padding:.35rem 0}.row>*{margin:0;min-width:0;overflow-wrap:anywhere}dt{color:#94a3b8}dd{font-family:ui-monospace,SFMono-Regular,monospace}.footer{border-top:1px solid #334155;color:#fca5a5;font-weight:700}@media(max-width:640px){body{padding:.65rem}.row{grid-template-columns:1fr}.head{display:block}}
</style>
</head>
<body>
<main class="card">
<header class="head"><h1>${escapeHtml(title)}</h1><span class="badge">pending human owner</span></header>
<div class="notice">${escapeHtml(artifactNotice)}</div>
<section class="section"><h2>Attempt and eligibility</h2><dl>${row('Attempt opened', evidence.attempt.openedAt)}${row('Profile', evidence.attempt.profile)}${row('Evidence class', evidence.attempt.evidenceClass)}${row('Counts toward human pilot', evidence.attempt.countsTowardHumanPilot)}${row('Independent owner evidence', evidence.attempt.independentOwnerEvidence)}${row('Claim boundary', evidence.attempt.claimBoundary)}${row('Counts toward pilot', evidence.attempt.countsTowardPilot)}${row('Reader unaided', evidence.attempt.readerUnaided)}${row('Elapsed milliseconds', evidence.attempt.elapsedMs)}${row('Review-card contract complete', evidence.reviewCardContract.complete)}${row('Missing contract evidence', evidence.reviewCardContract.missing.join(', ') || 'none')}${row('Owner decision eligible', evidence.status.ownerDecisionEligible)}${row('Blocking reasons', blockers)}</dl></section>
<section class="section"><h2>Exact proposed change</h2><div class="diff old">- ${escapeHtml(before)}</div><div class="diff new">+ ${escapeHtml(after)}</div>${row('Deletion', exact.deletion)}${row('Rationale', evidence.participantContext.rationale)}${row('Factual source', evidence.participantContext.factualSource)}${row('Credit request / consent', `${credit} / ${evidence.participantContext.creditConsent}`)}</section>
<section class="section"><h2>Owner-confirmed mapping and source binding</h2><dl>${row('Public page', evidence.mapping.publicUrl)}${row('Repository', evidence.mapping.repository)}${row('Checkout', evidence.mapping.checkoutDir)}${row('Source path', evidence.mapping.sourcePath)}${row('Base commit', evidence.mapping.baseCommit)}${row('Mechanical case ID', evidence.sourceBinding.mechanicalCaseId)}${row('Byte range', `[${evidence.sourceBinding.halfOpenByteRange.join(', ')})`)}${row('Base bytes / digest', `${evidence.sourceBinding.baseByteLength} / ${evidence.sourceBinding.baseDigest}`)}${row('Candidate bytes / digest', `${evidence.sourceBinding.candidateByteLength} / ${evidence.sourceBinding.candidateDigest}`)}${row('Expected old bytes verified', evidence.sourceBinding.expectedOldBytesVerified)}${row('Quote occurrences without context', evidence.anchorStatus.quoteOccurrencesWithoutContext)}${row('Context required', evidence.anchorStatus.contextRequired)}${row('Exact prefix / suffix', `${JSON.stringify(evidence.anchorStatus.prefix)} / ${JSON.stringify(evidence.anchorStatus.suffix)}`)}${row('Final selector resolved once', evidence.anchorStatus.finalSelectorResolvedExactlyOnce)}</dl></section>
<section class="section"><h2>Mechanical checks</h2><dl>${row('Outside-splice bytes', evidence.byteProof.prefixIdentical && evidence.byteProof.suffixIdentical ? 'identical' : 'not identical')}${row('Bytes preserved before / after', `${evidence.byteProof.prefixBytesPreserved} / ${evidence.byteProof.suffixBytesPreserved}`)}${row('OFM verdict', evidence.ofm.verdict)}${row('OFM findings', JSON.stringify(evidence.ofm.findings))}${row('OFM churn', evidence.ofm.stats.churn)}${row('OFM escapes before / after', `${evidence.ofm.stats.escapesBefore} / ${evidence.ofm.stats.escapesAfter}`)}${row('Trust route', `${evidence.trust.tier}/${evidence.trust.route} (informational only)`)}${row('Trust reasons', JSON.stringify(evidence.trust.reasons))}${row('Trust checks', JSON.stringify(evidence.trust.checks))}${row('Trust subject', evidence.trust.authorType)}${row('Policy revision', evidence.trust.policyRevision)}</dl></section>
${renderSection(evidence)}
${publicationSection(evidence)}
<footer class="footer">No source write or public deployment has occurred. The owner must either complete the bound owner-decision.json by hand or record the immutable guided decision, run pilot:decision, and apply any accepted candidate through the owner's normal local workflow.</footer>
</main>
</body>
</html>
`;
  if (/<script\b|\s(?:src|href|action)\s*=/iu.test(html)) {
    fail('active-content', 'generated owner review HTML contains active or remote-resource markup');
  }
  return html;
}

export function buildPilotOwnerReview(input) {
  const evidence = buildPilotOwnerEvidence(input);
  return deepFreeze({
    evidence,
    json: stableStringify(evidence),
    html: renderPilotOwnerReviewHtml(input),
  });
}
