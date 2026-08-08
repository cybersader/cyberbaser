import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { caseId, stableStringify } from './case.js';
import { inspectCheckout, inspectPinnedPublicationPolicy } from './live-run.js';
import {
  parseExpiresMinutes,
  prepareDogfoodReaderServer,
  loadDogfoodReaderSnapshot,
  readerServerDisplayUrls,
} from './dogfood-reader-server.js';
import {
  convertPilotSubmission,
  evidenceClassification,
  isSupersededOwnerDogfoodAttempt,
  ownerDecisionTemplate,
  validateDogfoodObservationSeriesBinding,
  validateOperator,
  validateOwnerDecision,
  validateSubmission,
} from './pilot-input.js';
import {
  atomicCreateArtifact,
  attemptPaths,
  deriveCheckoutHead,
  initializeAttempt,
  loadAttemptJson,
  loadAttemptOperator,
  loadOwnerDogfoodSeries,
  recordPilotError,
  verifyAttemptWorkspace,
  withAttemptBindingLock,
} from './pilot-workspace.js';
import { cyberbaserBoundaryEvidenceComplete } from './pilot-review-card.js';
import {
  preparePilotAttempt,
  repinOwnerDogfoodAttempt,
  renderPilotAttempt,
  validatePilotOwnerDecision,
} from './pilot-run.js';

const STAGE_LABELS = Object.freeze({
  'not-initialized': 'not initialized',
  superseded: 'Not run — superseded',
  'awaiting-submission': 'awaiting reader submission',
  submitted: 'submission ready to prepare',
  prepared: 'prepared; rendering required',
  blocked: 'blocked; inspect the recorded reason',
  'awaiting-decision': 'rendered; awaiting owner decision',
  'decision-recorded': 'owner decision recorded; validation required',
  'decision-validated': 'owner decision validated',
});

const ACTIONABLE_STAGES = new Set([
  'not-initialized',
  'awaiting-submission',
  'submitted',
  'prepared',
  'awaiting-decision',
  'decision-recorded',
]);

export class DogfoodWizardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DogfoodWizardError';
    this.code = code;
    this.details = details;
  }
}

export class DogfoodWizardCancelled extends Error {
  constructor() {
    super('dogfood wizard cancelled');
    this.name = 'DogfoodWizardCancelled';
    this.code = 'dogfood-wizard-cancelled';
  }
}

function fail(code, message, details) {
  throw new DogfoodWizardError(code, message, details);
}

function plainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`invalid-${label}`, `${label} must be a plain object`);
  }
  return value;
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function validateWizardStatus(statusInput, { attemptId, mechanicalCaseId }) {
  const status = plainRecord(statusInput, 'wizard-status');
  const classification = evidenceClassification('owner-self-dogfood');
  if (status.schemaVersion !== 2
    || status.artifactType !== 'private-human-correction-pilot-preparation'
    || status.attemptId !== attemptId
    || status.mechanicalCaseId !== mechanicalCaseId
    || status.profile !== 'owner-self-dogfood'
    || typeof status.ownerDecisionEligible !== 'boolean'
    || !Array.isArray(status.blockingReasons)
    || status.blockingReasons.some((reason) => typeof reason !== 'string')) {
    fail('wizard-status-mismatch', 'stored status does not match the selected owner-dogfood run');
  }
  for (const [key, expected] of Object.entries(classification)) {
    if (status[key] !== expected) {
      fail('wizard-status-classification-mismatch', 'stored status has an invalid evidence classification');
    }
  }
  if (status.noWrite?.suppliedCheckoutWritePerformed !== false
    || status.noWrite?.automaticSourceApplicationPerformed !== false
    || status.noWrite?.publicDeploymentPerformed !== false) {
    fail('wizard-status-write-conflict', 'stored status conflicts with the no-write boundary');
  }
  return status;
}

function validateDecisionTemplate(input, { attemptId, mechanicalCaseId }) {
  const value = plainRecord(input, 'owner-decision-template');
  const bindingProbe = validateOwnerDecision({
    ...value,
    decision: 'reject',
    reason: 'binding validation only',
    reviewSeconds: 0,
    decidedAt: '2000-01-01T00:00:00.000Z',
  });
  if (bindingProbe.attemptId !== attemptId || bindingProbe.mechanicalCaseId !== mechanicalCaseId) {
    fail('wizard-decision-template-mismatch', 'owner decision template does not match the current run');
  }
  const expected = ownerDecisionTemplate(attemptId, {
    mechanicalCaseId,
    candidateDigest: bindingProbe.candidateDigest,
  });
  if (stableStringify(value) !== stableStringify(expected)) {
    fail('wizard-decision-template-invalid', 'run-local owner decision template has been altered');
  }
  return Object.freeze(expected);
}

function validateRecordedDecision(input, template) {
  const decision = validateOwnerDecision(input);
  if (decision.attemptId !== template.attemptId
    || decision.mechanicalCaseId !== template.mechanicalCaseId
    || decision.candidateDigest !== template.candidateDigest) {
    fail('wizard-owner-decision-binding-mismatch', 'owner decision does not match the current run');
  }
  return decision;
}

function validateValidatedDecision(input, template) {
  const value = plainRecord(input, 'validated-owner-decision');
  if (value.artifactType !== 'private-validated-owner-self-dogfood-decision'
    || value.schemaVersion !== 2
    || value.evidenceClass !== 'owner-self-dogfood'
    || value.countsTowardHumanPilot !== false
    || value.independentOwnerEvidence !== false
    || value.ownerDecisionEligibleAtValidation !== true
    || value.sourceWritePerformed !== false
    || value.publicDeploymentPerformed !== false) {
    fail('wizard-validated-decision-invalid', 'validated owner decision has an invalid boundary or classification');
  }
  validateRecordedDecision({
    schemaVersion: 1,
    attemptId: value.attemptId,
    mechanicalCaseId: value.mechanicalCaseId,
    candidateDigest: value.candidateDigest,
    decision: value.decision,
    reason: value.reason,
    reviewSeconds: value.reviewSeconds,
    decidedAt: value.decidedAt,
  }, template);
  return value;
}

function obligationsForAttempt(series, attemptId) {
  return Object.entries(series.obligationAssignments)
    .filter(([, assigned]) => assigned === attemptId)
    .map(([obligation]) => obligation);
}

async function currentCheckoutBlockingReason(operator) {
  try {
    await inspectCheckout({
      checkoutDir: operator.checkoutDir,
      pinnedCommit: operator.baseCommit,
      repository: operator.repository,
      sourcePath: operator.sourcePath,
    });
    return null;
  } catch (error) {
    if (!error?.code) throw error;
    return error.code;
  }
}

async function pinnedPublicationBlockingReason(operator) {
  try {
    const pinnedPolicy = await inspectPinnedPublicationPolicy({
      checkoutDir: operator.checkoutDir,
      pinnedCommit: operator.baseCommit,
      repository: operator.repository,
    });
    if (operator.publicationBoundary === 'cyberbaser'
      && pinnedPolicy.publishConfigPresent !== true) {
      return 'publication-boundary-policy-missing';
    }
    return null;
  } catch (error) {
    if (!error?.code) throw error;
    return error.code;
  }
}

export async function inspectDogfoodAttempt(attemptId, series, {
  projectRoot,
  workspaceRoot,
} = {}) {
  const workspaceOptions = {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  };
  const paths = attemptPaths(attemptId, workspaceOptions);
  const base = {
    attemptId,
    obligations: obligationsForAttempt(series, attemptId),
    paths,
    stage: 'not-initialized',
    stageLabel: STAGE_LABELS['not-initialized'],
    blockingReasons: [],
  };
  if (isSupersededOwnerDogfoodAttempt(attemptId)) {
    if (await exists(paths.root)) {
      fail(
        'superseded-dogfood-attempt-artifacts-present',
        `${attemptId} is Not run — superseded but an attempt directory exists`,
      );
    }
    return Object.freeze({
      ...base,
      stage: 'superseded',
      stageLabel: STAGE_LABELS.superseded,
      blockingReasons: ['dogfood-attempt-superseded'],
    });
  }
  if (!(await exists(paths.root))) return Object.freeze(base);

  await verifyAttemptWorkspace(paths);
  await loadDogfoodReaderSnapshot(attemptId, workspaceOptions);
  const operator = await loadAttemptOperator(paths);
  const observation = validateDogfoodObservationSeriesBinding(
    await loadAttemptJson(paths.dogfoodObservation, 'dogfood-observation', paths),
    series,
  );
  if (operator.attemptId !== attemptId || observation.attemptId !== attemptId) {
    fail('wizard-attempt-binding-mismatch', 'attempt artifacts do not match the declared attempt');
  }
  if (!(await exists(paths.submission))) {
    return Object.freeze({
      ...base,
      operator,
      observation,
      stage: 'awaiting-submission',
      stageLabel: STAGE_LABELS['awaiting-submission'],
    });
  }

  const submission = validateSubmission(await loadAttemptJson(paths.submission, 'submission', paths));
  if (submission.attemptId !== attemptId) {
    fail('wizard-submission-binding-mismatch', 'submission does not match the selected attempt');
  }
  const caseData = convertPilotSubmission(submission, operator);
  const mechanicalCaseId = caseId(caseData);
  const runDir = path.join(paths.runs, mechanicalCaseId);
  const submitted = {
    ...base,
    operator,
    observation,
    submission,
    mechanicalCaseId,
    runDir,
    stage: 'submitted',
    stageLabel: STAGE_LABELS.submitted,
  };
  if (!(await exists(runDir))) {
    const policyBlock = await pinnedPublicationBlockingReason(operator);
    if (policyBlock) {
      return Object.freeze({
        ...submitted,
        stage: 'blocked',
        stageLabel: STAGE_LABELS.blocked,
        blockingReasons: [policyBlock],
        canRepin: policyBlock === 'publication-boundary-policy-missing'
          && !(await exists(paths.operatorRepin)),
      });
    }
    const checkoutBlock = await currentCheckoutBlockingReason(operator);
    if (checkoutBlock) {
      return Object.freeze({
        ...submitted,
        stage: 'blocked',
        stageLabel: STAGE_LABELS.blocked,
        blockingReasons: [checkoutBlock],
        canRepin: false,
      });
    }
    return Object.freeze(submitted);
  }

  const status = validateWizardStatus(
    await loadAttemptJson(path.join(runDir, 'status.json'), 'wizard-status', paths),
    { attemptId, mechanicalCaseId },
  );
  const template = validateDecisionTemplate(
    await loadAttemptJson(
      path.join(runDir, 'owner-decision-template.json'),
      'owner-decision-template',
      paths,
    ),
    { attemptId, mechanicalCaseId },
  );
  const currentDecision = await loadAttemptJson(paths.ownerDecision, 'owner-decision', paths);
  const blankDecision = stableStringify(currentDecision) === stableStringify(template);
  const wizardDecisionPath = path.join(runDir, 'wizard-owner-decision.json');
  const wizardDecision = await exists(wizardDecisionPath)
    ? validateRecordedDecision(
        await loadAttemptJson(wizardDecisionPath, 'wizard-owner-decision', paths),
        template,
      )
    : null;
  if (wizardDecision && !blankDecision) {
    fail(
      'wizard-owner-decision-authority-conflict',
      'wizard and canonical owner decisions conflict',
    );
  }
  const recordedDecision = wizardDecision
    ?? (blankDecision ? null : validateRecordedDecision(currentDecision, template));
  const renderEvidencePath = path.join(runDir, 'render-evidence.json');
  const reviewPath = path.join(runDir, 'owner-rendered-review.html');
  const validatedDecisionPath = path.join(runDir, 'validated-owner-decision.json');
  const hasRenderEvidence = await exists(renderEvidencePath);
  const hasValidatedDecision = await exists(validatedDecisionPath);
  if (recordedDecision && (!hasRenderEvidence || !status.ownerDecisionEligible)) {
    fail('wizard-decision-before-eligibility', 'owner decision was recorded before the run became eligible');
  }
  if (hasRenderEvidence) {
    const renderEvidence = plainRecord(
      await loadAttemptJson(renderEvidencePath, 'render-evidence', paths),
      'render-evidence',
    );
    if (!cyberbaserBoundaryEvidenceComplete(renderEvidence)) {
      fail(
        'wizard-render-evidence-invalid',
        'stored render evidence does not prove the pinned Cyberbaser publication boundary',
      );
    }
  }
  if (hasValidatedDecision) {
    validateValidatedDecision(
      await loadAttemptJson(validatedDecisionPath, 'validated-owner-decision', paths),
      template,
    );
    return Object.freeze({
      ...submitted,
      status,
      template,
      recordedDecision,
      renderEvidencePath,
      reviewPath,
      validatedDecisionPath,
      stage: 'decision-validated',
      stageLabel: STAGE_LABELS['decision-validated'],
      blockingReasons: [],
    });
  }
  const policyBlock = await pinnedPublicationBlockingReason(operator);
  if (policyBlock) {
    return Object.freeze({
      ...submitted,
      status,
      template,
      recordedDecision,
      renderEvidencePath,
      reviewPath,
      validatedDecisionPath,
      stage: 'blocked',
      stageLabel: STAGE_LABELS.blocked,
      blockingReasons: [policyBlock],
      canRepin: policyBlock === 'publication-boundary-policy-missing'
        && !(await exists(paths.operatorRepin)),
    });
  }
  const checkoutBlock = await currentCheckoutBlockingReason(operator);
  if (checkoutBlock) {
    return Object.freeze({
      ...submitted,
      status,
      template,
      recordedDecision,
      renderEvidencePath,
      reviewPath,
      validatedDecisionPath,
      stage: 'blocked',
      stageLabel: STAGE_LABELS.blocked,
      blockingReasons: [checkoutBlock],
      canRepin: false,
    });
  }
  if (!hasRenderEvidence) {
    const renderOnly = status.blockingReasons.length === 1
      && status.blockingReasons[0] === 'render-evidence-required';
    return Object.freeze({
      ...submitted,
      status,
      template,
      recordedDecision,
      renderEvidencePath,
      reviewPath,
      validatedDecisionPath,
      stage: renderOnly ? 'prepared' : 'blocked',
      stageLabel: STAGE_LABELS[renderOnly ? 'prepared' : 'blocked'],
      blockingReasons: [...status.blockingReasons],
    });
  }
  if (!status.ownerDecisionEligible) {
    return Object.freeze({
      ...submitted,
      status,
      template,
      recordedDecision,
      renderEvidencePath,
      reviewPath,
      validatedDecisionPath,
      stage: 'blocked',
      stageLabel: STAGE_LABELS.blocked,
      blockingReasons: [...status.blockingReasons],
    });
  }
  return Object.freeze({
    ...submitted,
    status,
    template,
    recordedDecision,
    renderEvidencePath,
    reviewPath,
    validatedDecisionPath,
    stage: recordedDecision ? 'decision-recorded' : 'awaiting-decision',
    stageLabel: STAGE_LABELS[recordedDecision ? 'decision-recorded' : 'awaiting-decision'],
    blockingReasons: [],
  });
}

export async function inspectDogfoodSeries({ projectRoot, workspaceRoot } = {}) {
  const workspaceOptions = {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  };
  const series = await loadOwnerDogfoodSeries(workspaceOptions);
  const attempts = [];
  for (const attemptId of series.attemptIds) {
    attempts.push(await inspectDogfoodAttempt(attemptId, series, workspaceOptions));
  }
  const suggested = attempts.find((attempt) => ACTIONABLE_STAGES.has(attempt.stage)
    || (attempt.stage === 'blocked' && attempt.canRepin === true)) ?? null;
  return Object.freeze({ series, attempts: Object.freeze(attempts), suggestedAttemptId: suggested?.attemptId ?? null });
}

export async function recordWizardOwnerDecision({
  attempt,
  decision,
  reason,
  reviewSeconds,
  decidedAt,
}) {
  if (attempt.stage !== 'awaiting-decision' || !attempt.template) {
    fail('wizard-decision-not-ready', 'the selected attempt is not ready for an owner decision');
  }
  const paths = attempt.paths;
  return withAttemptBindingLock(paths, async () => {
      const currentOperator = await loadAttemptOperator(paths);
      const currentSubmission = validateSubmission(
        await loadAttemptJson(paths.submission, 'submission', paths),
      );
      const currentCaseId = caseId(convertPilotSubmission(currentSubmission, currentOperator));
      if (currentCaseId !== attempt.mechanicalCaseId) {
        fail('wizard-decision-binding-stale', 'owner decision no longer matches the effective source binding');
      }
    const current = await loadAttemptJson(paths.ownerDecision, 'owner-decision', paths);
    const runTemplate = validateDecisionTemplate(
      await loadAttemptJson(
        path.join(attempt.runDir, 'owner-decision-template.json'),
        'owner-decision-template',
        paths,
      ),
      { attemptId: attempt.attemptId, mechanicalCaseId: attempt.mechanicalCaseId },
    );
    if (stableStringify(current) !== stableStringify(runTemplate)) {
      fail('wizard-decision-already-recorded', 'owner decision is no longer a blank bound scaffold');
    }
    const normalized = validateOwnerDecision({
      ...runTemplate,
      decision,
      reason,
      reviewSeconds,
      decidedAt,
    });
    await atomicCreateArtifact(
      path.join(attempt.runDir, 'wizard-owner-decision.json'),
      stableStringify(normalized),
      paths,
    );
    return normalized;
  });
}

function defaultActions() {
  return {
    initializeAttempt,
    serve: prepareDogfoodReaderServer,
    prepare: preparePilotAttempt,
    repin: repinOwnerDogfoodAttempt,
    render: renderPilotAttempt,
    recordDecision: recordWizardOwnerDecision,
    validateDecision: validatePilotOwnerDecision,
    recordError: recordPilotError,
  };
}

function formatObligation(value) {
  return value.replaceAll('-', ' ');
}

function choice(value, label, description = '') {
  return { value, label, description };
}

async function nonBlank(ui, message) {
  while (true) {
    const value = (await ui.input(message)).trim();
    if (value.length > 0) return value;
    ui.write('A nonblank value is required.');
  }
}

async function reviewSecondsInput(ui) {
  while (true) {
    const value = (await ui.input('Review duration in whole seconds')).trim();
    if (/^(?:0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value))) {
      return Number(value);
    }
    ui.write('Enter a non-negative whole number of seconds.');
  }
}

async function executeAction({
  ui,
  actions,
  attemptId,
  projectRoot,
  workspaceRoot,
  attemptScoped = true,
  action,
}) {
  ui.beginAction?.();
  try {
    return await action();
  } catch (error) {
    await actions.recordError({ attemptId, error, attemptScoped, projectRoot, workspaceRoot });
    ui.write(`Stopped: ${error?.code ?? 'dogfood-action-failed'} — ${error?.message ?? 'action failed'}`);
    return null;
  } finally {
    ui.endAction?.();
  }
}

async function initializeAttemptFlow({ ui, actions, attempt, projectRoot, workspaceRoot }) {
  const checkoutDir = await nonBlank(ui, 'Absolute clean Cyberbase checkout path');
  const sourcePath = await nonBlank(ui, 'Owner-confirmed repository-relative Markdown source path');
  const publicUrl = await nonBlank(ui, 'Exact public HTTPS URL');
  if (!(await ui.confirm('Authorize local processing of this owner-confirmed source?'))) return;
  ui.write([
    'Review initialization:',
    `  attempt: ${attempt.attemptId}`,
    '  profile: owner-self-dogfood',
    `  checkout: ${checkoutDir}`,
    `  source: ${sourcePath}`,
    `  public URL: ${publicUrl}`,
  ].join('\n'));
  if (!(await ui.confirm('Create this ignored attempt exactly as shown?'))) return;
  const result = await executeAction({
    ui,
    actions,
    attemptId: attempt.attemptId,
    projectRoot,
    workspaceRoot,
    attemptScoped: false,
    action: () => actions.initializeAttempt({
      attemptId: attempt.attemptId,
      profile: 'owner-self-dogfood',
      checkoutDir,
      sourcePath,
      publicUrl,
      sourceAuthorization: 'yes',
      projectRoot,
      workspaceRoot,
    }),
  });
  if (result) ui.write(`${attempt.attemptId} initialized. No listener was started.`);
}

async function repinAttemptFlow({ ui, actions, attempt, clock, projectRoot, workspaceRoot }) {
  const checkoutDir = await nonBlank(ui, 'Absolute clean Cyberbase checkout path containing publish.yml');
  const reason = await nonBlank(ui, 'Reason for replacing the pinned source base');
  if (!(await ui.confirm('Authorize local processing of the same source at this replacement pin?'))) return;
  let preview;
  try {
    const head = await deriveCheckoutHead(checkoutDir);
    preview = await inspectCheckout({
      checkoutDir,
      pinnedCommit: head,
      repository: attempt.operator.repository,
      sourcePath: attempt.operator.sourcePath,
    });
    if (preview.publishConfigPresent !== true) {
      fail(
        'publication-boundary-policy-missing',
        'the replacement pin must contain tracked publish.yml',
      );
    }
  } catch (error) {
    ui.write(`Stopped: ${error?.code ?? 'operator-repin-preview-failed'} — ${error?.message ?? 'repin preview failed'}`);
    return;
  }
  ui.write([
    'Review immutable repin:',
    `  attempt: ${attempt.attemptId}`,
    `  previous base: ${attempt.operator.baseCommit}`,
    `  replacement base: ${preview.head}`,
    `  replacement checkout: ${preview.root}`,
    `  source: ${attempt.operator.sourcePath}`,
    `  public URL: ${attempt.operator.publicUrl}`,
    `  reason: ${reason}`,
  ].join('\n'));
  if (!(await ui.confirm('Record this one-time repin exactly as shown?'))) return;
  const result = await executeAction({
    ui,
    actions,
    attemptId: attempt.attemptId,
    projectRoot,
    workspaceRoot,
    action: () => actions.repin({
      attemptId: attempt.attemptId,
      checkoutDir: preview.root,
      sourceAuthorization: 'yes',
      reason,
      repinnedAt: new Date(clock()).toISOString(),
      projectRoot,
      workspaceRoot,
    }),
  });
  if (result) {
    ui.write(`Repinned ${attempt.attemptId} to ${result.baseCommit}. Old runs remain unchanged.`);
  }
}

async function expiryChoice(ui) {
  const selected = await ui.select('How long may the one-shot link remain available?', [
    choice('15', '15 minutes', 'recommended'),
    choice('5', '5 minutes'),
    choice('30', '30 minutes'),
    choice('60', '60 minutes'),
    choice('custom', 'Enter another value'),
    choice('cancel', 'Cancel'),
  ], { recommendedValue: '15' });
  if (selected === 'cancel') return null;
  if (selected !== 'custom') return parseExpiresMinutes(selected);
  while (true) {
    try {
      return parseExpiresMinutes((await ui.input('Expiry in whole minutes, 1 through 60')).trim());
    } catch (error) {
      ui.write(error.message);
    }
  }
}

async function serveFlow({ ui, actions, attempt, projectRoot, workspaceRoot }) {
  const expiresMinutes = await expiryChoice(ui);
  if (expiresMinutes === null) return null;
  if (!(await ui.confirm(`Start one bodyless-GET Tailscale link for ${expiresMinutes} minutes?`))) return null;
  await ui.pause();
  let running;
  try {
    running = await actions.serve({
      attemptId: attempt.attemptId,
      expiresMinutes,
      snapshotOptions: { projectRoot, workspaceRoot },
    });
    ui.write(JSON.stringify({
      status: 'ready',
      ...readerServerDisplayUrls(running),
      expiresAt: new Date(running.expiresAt).toISOString(),
      warning: 'Treat this one-shot URL as an expiring secret. Use the numeric HTTP URL exactly as printed.',
    }));
    const outcome = await running.completion;
    ui.write(`Tailscale handoff stopped: ${outcome.reason}.`);
    return outcome.reason;
  } catch (error) {
    if (running) await running.stop('wizard-failed', true).catch(() => {});
    ui.write(`Transport stopped: ${error?.code ?? 'dogfood-serve-failed'} — ${error?.message ?? 'serve failed'}`);
    return null;
  } finally {
    await ui.resume();
  }
}

async function prepareFlow({ ui, actions, attempt, projectRoot, workspaceRoot }) {
  ui.write('Preparation revalidates the pinned owner mapping and writes only ignored no-source-write evidence.');
  if (!(await ui.confirm('Prepare this exact submission now?'))) return;
  const result = await executeAction({
    ui,
    actions,
    attemptId: attempt.attemptId,
    projectRoot,
    workspaceRoot,
    action: () => actions.prepare({ attemptId: attempt.attemptId, projectRoot, workspaceRoot }),
  });
  if (result) ui.write(`Prepared ${result.mechanicalCaseId}. Source application remains false.`);
}

async function renderFlow({ ui, actions, attempt, projectRoot, workspaceRoot }) {
  ui.write('Rendering uses isolated copies and pinned Quartz. It may take several minutes and use the network.');
  if (!(await ui.confirm('Run the isolated Cyberbase render now?'))) return;
  const result = await executeAction({
    ui,
    actions,
    attemptId: attempt.attemptId,
    projectRoot,
    workspaceRoot,
    action: () => actions.render({ attemptId: attempt.attemptId, projectRoot, workspaceRoot }),
  });
  if (result) {
    ui.write(`Render complete. Owner decision eligible: ${result.ownerDecisionEligible}.`);
  }
}

async function decisionFlow({
  ui,
  actions,
  attempt,
  series,
  clock,
  projectRoot,
  workspaceRoot,
}) {
  ui.write(`Review card: ${attempt.reviewPath}`);
  ui.write(`Observation: ${attempt.paths.dogfoodObservation}`);
  const rejectionAttempt = series.obligationAssignments['owner-rejection'] === attempt.attemptId;
  const decisionChoices = rejectionAttempt
    ? [choice('reject', 'Reject this candidate'), choice('cancel', 'Cancel')]
    : [
        choice('accept', 'Accept'),
        choice('reject', 'Reject'),
        choice('clarify', 'Request clarification'),
        choice('cancel', 'Cancel'),
      ];
  const decision = await ui.select('What is your editorial decision?', decisionChoices);
  if (decision === 'cancel') return;
  const reason = await nonBlank(ui, 'Reason for this decision');
  const reviewSeconds = await reviewSecondsInput(ui);
  ui.write([
    'Review owner decision:',
    `  attempt: ${attempt.attemptId}`,
    `  case: ${attempt.mechanicalCaseId}`,
    `  decision: ${decision}`,
    `  reason: ${reason}`,
    `  review seconds: ${reviewSeconds}`,
    '  decided at: recorded on final confirmation',
  ].join('\n'));
  if (!(await ui.confirm('Record this bound decision?'))) return;
  const decidedAt = new Date(clock()).toISOString();
  const result = await executeAction({
    ui,
    actions,
    attemptId: attempt.attemptId,
    projectRoot,
    workspaceRoot,
    action: () => actions.recordDecision({
      attempt,
      decision,
      reason,
      reviewSeconds,
      decidedAt,
    }),
  });
  if (result) ui.write(`Recorded ${result.decision}. No source write or deployment occurred.`);
}

async function validateDecisionFlow({ ui, actions, attempt, projectRoot, workspaceRoot }) {
  ui.write('Validation reruns the isolated live lane and may take as long as a full render.');
  if (!(await ui.confirm('Validate this recorded owner decision now?'))) return;
  const result = await executeAction({
    ui,
    actions,
    attemptId: attempt.attemptId,
    projectRoot,
    workspaceRoot,
    action: () => actions.validateDecision({ attemptId: attempt.attemptId, projectRoot, workspaceRoot }),
  });
  if (!result) return;
  ui.write(`Validated owner decision: ${result.decision}.`);
  if (result.decision === 'accept') {
    ui.write('Application, commit, push, deployment, and live verification remain separate owner-controlled steps.');
  } else {
    ui.write('No source application follows this decision.');
  }
}

function attemptMenuChoices(attempt) {
  if (attempt.stage === 'blocked' && attempt.canRepin) {
    return [
      choice('repin', 'Repin to a policy-bearing checkout', 'recommended'),
      choice('paths', 'Show blocked run and private paths'),
      choice('back', 'Back'),
    ];
  }
  if (attempt.stage === 'not-initialized') {
    return [
      choice('initialize', 'Initialize this declared attempt'),
      choice('paths', 'Show expected private paths'),
      choice('back', 'Back'),
    ];
  }
  if (attempt.stage === 'awaiting-submission') {
    return [
      choice('serve', 'Serve one-shot form over Tailscale', 'recommended'),
      choice('paths', 'Show form and submission paths'),
      choice('back', 'Back'),
    ];
  }
  if (attempt.stage === 'submitted') {
    return [
      choice('prepare', 'Prepare the exact candidate', 'recommended'),
      choice('paths', 'Show private paths'),
      choice('back', 'Back'),
    ];
  }
  if (attempt.stage === 'prepared') {
    return [
      choice('render', 'Run isolated render', 'recommended'),
      choice('paths', 'Show run and review paths'),
      choice('back', 'Back'),
    ];
  }
  if (attempt.stage === 'awaiting-decision') {
    return [
      choice('record-decision', 'Record owner decision', 'recommended'),
      choice('paths', 'Show review and observation paths'),
      choice('back', 'Back'),
    ];
  }
  if (attempt.stage === 'decision-recorded') {
    return [
      choice('validate-decision', 'Validate recorded decision', 'recommended'),
      choice('paths', 'Show decision and review paths'),
      choice('back', 'Back'),
    ];
  }
  return [choice('paths', 'Show relevant private paths'), choice('back', 'Back')];
}

function showPaths(ui, attempt) {
  ui.write([
    `Attempt root: ${attempt.paths.root}`,
    `Reader form: ${attempt.paths.readerForm}`,
    `Expected submission: ${attempt.paths.submission}`,
    `Observation: ${attempt.paths.dogfoodObservation}`,
    `Owner decision: ${attempt.paths.ownerDecision}`,
    ...(attempt.runDir ? [`Current run: ${attempt.runDir}`] : []),
    ...(attempt.reviewPath ? [`Rendered review: ${attempt.reviewPath}`] : []),
  ].join('\n'));
}

async function runAttemptMenu(context, attemptId) {
  const { ui } = context;
  while (true) {
    const state = await context.inspect({
      projectRoot: context.projectRoot,
      workspaceRoot: context.workspaceRoot,
    });
    const attempt = state.attempts.find((item) => item.attemptId === attemptId);
    if (!attempt) fail('wizard-attempt-not-declared', 'selected attempt is no longer declared');
    ui.write(`\n${attempt.attemptId}: ${attempt.stageLabel}`);
    if (attempt.blockingReasons.length > 0) {
      ui.write(`Blocking reasons: ${attempt.blockingReasons.join(', ')}`);
    }
    const choices = attemptMenuChoices(attempt);
    const selected = await ui.select('Choose an action', choices, {
      recommendedValue: choices.find((item) => item.description === 'recommended')?.value,
    });
    if (selected === 'back') return null;
    if (selected === 'paths') {
      showPaths(ui, attempt);
      continue;
    }
    if (selected === 'initialize') {
      await initializeAttemptFlow({ ...context, attempt });
      continue;
    }
    if (selected === 'serve') {
      const reason = await serveFlow({ ...context, attempt });
      if (reason === 'sigterm') return 'exit';
      continue;
    }
    if (selected === 'repin') {
      await repinAttemptFlow({ ...context, attempt });
      continue;
    }
    if (selected === 'prepare') {
      await prepareFlow({ ...context, attempt });
      continue;
    }
    if (selected === 'render') {
      await renderFlow({ ...context, attempt });
      continue;
    }
    if (selected === 'record-decision') {
      await decisionFlow({ ...context, attempt, series: state.series });
      continue;
    }
    if (selected === 'validate-decision') {
      await validateDecisionFlow({ ...context, attempt });
    }
  }
}

export async function runDogfoodWizard({
  ui,
  projectRoot,
  workspaceRoot,
  inspect = inspectDogfoodSeries,
  actionOverrides = {},
  clock = Date.now,
} = {}) {
  const actions = { ...defaultActions(), ...actionOverrides };
  const context = { ui, actions, inspect, projectRoot, workspaceRoot, clock };
  ui.write('Owner self-dogfood');
  while (true) {
    let state;
    try {
      state = await inspect({ projectRoot, workspaceRoot });
    } catch (error) {
      if (error?.code === 'dogfood-series-required') {
        ui.write('No owner-dogfood charter exists. Create it with dogfood:series-init before using the wizard.');
        return { reason: 'charter-required' };
      }
      throw error;
    }
    const attemptChoices = state.attempts.map((attempt) => choice(
      attempt.attemptId,
      `${attempt.attemptId} — ${attempt.stageLabel}`,
      attempt.obligations.map(formatObligation).join(', '),
    ));
    attemptChoices.push(choice('refresh', 'Refresh status'));
    attemptChoices.push(choice('exit', 'Exit'));
    ui.write('');
    for (const attempt of state.attempts) {
      const suggested = attempt.attemptId === state.suggestedAttemptId ? ' [recommended]' : '';
      ui.write(`${attempt.attemptId}: ${attempt.stageLabel}${suggested}`);
      ui.write(`  ${attempt.obligations.map(formatObligation).join(', ')}`);
    }
    const selected = await ui.select('Choose an attempt', attemptChoices, {
      recommendedValue: state.suggestedAttemptId,
    });
    if (selected === 'exit') return { reason: 'exit' };
    if (selected === 'refresh') continue;
    const result = await runAttemptMenu(context, selected);
    if (result === 'exit') return { reason: 'sigterm' };
  }
}
