import path from 'node:path';
import { deepFreeze, stableStringify } from './case.js';

const ATTEMPT_RE = /^(?:HC|OD)-(?:0[1-9]|[1-9][0-9])$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u;
const PROFILES = new Set(['cyberbase-rehearsal', 'owner-self-dogfood', 'independent-counted']);
const KINDS = new Set(['typo', 'factual', 'link', 'wording', 'formatting']);
const PUBLICATION_BOUNDARIES = new Set(['cyberbaser', 'not-applicable']);
const RENDERER_PROFILES = new Set(['cyberbase-quartz-v4.5.2', 'owner-static-output']);
const INSTRUMENT_VERSIONS = new Set(['reader-form-v1', 'reader-form-v2']);
export const OWNER_DOGFOOD_OBLIGATIONS = deepFreeze([
  'normal-correction',
  'signed-out-mobile-handoff',
  'stale-source',
  'ambiguous-quote',
  'owner-rejection',
]);
const SUPERSEDED_OWNER_DOGFOOD_ATTEMPTS = new Set(['OD-02', 'OD-03']);

export function isSupersededOwnerDogfoodAttempt(attemptId) {
  return SUPERSEDED_OWNER_DOGFOOD_ATTEMPTS.has(attemptId);
}
const OWNER_DOGFOOD_CLASSIFICATION = deepFreeze({
  evidenceClass: 'owner-self-dogfood',
  countsTowardHumanPilot: false,
  independentOwnerEvidence: false,
  claimBoundary: 'maintainer operational and mechanical evidence only',
});
const OWNER_DOGFOOD_SERIES_KEYS = new Set([
  'schemaVersion', 'artifactType', 'profile', 'attemptIds', 'obligationAssignments',
  'plannedSignedOutMobile', 'evidenceClassification',
]);
const OWNER_DOGFOOD_MOBILE_KEYS = new Set([
  'attemptId', 'device', 'operatingSystem', 'browser', 'signedIn',
]);
const OWNER_DOGFOOD_CLASSIFICATION_KEYS = new Set(Object.keys(OWNER_DOGFOOD_CLASSIFICATION));
const SUBMISSION_KEYS = new Set([
  'schemaVersion', 'instrumentVersion', 'attemptId', 'openedAt', 'submittedAt', 'elapsedMs',
  'pageUrl', 'exactQuote', 'replacement', 'rationale', 'factualSource', 'publicCreditName',
  'creditConsent',
]);
const OPERATOR_KEYS = new Set([
  'schemaVersion', 'attemptId', 'profile', 'repository', 'checkoutDir', 'baseCommit', 'sourcePath',
  'publicUrl', 'sourceAuthorizedForLocalProcessing', 'independentOwnerAttested', 'readerUnaided',
  'accessInterruption', 'correctionKind', 'selectorContext', 'ownerPolicyRevision', 'ownerPolicy',
  'publicationBoundary', 'renderer',
]);
const OPERATOR_REPIN_KEYS = new Set([
  'schemaVersion', 'artifactType', 'attemptId', 'reason', 'repinnedAt',
  'previousCheckoutDir', 'previousBaseCommit', 'publishConfigPresent', 'replacementOperator',
]);
const SELECTOR_KEYS = new Set(['prefix', 'suffix']);
const RENDERER_KEYS = new Set(['profile', 'basePath', 'buildCommand']);
const DECISION_KEYS = new Set([
  'schemaVersion', 'attemptId', 'mechanicalCaseId', 'candidateDigest', 'decision', 'reason',
  'reviewSeconds', 'decidedAt',
]);
const RENDER_ATTESTATION_KEYS = new Set([
  'schemaVersion', 'attemptId', 'mechanicalCaseId', 'baselineSourceDigest',
  'candidateSourceDigest', 'rendererProfile', 'buildCommand', 'baselineSiteDir',
  'candidateSiteDir', 'builtFromPreparedSnapshots', 'builtInIsolatedWorkspaces',
  'ownerConfirmedAt',
]);
const DOGFOOD_OBSERVATION_KEYS = new Set([
  'schemaVersion', 'attemptId', 'evidenceClass', 'precommittedObligations', 'scenario',
  'readerContext', 'ownerContext', 'roleSeparation', 'startedAt', 'completedAt',
  'manualInterventions', 'sourceWritePerformed', 'publicDeploymentPerformed',
  'liveVerificationPerformed', 'notes',
]);
const DOGFOOD_CONTEXT_KEYS = new Set([
  'device', 'operatingSystem', 'browser', 'signedIn',
]);
const CASE_ID_RE = /^DRY-[0-9A-F]{12}$/u;
const REPRESENTATION_DIGEST_RE = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u;

export class PilotInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PilotInputError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PilotInputError(code, message, details);
}

function plainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`invalid-${label}`, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`invalid-${label}`, `${label} must be a plain object`);
  }
  return value;
}

function strictKeys(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.has(key)).sort();
  if (unknown.length > 0) fail(`unknown-${label}-field`, `${label} contains unknown field: ${unknown[0]}`);
}

function requiredKeys(value, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`missing-${label}-field`, `${label}.${key} is required`);
  }
}

function exactString(value, label, { nonEmpty = false, oneLine = false } = {}) {
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string`);
  if (nonEmpty && value.length === 0) fail('empty-string', `${label} must not be empty`);
  if (CONTROL_RE.test(value)) fail('control-character', `${label} contains a forbidden control character`);
  if (oneLine && /[\r\n]/u.test(value)) fail('newline-not-allowed', `${label} must be one line`);
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    fail('invalid-unicode', `${label} must round-trip as exact UTF-8`);
  }
  return value;
}

function exactNonBlankString(value, label) {
  const text = exactString(value, label, { nonEmpty: true, oneLine: true });
  if (!/\S/u.test(text)) fail('blank-string', `${label} must contain a non-whitespace character`);
  return text;
}

function exactHttpsUrl(value, label) {
  const text = exactString(value, label, { nonEmpty: true, oneLine: true });
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('invalid-url', `${label} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') fail('insecure-url', `${label} must use https`);
  if (url.username || url.password) fail('credentialed-url', `${label} must not contain credentials`);
  return url.href;
}

function isCyberbaseRepository(value) {
  const url = new URL(value);
  const identity = `${url.hostname.toLowerCase()}${url.pathname}`
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '')
    .toLowerCase();
  return identity === 'github.com/cybersader/cyberbase';
}

function exactIsoDate(value, label) {
  const text = exactString(value, label, { nonEmpty: true, oneLine: true });
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(text) || Number.isNaN(Date.parse(text))) {
    fail('invalid-timestamp', `${label} must be an ISO-8601 timestamp`);
  }
  return text;
}

function exactAttemptId(value) {
  const attemptId = exactString(value, 'attemptId', { nonEmpty: true, oneLine: true });
  if (!ATTEMPT_RE.test(attemptId)) fail('invalid-attempt-id', 'attemptId must use HC-01 through HC-99 or OD-01 through OD-99');
  return attemptId;
}

function exactSourcePath(value) {
  const sourcePath = exactString(value, 'sourcePath', { nonEmpty: true, oneLine: true });
  if (sourcePath.includes('\\') || path.posix.isAbsolute(sourcePath) || /^[A-Za-z]:/u.test(sourcePath)) {
    fail('invalid-source-path', 'sourcePath must be a repository-relative POSIX Markdown path');
  }
  const segments = sourcePath.split('/');
  if (path.posix.normalize(sourcePath) !== sourcePath
    || segments.some((part) => part === '' || part === '.' || part === '..')) {
    fail('unsafe-source-path', 'sourcePath must not contain empty, dot, or parent segments');
  }
  if (!sourcePath.toLowerCase().endsWith('.md')) {
    fail('non-markdown-source', 'sourcePath must identify one Markdown file');
  }
  return sourcePath;
}

export function validateAttemptId(value) {
  return exactAttemptId(value);
}

export function validateSourcePath(value) {
  return exactSourcePath(value);
}

export function validateProfile(value) {
  const profile = exactString(value, 'profile', { nonEmpty: true, oneLine: true });
  if (!PROFILES.has(profile)) {
    fail('invalid-profile', 'profile must be cyberbase-rehearsal, owner-self-dogfood, or independent-counted');
  }
  return profile;
}

export function validateSubmission(input) {
  const value = plainRecord(input, 'submission');
  strictKeys(value, SUBMISSION_KEYS, 'submission');
  requiredKeys(value, SUBMISSION_KEYS, 'submission');
  if (value.schemaVersion !== 1) fail('invalid-schema-version', 'submission.schemaVersion must be 1');
  const instrumentVersion = exactString(
    value.instrumentVersion,
    'submission.instrumentVersion',
    { nonEmpty: true, oneLine: true },
  );
  if (!INSTRUMENT_VERSIONS.has(instrumentVersion)) {
    fail(
      'invalid-instrument-version',
      'submission.instrumentVersion must be reader-form-v1 or reader-form-v2',
    );
  }
  if (!Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) {
    fail('invalid-elapsed-ms', 'submission.elapsedMs must be a non-negative safe integer');
  }
  const factualSource = value.factualSource === 'not applicable'
    ? value.factualSource
    : exactHttpsUrl(value.factualSource, 'submission.factualSource');
  const creditConsent = exactString(value.creditConsent, 'submission.creditConsent', { nonEmpty: true, oneLine: true });
  if (!['yes', 'no'].includes(creditConsent)) {
    fail('invalid-credit-consent', 'submission.creditConsent must be yes or no');
  }
  const publicCreditName = exactString(value.publicCreditName, 'submission.publicCreditName', { oneLine: true });
  if (creditConsent === 'yes' && publicCreditName.length === 0) {
    fail('credit-name-required', 'credit consent yes requires a non-empty public credit name');
  }
  const exactQuote = exactString(
    value.exactQuote,
    'submission.exactQuote',
    { nonEmpty: true, oneLine: true },
  );
  const replacement = exactString(value.replacement, 'submission.replacement', { oneLine: true });
  if (instrumentVersion === 'reader-form-v2' && exactQuote === replacement) {
    fail('no-op-replacement', 'reader-form-v2 replacement must differ from the exact quote');
  }

  return deepFreeze({
    schemaVersion: 1,
    instrumentVersion,
    attemptId: exactAttemptId(value.attemptId),
    openedAt: exactIsoDate(value.openedAt, 'submission.openedAt'),
    submittedAt: exactIsoDate(value.submittedAt, 'submission.submittedAt'),
    elapsedMs: value.elapsedMs,
    pageUrl: exactHttpsUrl(value.pageUrl, 'submission.pageUrl'),
    exactQuote,
    replacement,
    rationale: exactString(value.rationale, 'submission.rationale', { nonEmpty: true }),
    factualSource,
    publicCreditName,
    creditConsent,
  });
}

export function createSubmissionRecord({
  attemptId,
  openedAt,
  submittedAt,
  elapsedMs,
  fields,
  instrumentVersion = 'reader-form-v2',
}) {
  const values = plainRecord(fields, 'form-fields');
  strictKeys(values, new Set([
    'pageUrl', 'exactQuote', 'replacement', 'rationale', 'factualSource', 'publicCreditName',
    'creditConsent',
  ]), 'form-fields');
  return validateSubmission({
    schemaVersion: 1,
    instrumentVersion,
    attemptId,
    openedAt,
    submittedAt,
    elapsedMs,
    ...values,
  });
}

export function convertReaderFieldsToCase(formFields, ownerMappingInput, kindInput) {
  const fields = plainRecord(formFields, 'form-fields');
  const submission = createSubmissionRecord({
    attemptId: 'HC-99',
    openedAt: '2000-01-01T00:00:00.000Z',
    submittedAt: '2000-01-01T00:00:00.000Z',
    elapsedMs: 0,
    fields,
  });
  const ownerMapping = plainRecord(ownerMappingInput, 'owner-mapping');
  const mappingKeys = new Set(['repository', 'baseCommit', 'sourcePath', 'publicUrl', 'selectorContext']);
  strictKeys(ownerMapping, mappingKeys, 'owner-mapping');
  requiredKeys(ownerMapping, new Set(['repository', 'baseCommit', 'sourcePath']), 'owner-mapping');
  const baseCommit = exactString(ownerMapping.baseCommit, 'owner-mapping.baseCommit', { nonEmpty: true, oneLine: true });
  if (!COMMIT_RE.test(baseCommit)) {
    fail('invalid-base-commit', 'owner-mapping.baseCommit must be a lowercase 40-character Git object ID');
  }
  const publicUrl = Object.hasOwn(ownerMapping, 'publicUrl')
    ? exactHttpsUrl(ownerMapping.publicUrl, 'owner-mapping.publicUrl')
    : submission.pageUrl;
  if (publicUrl !== submission.pageUrl) {
    fail('page-mapping-mismatch', 'owner-confirmed public URL must exactly equal the submitted page URL');
  }
  const kind = exactString(kindInput, 'correctionKind', { nonEmpty: true, oneLine: true });
  if (!KINDS.has(kind)) fail('invalid-kind', 'correctionKind is invalid');
  const selectorContext = Object.hasOwn(ownerMapping, 'selectorContext')
    ? validateSelectorContext(ownerMapping.selectorContext)
    : {};
  return deepFreeze({
    repository: exactHttpsUrl(ownerMapping.repository, 'owner-mapping.repository'),
    baseCommit,
    sourcePath: exactSourcePath(ownerMapping.sourcePath),
    publicUrl: submission.pageUrl,
    quote: submission.exactQuote,
    ...(Object.hasOwn(selectorContext, 'prefix') ? { prefix: selectorContext.prefix } : {}),
    ...(Object.hasOwn(selectorContext, 'suffix') ? { suffix: selectorContext.suffix } : {}),
    replacement: submission.replacement,
    rationale: submission.rationale,
    evidence: [submission.factualSource],
    kind,
  });
}

function validateSelectorContext(input) {
  const value = plainRecord(input, 'selector-context');
  strictKeys(value, SELECTOR_KEYS, 'selector-context');
  return deepFreeze({
    ...(Object.hasOwn(value, 'prefix') ? { prefix: exactString(value.prefix, 'operator.selectorContext.prefix') } : {}),
    ...(Object.hasOwn(value, 'suffix') ? { suffix: exactString(value.suffix, 'operator.selectorContext.suffix') } : {}),
  });
}

function validateRenderer(input) {
  const value = plainRecord(input, 'renderer');
  strictKeys(value, RENDERER_KEYS, 'renderer');
  requiredKeys(value, RENDERER_KEYS, 'renderer');
  const profile = exactString(value.profile, 'operator.renderer.profile', { nonEmpty: true, oneLine: true });
  if (!RENDERER_PROFILES.has(profile)) fail('invalid-renderer-profile', 'operator.renderer.profile is invalid');
  return deepFreeze({
    profile,
    basePath: exactString(value.basePath, 'operator.renderer.basePath', { oneLine: true }),
    buildCommand: exactString(value.buildCommand, 'operator.renderer.buildCommand', { nonEmpty: true }),
  });
}

export function validateOperator(input) {
  const value = plainRecord(input, 'operator');
  strictKeys(value, OPERATOR_KEYS, 'operator');
  requiredKeys(value, OPERATOR_KEYS, 'operator');
  if (value.schemaVersion !== 1) fail('invalid-schema-version', 'operator.schemaVersion must be 1');
  const profile = validateProfile(value.profile);
  const attemptId = exactAttemptId(value.attemptId);
  if (profile === 'owner-self-dogfood' && !attemptId.startsWith('OD-')) {
    fail('dogfood-attempt-id-required', 'owner-self-dogfood must use an OD-01 through OD-99 attempt ID');
  }
  if (profile !== 'owner-self-dogfood' && !attemptId.startsWith('HC-')) {
    fail('pilot-attempt-id-required', 'pilot and rehearsal profiles must use an HC-01 through HC-99 attempt ID');
  }
  const repository = exactHttpsUrl(value.repository, 'operator.repository');
  const checkoutDir = exactString(value.checkoutDir, 'operator.checkoutDir', { nonEmpty: true, oneLine: true });
  if (!path.isAbsolute(checkoutDir)) fail('invalid-checkout-dir', 'operator.checkoutDir must be an absolute local path');
  const baseCommit = exactString(value.baseCommit, 'operator.baseCommit', { nonEmpty: true, oneLine: true });
  if (!COMMIT_RE.test(baseCommit)) {
    fail('invalid-base-commit', 'operator.baseCommit must be a lowercase 40-character Git object ID');
  }
  for (const field of [
    'sourceAuthorizedForLocalProcessing', 'independentOwnerAttested', 'readerUnaided', 'accessInterruption',
  ]) {
    if (typeof value[field] !== 'boolean') fail('invalid-boolean', `operator.${field} must be boolean`);
  }
  if (value.sourceAuthorizedForLocalProcessing !== true) {
    fail('source-authorization-required', 'owner authorization for local source processing is required');
  }
  const correctionKind = exactString(value.correctionKind, 'operator.correctionKind', { nonEmpty: true, oneLine: true });
  if (!KINDS.has(correctionKind)) fail('invalid-kind', 'operator.correctionKind is invalid');
  const ownerPolicy = plainRecord(value.ownerPolicy, 'owner-policy');
  const publicationBoundary = exactString(value.publicationBoundary, 'operator.publicationBoundary', { nonEmpty: true, oneLine: true });
  if (!PUBLICATION_BOUNDARIES.has(publicationBoundary)) {
    fail('invalid-publication-boundary', 'operator.publicationBoundary is invalid');
  }
  const renderer = validateRenderer(value.renderer);

  if (profile === 'cyberbase-rehearsal' || profile === 'owner-self-dogfood') {
    if (!isCyberbaseRepository(repository)) {
      fail('cyberbase-profile-repository-mismatch', `${profile} must use the public Cyberbase repository`);
    }
    if (renderer.profile !== 'cyberbase-quartz-v4.5.2') {
      fail('cyberbase-profile-renderer-mismatch', `${profile} must use the pinned Cyberbase Quartz profile`);
    }
    if (publicationBoundary !== 'cyberbaser') {
      fail('cyberbase-profile-boundary-mismatch', `${profile} must verify the Cyberbaser publication boundary`);
    }
    if (profile === 'owner-self-dogfood' && value.independentOwnerAttested !== false) {
      fail('dogfood-cannot-claim-independent-owner', 'owner-self-dogfood cannot claim independent-owner evidence');
    }
  } else {
    if (isCyberbaseRepository(repository)) {
      fail('cyberbase-cannot-be-independent', 'the Cyberbase repository is limited to non-counting rehearsal and owner-self-dogfood profiles');
    }
    if (value.independentOwnerAttested !== true) {
      fail('independent-owner-attestation-required', 'independent-counted requires explicit independent-owner attestation');
    }
    if (renderer.profile !== 'owner-static-output') {
      fail('independent-renderer-required', 'independent-counted requires owner-static-output evidence');
    }
  }

  return deepFreeze({
    schemaVersion: 1,
    attemptId,
    profile,
    repository,
    checkoutDir,
    baseCommit,
    sourcePath: exactSourcePath(value.sourcePath),
    publicUrl: exactHttpsUrl(value.publicUrl, 'operator.publicUrl'),
    sourceAuthorizedForLocalProcessing: true,
    independentOwnerAttested: value.independentOwnerAttested,
    readerUnaided: value.readerUnaided,
    accessInterruption: value.accessInterruption,
    correctionKind,
    selectorContext: validateSelectorContext(value.selectorContext),
    ownerPolicyRevision: exactString(value.ownerPolicyRevision, 'operator.ownerPolicyRevision', { nonEmpty: true }),
    ownerPolicy: JSON.parse(JSON.stringify(ownerPolicy)),
    publicationBoundary,
    renderer,
  });
}

export function validateOperatorRepin(input, originalOperatorInput) {
  const value = plainRecord(input, 'operator-repin');
  strictKeys(value, OPERATOR_REPIN_KEYS, 'operator-repin');
  requiredKeys(value, OPERATOR_REPIN_KEYS, 'operator-repin');
  if (value.schemaVersion !== 1) fail('invalid-schema-version', 'operator-repin.schemaVersion must be 1');
  if (value.artifactType !== 'private-owner-self-dogfood-operator-repin') {
    fail('invalid-operator-repin-artifact-type', 'operator-repin artifact type is invalid');
  }
  const originalOperator = validateOperator(originalOperatorInput);
  const replacementOperator = validateOperator(value.replacementOperator);
  if (originalOperator.profile !== 'owner-self-dogfood'
    || replacementOperator.profile !== 'owner-self-dogfood') {
    fail('operator-repin-profile-mismatch', 'operator repin requires owner self-dogfood operators');
  }
  const attemptId = exactAttemptId(value.attemptId);
  if (attemptId !== originalOperator.attemptId || attemptId !== replacementOperator.attemptId) {
    fail('operator-repin-attempt-mismatch', 'operator repin attempt IDs must match');
  }
  if (value.previousCheckoutDir !== originalOperator.checkoutDir
    || value.previousBaseCommit !== originalOperator.baseCommit) {
    fail('operator-repin-previous-binding-mismatch', 'operator repin previous binding does not match the original operator');
  }
  if (value.publishConfigPresent !== true) {
    fail('operator-repin-policy-required', 'operator repin requires publish.yml at the replacement pin');
  }
  if (replacementOperator.baseCommit === originalOperator.baseCommit) {
    fail('operator-repin-base-unchanged', 'operator repin must select a different base commit');
  }
  const {
    checkoutDir: originalCheckout,
    baseCommit: originalBase,
    ...originalFixed
  } = originalOperator;
  const {
    checkoutDir: replacementCheckout,
    baseCommit: replacementBase,
    ...replacementFixed
  } = replacementOperator;
  if (stableStringify(originalFixed) !== stableStringify(replacementFixed)) {
    fail('operator-repin-binding-changed', 'operator repin may change only checkoutDir and baseCommit');
  }
  return deepFreeze({
    schemaVersion: 1,
    artifactType: 'private-owner-self-dogfood-operator-repin',
    attemptId,
    reason: exactNonBlankString(value.reason, 'operator-repin.reason'),
    repinnedAt: exactIsoDate(value.repinnedAt, 'operator-repin.repinnedAt'),
    previousCheckoutDir: originalCheckout,
    previousBaseCommit: originalBase,
    publishConfigPresent: true,
    replacementOperator,
  });
}

export function countsTowardPilot(operator) {
  validateOperator(operator);
  return false;
}

export function evidenceClassification(operatorOrProfile) {
  const operator = typeof operatorOrProfile === 'string' ? null : validateOperator(operatorOrProfile);
  const profile = operator ? operator.profile : validateProfile(operatorOrProfile);
  if (profile === 'owner-self-dogfood') return OWNER_DOGFOOD_CLASSIFICATION;
  if (profile === 'cyberbase-rehearsal') {
    return deepFreeze({
      evidenceClass: 'internal-cyberbase-rehearsal',
      countsTowardHumanPilot: false,
      independentOwnerEvidence: false,
      claimBoundary: 'zero counted independent-owner evidence; internal agentic and mechanical evidence only',
    });
  }
  return deepFreeze({
    evidenceClass: 'independent-human-pilot-candidate',
    countsTowardHumanPilot: false,
    independentOwnerEvidence: operator?.independentOwnerAttested ?? false,
    claimBoundary: 'counting remains outside the preparation kit until owner application and live verification',
  });
}

export function validateOwnerDogfoodSeriesCharter(input) {
  const value = plainRecord(input, 'owner-dogfood-series');
  strictKeys(value, OWNER_DOGFOOD_SERIES_KEYS, 'owner-dogfood-series');
  requiredKeys(value, OWNER_DOGFOOD_SERIES_KEYS, 'owner-dogfood-series');
  if (value.schemaVersion !== 1) {
    fail('invalid-schema-version', 'owner-dogfood-series.schemaVersion must be 1');
  }
  if (value.artifactType !== 'private-owner-self-dogfood-series-charter') {
    fail(
      'invalid-dogfood-series-artifact-type',
      'owner-dogfood-series.artifactType must be private-owner-self-dogfood-series-charter',
    );
  }
  if (validateProfile(value.profile) !== 'owner-self-dogfood') {
    fail('invalid-dogfood-series-profile', 'owner-dogfood-series.profile must be owner-self-dogfood');
  }
  if (!Array.isArray(value.attemptIds) || value.attemptIds.length < 3 || value.attemptIds.length > 5) {
    fail('invalid-dogfood-series-size', 'owner-dogfood-series.attemptIds must contain three to five IDs');
  }
  const attemptIds = value.attemptIds.map((item) => exactAttemptId(item));
  if (attemptIds.some((attemptId) => !attemptId.startsWith('OD-'))) {
    fail('dogfood-attempt-id-required', 'owner dogfood series must use OD-01 through OD-99 attempt IDs');
  }
  if (new Set(attemptIds).size !== attemptIds.length) {
    fail('duplicate-dogfood-attempt-id', 'owner-dogfood-series.attemptIds must be unique');
  }

  const assignments = plainRecord(value.obligationAssignments, 'dogfood-obligation-assignments');
  const obligationKeys = new Set(OWNER_DOGFOOD_OBLIGATIONS);
  strictKeys(assignments, obligationKeys, 'dogfood-obligation-assignments');
  requiredKeys(assignments, obligationKeys, 'dogfood-obligation-assignments');
  const declared = new Set(attemptIds);
  const normalizedAssignments = {};
  for (const obligation of OWNER_DOGFOOD_OBLIGATIONS) {
    const assignedAttempt = exactAttemptId(assignments[obligation]);
    if (!assignedAttempt.startsWith('OD-') || !declared.has(assignedAttempt)) {
      fail(
        'dogfood-obligation-attempt-not-declared',
        `dogfood obligation ${obligation} must reference a declared OD attempt`,
      );
    }
    normalizedAssignments[obligation] = assignedAttempt;
  }
  const usedAttempts = new Set(Object.values(normalizedAssignments));
  const unusedAttempt = attemptIds.find((attemptId) => !usedAttempts.has(attemptId));
  if (unusedAttempt) {
    fail(
      'unused-dogfood-attempt',
      `declared dogfood attempt ${unusedAttempt} must have at least one obligation`,
    );
  }

  const mobile = plainRecord(value.plannedSignedOutMobile, 'planned-signed-out-mobile');
  strictKeys(mobile, OWNER_DOGFOOD_MOBILE_KEYS, 'planned-signed-out-mobile');
  requiredKeys(mobile, OWNER_DOGFOOD_MOBILE_KEYS, 'planned-signed-out-mobile');
  const mobileAttemptId = exactAttemptId(mobile.attemptId);
  if (mobileAttemptId !== normalizedAssignments['signed-out-mobile-handoff']) {
    fail(
      'dogfood-mobile-attempt-mismatch',
      'planned signed-out mobile attempt must match the signed-out-mobile-handoff obligation',
    );
  }
  if (mobile.signedIn !== false) {
    fail('dogfood-mobile-must-be-signed-out', 'planned signed-out mobile context must set signedIn to false');
  }

  const classification = plainRecord(value.evidenceClassification, 'dogfood-evidence-classification');
  strictKeys(classification, OWNER_DOGFOOD_CLASSIFICATION_KEYS, 'dogfood-evidence-classification');
  requiredKeys(classification, OWNER_DOGFOOD_CLASSIFICATION_KEYS, 'dogfood-evidence-classification');
  for (const [key, expected] of Object.entries(OWNER_DOGFOOD_CLASSIFICATION)) {
    if (classification[key] !== expected) {
      fail(
        'dogfood-evidence-classification-mismatch',
        `dogfood evidence classification ${key} must remain fixed`,
      );
    }
  }

  return deepFreeze({
    schemaVersion: 1,
    artifactType: 'private-owner-self-dogfood-series-charter',
    profile: 'owner-self-dogfood',
    attemptIds: [...attemptIds],
    obligationAssignments: normalizedAssignments,
    plannedSignedOutMobile: {
      attemptId: mobileAttemptId,
      device: exactNonBlankString(mobile.device, 'planned-signed-out-mobile.device'),
      operatingSystem: exactNonBlankString(
        mobile.operatingSystem,
        'planned-signed-out-mobile.operatingSystem',
      ),
      browser: exactNonBlankString(mobile.browser, 'planned-signed-out-mobile.browser'),
      signedIn: false,
    },
    evidenceClassification: { ...OWNER_DOGFOOD_CLASSIFICATION },
  });
}

export function convertPilotSubmission(submissionInput, operatorInput) {
  const submission = validateSubmission(submissionInput);
  const operator = validateOperator(operatorInput);
  if (submission.attemptId !== operator.attemptId) {
    fail('attempt-id-mismatch', 'submission and operator attempt IDs must match');
  }
  if (submission.pageUrl !== operator.publicUrl) {
    fail('page-mapping-mismatch', 'owner-confirmed public URL must exactly equal submission.pageUrl');
  }
  return convertReaderFieldsToCase({
    pageUrl: submission.pageUrl,
    exactQuote: submission.exactQuote,
    replacement: submission.replacement,
    rationale: submission.rationale,
    factualSource: submission.factualSource,
    publicCreditName: submission.publicCreditName,
    creditConsent: submission.creditConsent,
  }, {
    repository: operator.repository,
    baseCommit: operator.baseCommit,
    sourcePath: operator.sourcePath,
    publicUrl: operator.publicUrl,
    selectorContext: operator.selectorContext,
  }, operator.correctionKind);
}

export function validateRenderAttestation(input) {
  const value = plainRecord(input, 'render-attestation');
  strictKeys(value, RENDER_ATTESTATION_KEYS, 'render-attestation');
  requiredKeys(value, RENDER_ATTESTATION_KEYS, 'render-attestation');
  if (value.schemaVersion !== 1) fail('invalid-schema-version', 'render-attestation.schemaVersion must be 1');
  if (value.builtFromPreparedSnapshots !== true
    || value.builtInIsolatedWorkspaces !== true
    || value.baselineSiteDir === ''
    || value.candidateSiteDir === ''
    || value.ownerConfirmedAt === '') {
    fail('render-attestation-required', 'complete the owner render attestation after building both prepared snapshots in isolated workspaces');
  }
  const mechanicalCaseId = exactString(value.mechanicalCaseId, 'render-attestation.mechanicalCaseId', { nonEmpty: true, oneLine: true });
  if (!CASE_ID_RE.test(mechanicalCaseId)) fail('invalid-mechanical-case-id', 'render-attestation.mechanicalCaseId is invalid');
  const baselineSourceDigest = exactString(value.baselineSourceDigest, 'render-attestation.baselineSourceDigest', { nonEmpty: true, oneLine: true });
  const candidateSourceDigest = exactString(value.candidateSourceDigest, 'render-attestation.candidateSourceDigest', { nonEmpty: true, oneLine: true });
  if (!REPRESENTATION_DIGEST_RE.test(baselineSourceDigest)
    || !REPRESENTATION_DIGEST_RE.test(candidateSourceDigest)) {
    fail('invalid-source-digest', 'render attestation source digests must use RFC 9530 sha-256 representation syntax');
  }
  const baselineSiteDir = exactString(value.baselineSiteDir, 'render-attestation.baselineSiteDir', { nonEmpty: true, oneLine: true });
  const candidateSiteDir = exactString(value.candidateSiteDir, 'render-attestation.candidateSiteDir', { nonEmpty: true, oneLine: true });
  if (!path.isAbsolute(baselineSiteDir) || !path.isAbsolute(candidateSiteDir)) {
    fail('invalid-static-output-path', 'render attestation output directories must be absolute paths');
  }
  if (value.builtFromPreparedSnapshots !== true || value.builtInIsolatedWorkspaces !== true) {
    fail('render-attestation-required', 'the owner must attest that both isolated builds used the prepared exact-byte snapshots');
  }
  return deepFreeze({
    schemaVersion: 1,
    attemptId: exactAttemptId(value.attemptId),
    mechanicalCaseId,
    baselineSourceDigest,
    candidateSourceDigest,
    rendererProfile: exactString(value.rendererProfile, 'render-attestation.rendererProfile', { nonEmpty: true, oneLine: true }),
    buildCommand: exactString(value.buildCommand, 'render-attestation.buildCommand', { nonEmpty: true }),
    baselineSiteDir,
    candidateSiteDir,
    builtFromPreparedSnapshots: true,
    builtInIsolatedWorkspaces: true,
    ownerConfirmedAt: exactIsoDate(value.ownerConfirmedAt, 'render-attestation.ownerConfirmedAt'),
  });
}

export function renderAttestationTemplate({ attemptId, mechanicalCaseId, baselineSourceDigest, candidateSourceDigest, renderer }) {
  return {
    schemaVersion: 1,
    attemptId: exactAttemptId(attemptId),
    mechanicalCaseId,
    baselineSourceDigest,
    candidateSourceDigest,
    rendererProfile: renderer.profile,
    buildCommand: renderer.buildCommand,
    baselineSiteDir: '',
    candidateSiteDir: '',
    builtFromPreparedSnapshots: false,
    builtInIsolatedWorkspaces: false,
    ownerConfirmedAt: '',
  };
}

function validateDogfoodContext(input, label) {
  const value = plainRecord(input, label);
  strictKeys(value, DOGFOOD_CONTEXT_KEYS, label);
  requiredKeys(value, DOGFOOD_CONTEXT_KEYS, label);
  if (value.signedIn !== null && typeof value.signedIn !== 'boolean') {
    fail('invalid-dogfood-signed-in', `${label}.signedIn must be boolean or null`);
  }
  return deepFreeze({
    device: exactString(value.device, `${label}.device`, { oneLine: true }),
    operatingSystem: exactString(value.operatingSystem, `${label}.operatingSystem`, { oneLine: true }),
    browser: exactString(value.browser, `${label}.browser`, { oneLine: true }),
    signedIn: value.signedIn,
  });
}

export function validateDogfoodObservation(input) {
  const value = plainRecord(input, 'dogfood-observation');
  strictKeys(value, DOGFOOD_OBSERVATION_KEYS, 'dogfood-observation');
  requiredKeys(value, DOGFOOD_OBSERVATION_KEYS, 'dogfood-observation');
  if (value.schemaVersion !== 1) {
    fail('invalid-schema-version', 'dogfood-observation.schemaVersion must be 1');
  }
  if (value.evidenceClass !== 'owner-self-dogfood') {
    fail('invalid-dogfood-evidence-class', 'dogfood-observation.evidenceClass must be owner-self-dogfood');
  }
  if (!Array.isArray(value.precommittedObligations)) {
    fail(
      'invalid-precommitted-obligations',
      'dogfood-observation.precommittedObligations must be an array',
    );
  }
  const precommittedObligations = value.precommittedObligations.map((item, index) => {
    const obligation = exactString(
      item,
      `dogfood-observation.precommittedObligations[${index}]`,
      { nonEmpty: true, oneLine: true },
    );
    if (!OWNER_DOGFOOD_OBLIGATIONS.includes(obligation)) {
      fail(
        'invalid-dogfood-obligation',
        `dogfood-observation precommitted obligation is not canonical: ${obligation}`,
      );
    }
    return obligation;
  });
  if (new Set(precommittedObligations).size !== precommittedObligations.length) {
    fail(
      'duplicate-dogfood-obligation',
      'dogfood-observation.precommittedObligations must be unique',
    );
  }
  if (!Array.isArray(value.manualInterventions)) {
    fail('invalid-manual-interventions', 'dogfood-observation.manualInterventions must be an array');
  }
  for (const field of [
    'sourceWritePerformed', 'publicDeploymentPerformed', 'liveVerificationPerformed',
  ]) {
    if (typeof value[field] !== 'boolean') {
      fail('invalid-boolean', `dogfood-observation.${field} must be boolean`);
    }
  }
  return deepFreeze({
    schemaVersion: 1,
    attemptId: exactAttemptId(value.attemptId),
    evidenceClass: 'owner-self-dogfood',
    precommittedObligations,
    scenario: exactString(value.scenario, 'dogfood-observation.scenario', { oneLine: true }),
    readerContext: validateDogfoodContext(value.readerContext, 'dogfood-observation.readerContext'),
    ownerContext: validateDogfoodContext(value.ownerContext, 'dogfood-observation.ownerContext'),
    roleSeparation: exactString(value.roleSeparation, 'dogfood-observation.roleSeparation', { nonEmpty: true }),
    startedAt: value.startedAt === ''
      ? ''
      : exactIsoDate(value.startedAt, 'dogfood-observation.startedAt'),
    completedAt: value.completedAt === ''
      ? ''
      : exactIsoDate(value.completedAt, 'dogfood-observation.completedAt'),
    manualInterventions: value.manualInterventions.map((item, index) => (
      exactString(item, `dogfood-observation.manualInterventions[${index}]`, { nonEmpty: true })
    )),
    sourceWritePerformed: value.sourceWritePerformed,
    publicDeploymentPerformed: value.publicDeploymentPerformed,
    liveVerificationPerformed: value.liveVerificationPerformed,
    notes: exactString(value.notes, 'dogfood-observation.notes'),
  });
}

export function validateDogfoodObservationSeriesBinding(observationInput, seriesInput) {
  const observation = validateDogfoodObservation(observationInput);
  const series = validateOwnerDogfoodSeriesCharter(seriesInput);
  const expectedObligations = OWNER_DOGFOOD_OBLIGATIONS.filter(
    (obligation) => series.obligationAssignments[obligation] === observation.attemptId,
  );
  if (expectedObligations.length === 0) {
    fail(
      'dogfood-observation-attempt-not-declared',
      'dogfood observation attempt is not declared in the owner self-dogfood series',
    );
  }
  if (
    observation.precommittedObligations.length !== expectedObligations.length
    || observation.precommittedObligations.some(
      (obligation, index) => obligation !== expectedObligations[index],
    )
  ) {
    fail(
      'dogfood-observation-obligation-mismatch',
      'dogfood observation obligations do not match the precommitted series assignment',
    );
  }
  if (expectedObligations.includes('signed-out-mobile-handoff')) {
    const planned = series.plannedSignedOutMobile;
    const reader = observation.readerContext;
    if (
      reader.device !== planned.device
      || reader.operatingSystem !== planned.operatingSystem
      || reader.browser !== planned.browser
      || reader.signedIn !== false
    ) {
      fail(
        'dogfood-observation-mobile-context-mismatch',
        'dogfood observation reader context does not match the precommitted signed-out mobile context',
      );
    }
  }
  return observation;
}

export function validateOwnerDecision(input) {
  const value = plainRecord(input, 'owner-decision');
  strictKeys(value, DECISION_KEYS, 'owner-decision');
  requiredKeys(value, DECISION_KEYS, 'owner-decision');
  if (value.schemaVersion !== 1) fail('invalid-schema-version', 'owner-decision.schemaVersion must be 1');
  const decision = exactString(value.decision, 'owner-decision.decision', { nonEmpty: true, oneLine: true });
  if (!['accept', 'reject', 'clarify'].includes(decision)) {
    fail('invalid-owner-decision', 'owner-decision.decision must be accept, reject, or clarify');
  }
  if (typeof value.reviewSeconds !== 'number' || !Number.isFinite(value.reviewSeconds) || value.reviewSeconds < 0) {
    fail('invalid-review-seconds', 'owner-decision.reviewSeconds must be a non-negative number');
  }
  const mechanicalCaseId = exactString(value.mechanicalCaseId, 'owner-decision.mechanicalCaseId', { nonEmpty: true, oneLine: true });
  const candidateDigest = exactString(value.candidateDigest, 'owner-decision.candidateDigest', { nonEmpty: true, oneLine: true });
  if (!CASE_ID_RE.test(mechanicalCaseId)) fail('invalid-mechanical-case-id', 'owner-decision.mechanicalCaseId is invalid');
  if (!REPRESENTATION_DIGEST_RE.test(candidateDigest)) fail('invalid-candidate-digest', 'owner-decision.candidateDigest is invalid');
  return deepFreeze({
    schemaVersion: 1,
    attemptId: exactAttemptId(value.attemptId),
    mechanicalCaseId,
    candidateDigest,
    decision,
    reason: exactString(value.reason, 'owner-decision.reason', { nonEmpty: true }),
    reviewSeconds: value.reviewSeconds,
    decidedAt: exactIsoDate(value.decidedAt, 'owner-decision.decidedAt'),
  });
}

export const FAIL_CLOSED_ANONYMOUS_POLICY = deepFreeze({
  trusted: [],
  agents: [],
  caps: { lines: 10, files: 1, proseWords: 25, typoLines: 4, typoWords: 4 },
  allowedNewFolders: [],
  frontmatterAllowlist: [],
});

export function operatorDefaults(attemptIdInput, profileInput) {
  const attemptId = exactAttemptId(attemptIdInput);
  const profile = validateProfile(profileInput);
  const cyberbaseProfile = profile === 'cyberbase-rehearsal' || profile === 'owner-self-dogfood';
  if (profile === 'owner-self-dogfood' && !attemptId.startsWith('OD-')) {
    fail('dogfood-attempt-id-required', 'owner-self-dogfood must use an OD-01 through OD-99 attempt ID');
  }
  if (profile !== 'owner-self-dogfood' && !attemptId.startsWith('HC-')) {
    fail('pilot-attempt-id-required', 'pilot and rehearsal profiles must use an HC-01 through HC-99 attempt ID');
  }
  return {
    schemaVersion: 1,
    attemptId,
    profile,
    repository: cyberbaseProfile ? 'https://github.com/cybersader/cyberbase' : '',
    checkoutDir: '',
    baseCommit: '',
    sourcePath: '',
    publicUrl: '',
    sourceAuthorizedForLocalProcessing: false,
    independentOwnerAttested: false,
    readerUnaided: false,
    accessInterruption: false,
    correctionKind: 'typo',
    selectorContext: {},
    ownerPolicyRevision: cyberbaseProfile
      ? `${profile}-anonymous-full-review-v1`
      : '',
    ownerPolicy: JSON.parse(JSON.stringify(FAIL_CLOSED_ANONYMOUS_POLICY)),
    publicationBoundary: cyberbaseProfile ? 'cyberbaser' : 'not-applicable',
    renderer: {
      profile: cyberbaseProfile ? 'cyberbase-quartz-v4.5.2' : 'owner-static-output',
      basePath: cyberbaseProfile ? 'cyberbase' : '',
      buildCommand: cyberbaseProfile
        ? 'renderers/quartz-cyberbase/build.sh <content-dir> <quartz-dir>'
        : '',
    },
  };
}

export function ownerDecisionTemplate(attemptIdInput, binding = {}) {
  return {
    schemaVersion: 1,
    attemptId: exactAttemptId(attemptIdInput),
    mechanicalCaseId: binding.mechanicalCaseId ?? '',
    candidateDigest: binding.candidateDigest ?? '',
    decision: '',
    reason: '',
    reviewSeconds: null,
    decidedAt: '',
  };
}
