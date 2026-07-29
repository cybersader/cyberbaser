import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { applyCorrection, prepareCorrection } from '@cyberbaser/correction';
import { checkSite } from '@cyberbaser/linkcheck';
import { caseId, deepFreeze, stableStringify, validateCase } from './case.js';
import { evaluateCorrection } from './evaluate.js';
import {
  assertNoSymlinks,
  candidateOnlyLinkDelta,
  captureRenderedTargetEvidence,
  inspectCheckout,
  runLiveCorrection,
} from './live-run.js';
import {
  convertPilotSubmission,
  countsTowardPilot,
  ownerDecisionTemplate,
  renderAttestationTemplate,
  validateOperator,
  validateOwnerDecision,
  validateRenderAttestation,
  validateSubmission,
} from './pilot-input.js';
import { buildPilotOwnerReview, reviewCardContractMissing } from './pilot-review-card.js';
import { buildReviewCard } from './review-card.js';
import {
  atomicWriteArtifact,
  attemptPaths,
  commitRunStaging,
  createRunStaging,
  loadAttemptJson,
  verifyAttemptWorkspace,
  writeStagedArtifact,
} from './pilot-workspace.js';

export class PilotRunError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PilotRunError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PilotRunError(code, message, details);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function preparationStatus({ attemptId, operator, evaluation }) {
  const ofmClean = evaluation.ofm.verdict === 'clean';
  const publicationReady = operator.publicationBoundary === 'not-applicable';
  const blockingReasons = ['render-evidence-required'];
  if (evaluation.ofm.verdict === 'suspect') blockingReasons.unshift('ofm-suspect-blocks-owner-decision');
  if (evaluation.ofm.verdict === 'damage') blockingReasons.unshift('ofm-damage-stops-attempt');
  return deepFreeze({
    schemaVersion: 1,
    artifactType: 'private-human-correction-pilot-preparation',
    attemptId,
    mechanicalCaseId: evaluation.caseId,
    profile: operator.profile,
    countsTowardPilot: countsTowardPilot(operator),
    counting: {
      status: 'not-counted-by-preparation-kit',
      reason: 'human attempt and independent-owner results are recorded only after validated decision, owner-controlled application, and live verification',
    },
    gates: {
      checkout: true,
      mapping: true,
      anchor: true,
      outsideSplice: evaluation.splice.prefixIdentical && evaluation.splice.suffixIdentical,
      ofm: ofmClean,
      trust: true,
      publicationBoundary: publicationReady,
      rendering: false,
    },
    ownerDecisionEligible: false,
    blockingReasons,
    noWrite: {
      suppliedCheckoutWritePerformed: false,
      automaticSourceApplicationPerformed: false,
      publicDeploymentPerformed: false,
    },
  });
}

function renderedStatus({ operator, priorStatus, evaluation, renderEvidence }) {
  const linkDelta = renderEvidence.siteChecks.linkDelta;
  const candidateOnlyLinks = linkDelta.counts.candidateOnly;
  const publicationReady = operator.publicationBoundary === 'not-applicable'
    || renderEvidence.artifactType === 'private-local-rendered-correction-run';
  const renderingReady = candidateOnlyLinks === 0
    && Object.values(renderEvidence.renderedTarget.comparable).every(Boolean);
  const missingReviewEvidence = reviewCardContractMissing({ operator, evaluation, renderEvidence });
  const gates = {
    checkout: true,
    mapping: true,
    anchor: true,
    outsideSplice: evaluation.splice.prefixIdentical && evaluation.splice.suffixIdentical,
    ofm: evaluation.ofm.verdict === 'clean',
    trust: true,
    publicationBoundary: publicationReady,
    rendering: renderingReady,
    reviewCardContract: missingReviewEvidence.length === 0,
  };
  const blockingReasons = [];
  if (evaluation.ofm.verdict === 'suspect') blockingReasons.push('ofm-suspect-blocks-owner-decision');
  if (evaluation.ofm.verdict === 'damage') blockingReasons.push('ofm-damage-stops-attempt');
  if (candidateOnlyLinks > 0) blockingReasons.push('candidate-only-broken-links');
  if (!publicationReady) blockingReasons.push('publication-boundary-evidence-required');
  if (!renderingReady && candidateOnlyLinks === 0) blockingReasons.push('render-evidence-incomplete');
  if (missingReviewEvidence.length > 0) blockingReasons.push('review-card-contract-incomplete');
  return deepFreeze({
    ...clonePlain(priorStatus),
    gates,
    reviewCardContract: { complete: missingReviewEvidence.length === 0, missing: missingReviewEvidence },
    ownerDecisionEligible: Object.values(gates).every(Boolean),
    blockingReasons,
  });
}

async function loadValidatedAttempt(paths) {
  await verifyAttemptWorkspace(paths);
  const submission = validateSubmission(await loadAttemptJson(paths.submission, 'submission', paths));
  const operator = validateOperator(await loadAttemptJson(paths.operator, 'operator', paths));
  if (submission.attemptId !== paths.attemptId || operator.attemptId !== paths.attemptId) {
    fail('attempt-id-mismatch', 'attempt files must match the requested attempt ID');
  }
  return { submission, operator };
}

async function inspectBeforeAndAfter({ operator, action, inspector = inspectCheckout }) {
  const before = await inspector({
    checkoutDir: operator.checkoutDir,
    pinnedCommit: operator.baseCommit,
    repository: operator.repository,
    sourcePath: operator.sourcePath,
  });
  let result;
  let primaryError = null;
  let finalError = null;
  try {
    result = await action(before);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await inspector({
        checkoutDir: operator.checkoutDir,
        pinnedCommit: operator.baseCommit,
        repository: operator.repository,
        sourcePath: operator.sourcePath,
      });
    } catch (error) {
      finalError = error;
    }
  }
  if (finalError) throw finalError;
  if (primaryError) throw primaryError;
  return result;
}

function selectorFromCase(value) {
  return {
    quote: value.quote,
    ...(Object.hasOwn(value, 'prefix') ? { prefix: value.prefix } : {}),
    ...(Object.hasOwn(value, 'suffix') ? { suffix: value.suffix } : {}),
  };
}

async function prepareSourceSnapshots({ caseData, operator, evaluation }) {
  const sourceFile = path.join(operator.checkoutDir, ...operator.sourcePath.split('/'));
  const baselineBytes = await readFile(sourceFile);
  const correction = prepareCorrection(baselineBytes, {
    selector: selectorFromCase(caseData),
    replacement: caseData.replacement,
  });
  const candidateBytes = applyCorrection(baselineBytes, correction);
  if (correction.baseDigest !== evaluation.base.digest
    || correction.candidateDigest !== evaluation.candidate.digest) {
    fail('snapshot-digest-mismatch', 'prepared source snapshots do not match the revalidated evaluation');
  }
  return { baselineBytes, candidateBytes };
}

function assertStableEqual(actual, expected, code, message) {
  if (stableStringify(actual) !== stableStringify(expected)) fail(code, message);
}

export async function preparePilotAttempt({
  attemptId,
  projectRoot,
  workspaceRoot,
} = {}) {
  const paths = attemptPaths(attemptId, { projectRoot, workspaceRoot });
  const { submission, operator } = await loadValidatedAttempt(paths);
  const caseData = convertPilotSubmission(submission, operator);
  const mechanicalCaseId = caseId(caseData);

  const evaluation = await inspectBeforeAndAfter({
    operator,
    action: (checkout) => evaluateCorrection({
      caseData,
      checkoutDir: checkout.root,
      ownerPolicy: operator.ownerPolicy,
      policyRevision: operator.ownerPolicyRevision,
      trustSubject: { authorType: 'anonymous', author: '' },
    }),
  });
  if (evaluation.caseId !== mechanicalCaseId) fail('mechanical-case-id-mismatch', 'deterministic case ID changed during preparation');
  if (evaluation.trust.authorType !== 'anonymous') {
    fail('trust-subject-not-anonymous', 'pilot trust classification must remain anonymous');
  }

  const mechanicalReview = buildReviewCard(evaluation);
  if (submission.creditConsent === 'no'
    && submission.publicCreditName.length > 0
    && mechanicalReview.json.includes(submission.publicCreditName)) {
    fail('unconsented-credit-in-public-artifact', 'public-safe mechanical evidence contains an unconsented credit name');
  }
  const status = preparationStatus({ attemptId: paths.attemptId, operator, evaluation });
  const ownerReview = evaluation.ofm.verdict === 'damage'
    ? null
    : buildPilotOwnerReview({ submission, operator, evaluation, status });
  const snapshots = await prepareSourceSnapshots({ caseData, operator, evaluation });
  const renderAttestation = renderAttestationTemplate({
    attemptId: paths.attemptId,
    mechanicalCaseId,
    baselineSourceDigest: evaluation.base.digest,
    candidateSourceDigest: evaluation.candidate.digest,
    renderer: operator.renderer,
  });
  const boundOwnerDecision = ownerDecisionTemplate(paths.attemptId, {
    mechanicalCaseId,
    candidateDigest: evaluation.candidate.digest,
  });

  const staging = await createRunStaging(paths, mechanicalCaseId);
  try {
    await writeStagedArtifact(staging, 'case.json', stableStringify(caseData), paths);
    await writeStagedArtifact(staging, 'evaluation.json', stableStringify(evaluation), paths);
    await writeStagedArtifact(staging, 'baseline-source.md', snapshots.baselineBytes.toString('utf8'), paths);
    await writeStagedArtifact(staging, 'candidate-source.md', snapshots.candidateBytes.toString('utf8'), paths);
    await writeStagedArtifact(staging, 'render-attestation.json', stableStringify(renderAttestation), paths);
    await writeStagedArtifact(staging, 'owner-decision-template.json', stableStringify(boundOwnerDecision), paths);
    await writeStagedArtifact(staging, 'mechanical-review.json', mechanicalReview.json, paths);
    if (ownerReview) await writeStagedArtifact(staging, 'owner-review.html', ownerReview.html, paths);
    await writeStagedArtifact(staging, 'status.json', stableStringify(status), paths);
    const runDir = await commitRunStaging(paths, mechanicalCaseId, staging);
    await atomicWriteArtifact(paths.ownerDecision, stableStringify(boundOwnerDecision), paths);
    return deepFreeze({
      attemptId: paths.attemptId,
      mechanicalCaseId,
      runDir,
      countsTowardPilot: status.countsTowardPilot,
      ownerDecisionEligible: false,
      blockingReasons: [...status.blockingReasons],
      ownerCardCreated: Boolean(ownerReview),
    });
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function revalidatePreparedRun({ paths, submission, operator, caseData, mechanicalCaseId, requirePreparationStatus = true }) {
  const runDir = path.join(paths.runs, mechanicalCaseId);
  let storedCase;
  let storedEvaluation;
  let storedStatus;
  try {
    [storedCase, storedEvaluation, storedStatus] = await Promise.all([
      loadAttemptJson(path.join(runDir, 'case.json'), 'prepared-case', paths),
      loadAttemptJson(path.join(runDir, 'evaluation.json'), 'prepared-evaluation', paths),
      loadAttemptJson(path.join(runDir, 'status.json'), 'prepared-status', paths),
    ]);
  } catch (error) {
    if (error?.code) throw error;
    fail('prepared-run-unavailable', 'the prepared run artifacts could not be loaded');
  }
  assertStableEqual(storedCase, caseData, 'prepared-case-mismatch', 'stored case does not match the current submission and owner mapping');
  const freshEvaluation = await inspectBeforeAndAfter({
    operator,
    action: (checkout) => evaluateCorrection({
      caseData,
      checkoutDir: checkout.root,
      ownerPolicy: operator.ownerPolicy,
      policyRevision: operator.ownerPolicyRevision,
      trustSubject: { authorType: 'anonymous', author: '' },
    }),
  });
  assertStableEqual(storedEvaluation, freshEvaluation, 'prepared-evaluation-mismatch', 'stored mechanical evidence does not match a fresh evaluation of the pinned source bytes');
  if (freshEvaluation.caseId !== mechanicalCaseId || storedStatus.mechanicalCaseId !== mechanicalCaseId) {
    fail('prepared-run-mismatch', 'prepared run does not match the current submission and owner mapping');
  }
  if (requirePreparationStatus) {
    const expectedStatus = preparationStatus({ attemptId: paths.attemptId, operator, evaluation: freshEvaluation });
    assertStableEqual(storedStatus, expectedStatus, 'prepared-status-mismatch', 'stored preparation status has been altered or is not the initial preparation status');
  }
  const snapshots = await prepareSourceSnapshots({ caseData, operator, evaluation: freshEvaluation });
  const [storedBaseline, storedCandidate] = await Promise.all([
    readFile(path.join(runDir, 'baseline-source.md')),
    readFile(path.join(runDir, 'candidate-source.md')),
  ]);
  if (!storedBaseline.equals(snapshots.baselineBytes) || !storedCandidate.equals(snapshots.candidateBytes)) {
    fail('prepared-snapshot-mismatch', 'stored baseline or candidate source snapshot does not match the current prepared bytes');
  }
  return { runDir, evaluation: freshEvaluation, status: storedStatus };
}

async function requireDirectory(target, label) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    fail(`invalid-${label}`, `${label} must be an absolute static-output directory`);
  }
  let resolved;
  try {
    resolved = await realpath(target);
    if (!(await stat(resolved)).isDirectory()) fail(`invalid-${label}`, `${label} must be a directory`);
  } catch (error) {
    if (error instanceof PilotRunError) throw error;
    fail(`invalid-${label}`, `${label} must identify a readable directory`);
  }
  await assertNoSymlinks(resolved);
  return resolved;
}

async function verifyStaticOutputs({ caseData, operator, evaluation, attestation, baselineSite, candidateSite }, dependencies = {}) {
  const inspect = dependencies.inspectCheckout ?? inspectCheckout;
  const siteCheck = dependencies.checkSite ?? checkSite;
  const captureTarget = dependencies.captureRenderedTargetEvidence ?? captureRenderedTargetEvidence;
  const baselineSiteDir = await requireDirectory(baselineSite, 'baseline-site');
  const candidateSiteDir = await requireDirectory(candidateSite, 'candidate-site');
  if (path.resolve(attestation.baselineSiteDir) !== path.resolve(baselineSite)
    || path.resolve(attestation.candidateSiteDir) !== path.resolve(candidateSite)) {
    fail('render-attestation-output-mismatch', 'static-output paths must exactly match the owner render attestation');
  }
  return inspectBeforeAndAfter({
    operator,
    inspector: inspect,
    action: async () => {
      const [baselineCheck, candidateCheck, renderedTarget] = await Promise.all([
        siteCheck(baselineSiteDir, { basePath: operator.renderer.basePath }),
        siteCheck(candidateSiteDir, { basePath: operator.renderer.basePath }),
        captureTarget({
          baselineSiteDir,
          candidateSiteDir,
          caseData,
          basePath: operator.renderer.basePath,
        }),
      ]);
      return deepFreeze({
        schemaVersion: 1,
        artifactType: 'private-owner-static-output-render-evidence',
        mode: 'owner-built-static-output-verification',
        arbitraryOwnerCommandExecuted: false,
        ownerRecordedRendererProfile: operator.renderer.profile,
        ownerRecordedBuildCommand: operator.renderer.buildCommand,
        ownerRenderAttestation: clonePlain(attestation),
        preparedSourceBinding: {
          baselineDigest: evaluation.base.digest,
          candidateDigest: evaluation.candidate.digest,
          snapshotsRevalidated: true,
          currentPinnedSourceRevalidated: true,
        },
        baselineSiteDir,
        candidateSiteDir,
        siteChecks: {
          baseline: {
            total: baselineCheck.total,
            ok: baselineCheck.ok,
            broken: baselineCheck.broken.length,
            byClass: clonePlain(baselineCheck.byClass),
          },
          candidate: {
            total: candidateCheck.total,
            ok: candidateCheck.ok,
            broken: candidateCheck.broken.length,
            byClass: clonePlain(candidateCheck.byClass),
          },
          linkDelta: candidateOnlyLinkDelta(baselineCheck, candidateCheck),
        },
        renderedTarget,
        sourceCheckout: {
          repository: operator.repository,
          baseCommit: operator.baseCommit,
          cleanBefore: true,
          cleanAfter: true,
          suppliedCheckoutWritePerformed: false,
        },
        publicationBoundary: operator.publicationBoundary === 'not-applicable'
          ? { status: 'not-applicable' }
          : { status: 'not-verified-by-static-output-mode' },
        cleanup: { completed: true, temporaryWorkspacesRetained: false },
      });
    },
  });
}

async function runCyberbaseLiveLane({ caseData, operator }, dependencies = {}) {
  const runCyberbaseLive = dependencies.runLiveCorrection ?? runLiveCorrection;
  return runCyberbaseLive({
    caseData,
    checkoutDir: operator.checkoutDir,
    pinnedCommit: operator.baseCommit,
    ownerPolicy: operator.ownerPolicy,
    policyRevision: operator.ownerPolicyRevision,
    trustSubject: { authorType: 'anonymous', author: '' },
    basePath: operator.renderer.basePath,
  });
}

function cyberbaseDecisionSafetyEvidence(renderEvidence) {
  const linkDelta = renderEvidence.siteChecks.linkDelta;
  const target = renderEvidence.renderedTarget;
  return deepFreeze({
    schemaVersion: renderEvidence.schemaVersion,
    artifactType: renderEvidence.artifactType,
    case: clonePlain(renderEvidence.case),
    evaluation: clonePlain(renderEvidence.evaluation),
    projection: clonePlain(renderEvidence.projection),
    renderer: {
      baseline: {
        renderer: renderEvidence.renderer.baseline.renderer,
        pin: renderEvidence.renderer.baseline.pin,
      },
      candidate: {
        renderer: renderEvidence.renderer.candidate.renderer,
        pin: renderEvidence.renderer.candidate.pin,
      },
      isolatedWorkspaces: renderEvidence.renderer.isolatedWorkspaces,
      publicDeploymentPerformed: renderEvidence.renderer.publicDeploymentPerformed,
    },
    linkSafety: {
      tuple: clonePlain(linkDelta.tuple),
      candidateOnly: clonePlain(linkDelta.candidateOnly),
      baselineOnly: clonePlain(linkDelta.baselineOnly),
      unchanged: linkDelta.unchanged,
      counts: clonePlain(linkDelta.counts),
    },
    renderedTargetSafety: {
      basePath: target.basePath,
      baseline: {
        page: target.baseline.page,
        oldTextPresent: target.baseline.quoteOccurrences >= 1,
        replacementTextAbsent: target.baseline.replacementOccurrences === 0,
        observedExactText: target.baseline.observedExactText,
      },
      candidate: {
        page: target.candidate.page,
        oldTextAbsent: target.candidate.quoteOccurrences === 0,
        replacementSatisfied: target.comparable.candidateReplacementSatisfied,
        observedExactText: target.candidate.observedExactText,
      },
      comparable: clonePlain(target.comparable),
    },
    sourceCheckout: clonePlain(renderEvidence.sourceCheckout),
    temporaryCopies: clonePlain(renderEvidence.temporaryCopies),
    noWrite: clonePlain(renderEvidence.noWrite),
    cleanup: clonePlain(renderEvidence.cleanup),
  });
}

export async function renderPilotAttempt({
  attemptId,
  baselineSite,
  candidateSite,
  projectRoot,
  workspaceRoot,
} = {}, dependencyOverrides = {}) {
  const paths = attemptPaths(attemptId, { projectRoot, workspaceRoot });
  const { submission, operator } = await loadValidatedAttempt(paths);
  const caseData = convertPilotSubmission(submission, operator);
  const mechanicalCaseId = caseId(caseData);
  validateCase(caseData);
  const preparedRun = await revalidatePreparedRun({
    paths,
    submission,
    operator,
    caseData,
    mechanicalCaseId,
  });
  const { runDir, evaluation, status: priorStatus } = preparedRun;

  let renderEvidence;
  if (operator.renderer.profile === 'cyberbase-quartz-v4.5.2') {
    if (baselineSite !== undefined || candidateSite !== undefined) {
      fail('unexpected-static-output', 'Cyberbase rehearsal mode reuses the pinned live lane and accepts no static-output paths');
    }
    renderEvidence = await runCyberbaseLiveLane({ caseData, operator }, dependencyOverrides);
  } else {
    if (!baselineSite || !candidateSite) {
      fail('static-output-paths-required', 'independent rendering requires baseline-site and candidate-site');
    }
    const attestation = validateRenderAttestation(
      await loadAttemptJson(path.join(runDir, 'render-attestation.json'), 'render-attestation', paths),
    );
    if (attestation.attemptId !== paths.attemptId
      || attestation.mechanicalCaseId !== mechanicalCaseId
      || attestation.baselineSourceDigest !== evaluation.base.digest
      || attestation.candidateSourceDigest !== evaluation.candidate.digest
      || attestation.rendererProfile !== operator.renderer.profile
      || attestation.buildCommand !== operator.renderer.buildCommand) {
      fail('render-attestation-binding-mismatch', 'render attestation does not match the prepared run and recorded renderer contract');
    }
    renderEvidence = await verifyStaticOutputs(
      { caseData, operator, evaluation, attestation, baselineSite, candidateSite },
      dependencyOverrides,
    );
  }

  if (renderEvidence.artifactType === 'private-local-rendered-correction-run') {
    assertStableEqual(
      renderEvidence.evaluation,
      evaluation,
      'live-render-evaluation-mismatch',
      'live render evidence does not match the freshly revalidated prepared evaluation',
    );
  }

  const status = renderedStatus({ operator, priorStatus, evaluation, renderEvidence });
  const ownerReview = buildPilotOwnerReview({
    submission,
    operator,
    evaluation,
    status,
    renderEvidence,
  });
  await atomicWriteArtifact(path.join(runDir, 'render-evidence.json'), stableStringify(renderEvidence), paths);
  await atomicWriteArtifact(path.join(runDir, 'owner-rendered-review.html'), ownerReview.html, paths);
  await atomicWriteArtifact(path.join(runDir, 'status.json'), stableStringify(status), paths);

  return deepFreeze({
    attemptId: paths.attemptId,
    mechanicalCaseId,
    runDir,
    countsTowardPilot: status.countsTowardPilot,
    ownerDecisionEligible: status.ownerDecisionEligible,
    blockingReasons: [...status.blockingReasons],
    arbitraryOwnerCommandExecuted: false,
  });
}

export async function validatePilotOwnerDecision({
  attemptId,
  projectRoot,
  workspaceRoot,
} = {}, dependencyOverrides = {}) {
  const paths = attemptPaths(attemptId, { projectRoot, workspaceRoot });
  const { submission, operator } = await loadValidatedAttempt(paths);
  const caseData = convertPilotSubmission(submission, operator);
  const mechanicalCaseId = caseId(caseData);
  const preparedRun = await revalidatePreparedRun({
    paths,
    submission,
    operator,
    caseData,
    mechanicalCaseId,
    requirePreparationStatus: false,
  });
  const renderEvidence = await loadAttemptJson(
    path.join(preparedRun.runDir, 'render-evidence.json'),
    'render-evidence',
    paths,
  );
  let freshRenderEvidence;
  if (operator.renderer.profile === 'owner-static-output') {
    const attestation = validateRenderAttestation(
      await loadAttemptJson(path.join(preparedRun.runDir, 'render-attestation.json'), 'render-attestation', paths),
    );
    freshRenderEvidence = await verifyStaticOutputs({
      caseData,
      operator,
      evaluation: preparedRun.evaluation,
      attestation,
      baselineSite: attestation.baselineSiteDir,
      candidateSite: attestation.candidateSiteDir,
    });
    assertStableEqual(
      renderEvidence,
      freshRenderEvidence,
      'render-evidence-mismatch',
      'stored render evidence does not match a fresh verification of the attested static outputs',
    );
  } else {
    freshRenderEvidence = await runCyberbaseLiveLane({ caseData, operator }, dependencyOverrides);
    assertStableEqual(
      freshRenderEvidence.evaluation,
      preparedRun.evaluation,
      'live-render-evaluation-mismatch',
      'fresh live render evidence does not match the freshly revalidated prepared evaluation',
    );
    assertStableEqual(
      cyberbaseDecisionSafetyEvidence(renderEvidence),
      cyberbaseDecisionSafetyEvidence(freshRenderEvidence),
      'render-evidence-mismatch',
      'stored live render safety evidence does not match a fresh run of the isolated Cyberbase live lane',
    );
  }
  const initialStatus = preparationStatus({ attemptId: paths.attemptId, operator, evaluation: preparedRun.evaluation });
  const expectedStatus = renderedStatus({
    operator,
    priorStatus: initialStatus,
    evaluation: preparedRun.evaluation,
    renderEvidence: freshRenderEvidence,
  });
  assertStableEqual(
    preparedRun.status,
    expectedStatus,
    'rendered-status-mismatch',
    'stored rendered status does not match the prepared evaluation and render evidence',
  );
  if (!expectedStatus.ownerDecisionEligible) {
    fail('owner-decision-not-eligible', 'owner decision cannot be validated until every review gate is eligible', {
      blockingReasons: expectedStatus.blockingReasons,
    });
  }
  const decision = validateOwnerDecision(
    await loadAttemptJson(paths.ownerDecision, 'owner-decision', paths),
  );
  if (decision.attemptId !== paths.attemptId
    || decision.mechanicalCaseId !== mechanicalCaseId
    || decision.candidateDigest !== preparedRun.evaluation.candidate.digest) {
    fail('owner-decision-binding-mismatch', 'owner decision does not match the eligible attempt, mechanical case, and candidate digest');
  }
  const validated = deepFreeze({
    schemaVersion: 1,
    artifactType: 'private-validated-human-owner-decision',
    ...clonePlain(decision),
    ownerDecisionEligibleAtValidation: true,
    sourceWritePerformed: false,
    countsTowardPilot: false,
  });
  await atomicWriteArtifact(
    path.join(preparedRun.runDir, 'validated-owner-decision.json'),
    stableStringify(validated),
    paths,
  );
  return validated;
}
