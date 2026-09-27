// The owner application event: the second, explicit owner act that puts an
// approved suggestion on the page.
//
// Approve records intent and nothing else. This module is what happens when
// the owner later says "apply it": it re-checks that the page is still the
// exact object the owner reviewed, refuses anything the owner pipeline cannot
// apply, records one create-once event, and starts one ordinary owner-alpha
// Save job with a supplied edit session and source operation. The job is the
// only thing that writes source, commits, pushes, deploys, verifies, or
// rebuilds, through the same durable pipeline an owner's own Save uses. No
// second writer exists here, and nothing in this module applies bytes.

import { readdir, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { digestBytes, validateQueueId } from '@cyberbaser/proposal-queue';
import { createJsonArtifactOnce, readJsonArtifact } from './artifacts.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { withFileLock } from './flock.js';
import { artifactJson, deepFreeze, isPlainObject } from './json.js';
import { loadDurableJob, validateJobId } from './job-state.js';
import {
  applyEditorOperation,
  SOURCE_OPERATION_ARTIFACT_TYPE,
  SOURCE_OPERATION_SCHEMA_VERSION,
} from './operation.js';
import { pipelineArtifactPaths } from './pipeline.js';
import {
  assessApprovedProposal,
  decisionDigest,
  prepareApprovedProposalInput,
  readApprovedProposalInput,
  validateApprovedProposalInput,
} from './approved-proposal.js';
import { assertPrivateDirectory, readPrivateFile, recoverProposalDecisions } from './proposal-decisions.js';
import { defaultProposalReviewGit, readBlob } from './proposal-review.js';
import {
  assertCheckoutReady,
  detectYamlFrontmatterRange,
  EDIT_SESSION_ARTIFACT_TYPE,
  EDIT_SESSION_SCHEMA_VERSION,
  liveUrlForSlug,
  pathMatchesPolicy,
} from './source.js';
import {
  assertNoSymlinkComponents,
  prepareStore,
  prepareStoreParent,
  resolveStorePath,
} from './store.js';

export const PROPOSAL_APPLICATION_SCHEMA_VERSION = 1;
export const PROPOSAL_APPLICATION_ARTIFACT_TYPE = 'owner-alpha-proposal-application-event';
export const PROPOSAL_APPLICATION_ROOT = 'proposal-applications';
export const PROPOSAL_APPLICATION_LOCK = `${PROPOSAL_APPLICATION_ROOT}/.application.lock`;
export const PROPOSAL_APPLICATION_MAX_BYTES = 1024 * 1024;
export const PROPOSAL_APPLICATION_MAX_ATTEMPTS = 20;
/** Why the owner pipeline cannot apply an otherwise eligible suggestion. */
export const PROPOSAL_APPLICATION_UNAPPLICABLE_REASONS = Object.freeze([
  'path-not-editable',
  'page-not-rendered',
  'source-not-lf-only',
  'source-too-large',
  'frontmatter-change',
  'changed-bytes-limit',
  'replacement-limit',
  'changed-lines-limit',
]);
/** The states the receipt shows. */
export const PROPOSAL_APPLICATION_STATES = Object.freeze([
  'not-decided',
  'rejected',
  'stale',
  'unapplicable',
  'eligible',
  'applied',
]);

const EVENT_FILE_RE = /^(Q-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([1-9][0-9]*)\.json$/u;
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u;
const MAX_RENDERED_PAGE_BYTES = 8 * 1024 * 1024;
/** Job states that ended without any durable source effect being possible. */
const PRE_EFFECT_TERMINAL_STATES = new Set(['blocked-pre-apply', 'cancelled', 'failed']);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function exactObject(value, keys, label) {
  if (!isPlainObject(value)) fail('invalid-application-event', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalid-application-event', `${label} has an unexpected shape`, { expected, actual });
  }
  return value;
}

function exactString(value, label, maximum = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    fail('invalid-application-event', `${label} must be a non-empty exact string`);
  }
  return value;
}

function exactInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid-application-event', `${label} must be a non-negative integer`);
  return value;
}

function digestField(value, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail('invalid-application-event', `${label} must be one sha-256 structured digest`);
  return value;
}

function utcSecond(value, label) {
  if (typeof value !== 'string' || !UTC_SECOND_RE.test(value) || Number.isNaN(Date.parse(value))) {
    fail('invalid-application-event', `${label} must be a UTC second timestamp`);
  }
  return value;
}

/** Validate one stored application event. The shape is closed. */
export function validateProposalApplicationEvent(value) {
  exactObject(value, [
    'schemaVersion', 'artifactType', 'queueId', 'attempt', 'appliedAt',
    'authority', 'input', 'decision', 'source', 'candidate', 'policyRevision', 'job',
  ], 'application event');
  if (value.schemaVersion !== PROPOSAL_APPLICATION_SCHEMA_VERSION) fail('invalid-application-event', 'unsupported schemaVersion');
  if (value.artifactType !== PROPOSAL_APPLICATION_ARTIFACT_TYPE) fail('invalid-application-event', 'unsupported artifactType');
  let queueId;
  try {
    queueId = validateQueueId(value.queueId);
  } catch (error) {
    fail('invalid-application-event', 'queueId is invalid', { cause: error?.code ?? 'unknown' });
  }
  const attempt = exactInteger(value.attempt, 'attempt');
  if (attempt < 1 || attempt > PROPOSAL_APPLICATION_MAX_ATTEMPTS) fail('invalid-application-event', 'attempt is out of range');
  exactObject(value.authority, ['type', 'identity'], 'authority');
  if (value.authority.type !== 'owner-alpha-local') fail('invalid-application-event', 'authority.type is unsupported');
  exactObject(value.input, ['digest', 'preparedAt'], 'input');
  exactObject(value.decision, ['digest', 'decidedAt', 'reviewEvidenceDigest'], 'decision');
  exactObject(value.source, [
    'repository', 'path', 'revision', 'branch', 'branchTip', 'gitObjectId', 'gitMode', 'baseDigest', 'slug', 'liveUrl',
  ], 'source');
  if (!GIT_OBJECT_ID_RE.test(value.source.revision) || !COMMIT_RE.test(value.source.branchTip)
    || !GIT_OBJECT_ID_RE.test(value.source.gitObjectId) || !['100644', '100755'].includes(value.source.gitMode)) {
    fail('invalid-application-event', 'source Git identity is invalid');
  }
  exactObject(value.candidate, ['byteLength', 'digest'], 'candidate');
  exactObject(value.job, ['jobId'], 'job');
  if (typeof value.policyRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.policyRevision)) {
    fail('invalid-application-event', 'policyRevision is invalid');
  }
  let jobId;
  try {
    jobId = validateJobId(value.job.jobId);
  } catch (error) {
    fail('invalid-application-event', 'job.jobId is invalid', { cause: error?.code ?? 'unknown' });
  }
  return deepFreeze({
    schemaVersion: PROPOSAL_APPLICATION_SCHEMA_VERSION,
    artifactType: PROPOSAL_APPLICATION_ARTIFACT_TYPE,
    queueId,
    attempt,
    appliedAt: utcSecond(value.appliedAt, 'appliedAt'),
    authority: { type: 'owner-alpha-local', identity: exactString(value.authority.identity, 'authority.identity', 256) },
    input: { digest: digestField(value.input.digest, 'input.digest'), preparedAt: utcSecond(value.input.preparedAt, 'input.preparedAt') },
    decision: {
      digest: digestField(value.decision.digest, 'decision.digest'),
      decidedAt: utcSecond(value.decision.decidedAt, 'decision.decidedAt'),
      reviewEvidenceDigest: digestField(value.decision.reviewEvidenceDigest, 'decision.reviewEvidenceDigest'),
    },
    source: {
      repository: exactString(value.source.repository, 'source.repository'),
      path: exactString(value.source.path, 'source.path'),
      revision: value.source.revision,
      branch: exactString(value.source.branch, 'source.branch', 255),
      branchTip: value.source.branchTip,
      gitObjectId: value.source.gitObjectId,
      gitMode: value.source.gitMode,
      baseDigest: digestField(value.source.baseDigest, 'source.baseDigest'),
      slug: exactString(value.source.slug, 'source.slug'),
      liveUrl: exactString(value.source.liveUrl, 'source.liveUrl'),
    },
    candidate: {
      byteLength: exactInteger(value.candidate.byteLength, 'candidate.byteLength'),
      digest: digestField(value.candidate.digest, 'candidate.digest'),
    },
    policyRevision: value.policyRevision,
    job: { jobId },
  });
}

function eventPath(queueId, attempt) {
  return `${PROPOSAL_APPLICATION_ROOT}/${queueId}.${attempt}.json`;
}

async function prepareEventLayout(context) {
  await prepareStore(context);
  const root = resolveStorePath(context, PROPOSAL_APPLICATION_ROOT);
  await prepareStoreParent(context, resolveStorePath(context, `${PROPOSAL_APPLICATION_ROOT}/.layout`));
  await assertNoSymlinkComponents(context, root);
  await assertPrivateDirectory(root, 'proposal application root');
  return root;
}

async function readEvent(context, queueId, attempt) {
  const bytes = await readPrivateFile(
    resolveStorePath(context, eventPath(queueId, attempt)),
    `${queueId}.${attempt}.json`,
    PROPOSAL_APPLICATION_MAX_BYTES,
  );
  if (bytes === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('invalid-application-event', `${queueId}.${attempt}.json is not strict JSON`);
  }
  const event = validateProposalApplicationEvent(parsed);
  if (event.queueId !== queueId || event.attempt !== attempt) {
    fail('invalid-application-event', 'application event filename does not match its contents');
  }
  return event;
}

async function readEventsUnlocked(context, queueIdFilter = null) {
  const root = await prepareEventLayout(context);
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const events = [];
  for (const entry of entries) {
    if (entry.name === '.application.lock') continue;
    const match = entry.name.match(EVENT_FILE_RE);
    if (!match || entry.isSymbolicLink() || !entry.isFile()) {
      fail('unsafe-application-entry', 'proposal application root contains an unexpected entry', { entry: entry.name });
    }
    if (queueIdFilter !== null && match[1] !== queueIdFilter) continue;
    const event = await readEvent(context, match[1], Number(match[2]));
    if (event !== null) events.push(event);
  }
  events.sort((left, right) => left.queueId.localeCompare(right.queueId) || left.attempt - right.attempt);
  return events;
}

/** List every recorded application event, optionally for one suggestion. */
export async function listProposalApplicationEvents(context, { queueId = null } = {}) {
  if (!context) fail('invalid-application-dependency', 'listing application events requires a store context');
  const filter = queueId === null ? null : validateQueueId(queueId);
  return withFileLock(context, PROPOSAL_APPLICATION_LOCK, async () => Object.freeze(await readEventsUnlocked(context, filter)));
}

export function proposalApplicationEventPath(context, queueId, attempt) {
  return resolveStorePath(context, eventPath(validateQueueId(queueId), exactInteger(attempt, 'attempt')));
}

/**
 * Find the slug the rendered owner site gave one source path. The site is
 * built in owner edit-link mode, so every source-backed page carries one
 * `/owner/edit?relativePath=…&slug=…` link; that link is the renderer's own
 * statement of the page's slug, and this reads it back rather than guessing
 * the renderer's slug rules. Read-only. Returns null when no rendered page
 * claims the path.
 */
export async function resolveRenderedPageSlug({ siteRoot, ownerOrigin, relativePath, maxPageBytes = MAX_RENDERED_PAGE_BYTES } = {}) {
  if (typeof siteRoot !== 'string' || typeof ownerOrigin !== 'string' || typeof relativePath !== 'string') {
    fail('invalid-application-dependency', 'rendered slug resolution requires siteRoot, ownerOrigin, and relativePath');
  }
  const prefix = `${ownerOrigin}/owner/edit?relativePath=${encodeURIComponent(relativePath)}`;
  const needles = [`${prefix}&amp;slug=`, `${prefix}&slug=`];
  let found = null;
  const pending = [siteRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' && directory === siteRoot) return null;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!entry.isFile() || !/\.html?$/iu.test(entry.name)) continue;
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.size > maxPageBytes) continue;
      const text = (await readFile(file)).toString('utf8');
      for (const needle of needles) {
        let index = text.indexOf(needle);
        while (index !== -1) {
          const start = index + needle.length;
          const end = text.slice(start).search(/["'&\s<>]/u);
          const encoded = end === -1 ? text.slice(start) : text.slice(start, start + end);
          let slug;
          try {
            slug = decodeURIComponent(encoded);
          } catch {
            fail('page-slug-ambiguous', 'a rendered page carries an undecodable owner edit link', { path: relativePath });
          }
          if (found !== null && found !== slug) {
            fail('page-slug-ambiguous', 'rendered pages disagree about the slug for this source path', { path: relativePath });
          }
          found = slug;
          index = text.indexOf(needle, start);
        }
      }
    }
  }
  return found;
}

function unapplicable(reason, details = {}) {
  return deepFreeze({ applicable: false, reason, details, session: null, operation: null });
}

function lineCount(bytes) {
  if (bytes.length === 0) return 0;
  let count = 1;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count;
}

/**
 * Turn one prepared input plus the exact blob it names into the edit session
 * and source operation the owner pipeline binds. Pure apart from the inputs.
 * Returns `{ applicable, reason, session, operation }`; an unapplicable result
 * names the pipeline rule the suggestion would break.
 */
export function deriveProposalApplication({ config: configInput, input: inputValue, baseBytes, branchTip, slug }) {
  const config = validateOwnerAlphaConfig(configInput);
  const input = validateApprovedProposalInput(inputValue);
  if (!Buffer.isBuffer(baseBytes)) fail('invalid-application-dependency', 'baseBytes must be a Buffer');
  if (typeof branchTip !== 'string' || !COMMIT_RE.test(branchTip)) fail('invalid-application-dependency', 'branchTip must be one commit ID');
  if (baseBytes.length !== input.source.baseByteLength || digestBytes(baseBytes) !== input.source.baseDigest) {
    fail('application-base-mismatch', 'the blob does not match the prepared input');
  }
  try {
    pathMatchesPolicy(input.source.path, config.paths);
  } catch (error) {
    if (error instanceof OwnerAlphaError) return unapplicable('path-not-editable', { code: error.code });
    throw error;
  }
  if (slug === null || slug === undefined) return unapplicable('page-not-rendered');
  if (typeof slug !== 'string' || slug.length === 0) fail('invalid-application-dependency', 'slug must be a rendered page slug or null');
  if (baseBytes.length > config.limits.maxSourceBytes) return unapplicable('source-too-large');
  let text;
  try {
    text = UTF8_DECODER.decode(baseBytes);
  } catch {
    return unapplicable('source-not-lf-only', { code: 'source-invalid-utf8' });
  }
  if (text.includes('\r')) return unapplicable('source-not-lf-only');

  const expectedOld = Buffer.from(input.operation.expectedOldBytesBase64, 'base64');
  const replacement = Buffer.from(input.operation.replacementBytesBase64, 'base64');
  const changedBytes = Math.max(expectedOld.length, replacement.length);
  const changedLines = Math.max(lineCount(expectedOld), lineCount(replacement));
  if (replacement.length > config.limits.maxReplacementBytes) return unapplicable('replacement-limit', { limit: config.limits.maxReplacementBytes });
  if (changedBytes > config.limits.maxChangedBytes) return unapplicable('changed-bytes-limit', { limit: config.limits.maxChangedBytes });
  if (changedLines > config.limits.maxChangedLines) return unapplicable('changed-lines-limit', { limit: config.limits.maxChangedLines });

  const frontmatter = detectYamlFrontmatterRange(baseBytes);
  const policyRevision = computePolicyRevision(config);
  const liveUrl = liveUrlForSlug(config.live.baseUrl, slug);
  const session = deepFreeze({
    schemaVersion: EDIT_SESSION_SCHEMA_VERSION,
    artifactType: EDIT_SESSION_ARTIFACT_TYPE,
    relativePath: input.source.path,
    slug,
    liveUrl,
    baseCommit: branchTip,
    policyRevision,
    source: {
      text,
      bytesBase64: baseBytes.toString('base64'),
      byteLength: baseBytes.length,
      digest: input.source.baseDigest,
      gitMode: input.source.gitMode,
      gitObjectId: input.source.gitObjectId,
      frontmatter,
    },
    origin: {
      type: 'approved-proposal',
      queueId: input.queueId,
      proposalId: input.proposal.proposalId,
      inputDigest: digestBytes(Buffer.from(artifactJson(input), 'utf8')),
    },
  });
  const operation = deepFreeze({
    schemaVersion: SOURCE_OPERATION_SCHEMA_VERSION,
    artifactType: SOURCE_OPERATION_ARTIFACT_TYPE,
    source: {
      relativePath: session.relativePath,
      slug,
      liveUrl,
      baseCommit: branchTip,
      policyRevision,
    },
    operationType: 'offset',
    baseByteLength: baseBytes.length,
    baseDigest: input.source.baseDigest,
    start: input.operation.start,
    end: input.operation.end,
    expectedOldBytesBase64: input.operation.expectedOldBytesBase64,
    replacementBytesBase64: input.operation.replacementBytesBase64,
    candidateByteLength: input.candidate.byteLength,
    candidateDigest: input.candidate.digest,
    changedBytes,
    changedLines,
    frontmatter,
    outsideBytesUnchanged: true,
  });
  let candidate;
  try {
    candidate = applyEditorOperation(session, operation);
  } catch (error) {
    if (error instanceof OwnerAlphaError && error.code === 'frontmatter-edit-rejected') return unapplicable('frontmatter-change');
    if (error instanceof OwnerAlphaError && ['candidate-not-lf-only', 'source-not-lf-only'].includes(error.code)) {
      return unapplicable('source-not-lf-only', { code: error.code });
    }
    throw error;
  }
  if (candidate.length !== input.candidate.byteLength || digestBytes(candidate) !== input.candidate.digest) {
    fail('application-candidate-mismatch', 'the derived operation did not reproduce the reviewed candidate');
  }
  return deepFreeze({ applicable: true, reason: null, details: {}, session, operation });
}

async function jobEffect(context, config, jobId) {
  let job = null;
  try {
    job = await loadDurableJob(context, jobId, { maxBytes: config.limits.maxArtifactBytes });
  } catch (error) {
    if (!(error instanceof OwnerAlphaError) || !['artifact-not-found', 'job-not-found'].includes(error.code)) throw error;
  }
  if (job === null) return { jobState: null, retryable: true };
  let sourceApplied = false;
  try {
    await readJsonArtifact(context, pipelineArtifactPaths(jobId).sourceApplied, { maxBytes: config.limits.maxArtifactBytes });
    sourceApplied = true;
  } catch (error) {
    if (!(error instanceof OwnerAlphaError) || error.code !== 'artifact-not-found') throw error;
  }
  return {
    jobState: job.state,
    failure: job.failure?.code ?? null,
    retryable: PRE_EFFECT_TERMINAL_STATES.has(job.state) && !sourceApplied,
  };
}

function statusResult(fields) {
  return deepFreeze({
    queueId: fields.queueId,
    state: fields.state,
    reason: fields.reason ?? null,
    details: fields.details ?? {},
    branchTip: fields.branchTip ?? null,
    input: fields.input ?? null,
    attempts: fields.attempts ?? [],
    latest: fields.latest ?? null,
  });
}

async function evaluateUnlocked({ context, config, queueId, git, resolveSlug, prepare }) {
  const recovered = await recoverProposalDecisions(context);
  const decision = recovered.decisions.find((item) => item.queueId === queueId) ?? null;
  if (decision === null) return { status: statusResult({ queueId, state: 'not-decided' }) };
  if (decision.action !== 'approve') return { status: statusResult({ queueId, state: 'rejected' }) };

  const events = await readEventsUnlocked(context, queueId);
  const attempts = [];
  for (const event of events) {
    const effect = await jobEffect(context, config, event.job.jobId);
    attempts.push(deepFreeze({
      attempt: event.attempt,
      appliedAt: event.appliedAt,
      jobId: event.job.jobId,
      jobState: effect.jobState,
      failure: effect.failure ?? null,
      retryable: effect.retryable,
    }));
  }
  const latest = attempts.at(-1) ?? null;
  if (latest !== null && !latest.retryable) {
    return { status: statusResult({ queueId, state: 'applied', attempts, latest }) };
  }
  if (attempts.length >= PROPOSAL_APPLICATION_MAX_ATTEMPTS) {
    return { status: statusResult({ queueId, state: 'unapplicable', reason: 'attempt-limit', attempts, latest }) };
  }

  let storedInput = null;
  if (prepare) {
    const prepared = await prepareApprovedProposalInput({ context, config, queueId, git });
    if (!prepared.prepared) {
      return { status: statusResult({ queueId, state: 'stale', reason: prepared.eligibility.reason, branchTip: prepared.eligibility.branchTip, attempts, latest }) };
    }
    storedInput = prepared.input;
  } else {
    storedInput = await readApprovedProposalInput(context, queueId);
  }
  const assessment = await assessApprovedProposal({ config, decision, git });
  const inputSummary = storedInput === null ? null : { preparedAt: storedInput.preparedAt, branchTip: storedInput.source.branchTip };
  if (!assessment.eligible) {
    return { status: statusResult({ queueId, state: 'stale', reason: assessment.reason, branchTip: assessment.branchTip, input: inputSummary, attempts, latest }) };
  }
  // Assessment without a prepared input derives from an in-memory preview of
  // the input the adapter would write, so the receipt can already say whether
  // the pipeline could apply this suggestion. Nothing is written.
  const input = storedInput ?? previewInput(decision, assessment, config);
  const slug = await resolveSlug(input.source.path);
  const baseBytes = await readBlob(git, config.repository.checkout, assessment.source.gitObjectId, 'approved source blob', config.limits.maxSourceBytes);
  const derived = deriveProposalApplication({ config, input, baseBytes, branchTip: assessment.branchTip, slug });
  if (!derived.applicable) {
    return { status: statusResult({ queueId, state: 'unapplicable', reason: derived.reason, details: derived.details, branchTip: assessment.branchTip, input: inputSummary, attempts, latest }) };
  }
  return {
    status: statusResult({ queueId, state: 'eligible', branchTip: assessment.branchTip, input: inputSummary, attempts, latest }),
    decision,
    input,
    assessment,
    derived,
  };
}

function defaultSlugResolver({ siteRoot, ownerOrigin }) {
  if (typeof siteRoot !== 'string' || typeof ownerOrigin !== 'string') {
    fail('invalid-application-dependency', 'proposal application needs siteRoot and ownerOrigin, or an explicit resolveSlug');
  }
  return (relativePath) => resolveRenderedPageSlug({ siteRoot, ownerOrigin, relativePath });
}

function applicationTime(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('invalid-application-clock', 'application clock is invalid');
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/**
 * Report where one suggestion stands on the way to the page, without writing
 * anything: not decided, rejected, stale, unapplicable, eligible, or applied.
 * Eligibility is checked afresh against the current branch tip each time.
 */
export async function assessProposalApplication({
  context,
  config: configInput,
  queueId: queueIdInput,
  git = defaultProposalReviewGit,
  resolveSlug = null,
  siteRoot = null,
  ownerOrigin = null,
} = {}) {
  if (!context) fail('invalid-application-dependency', 'proposal application assessment requires a store context');
  const config = validateOwnerAlphaConfig(configInput);
  const queueId = validateQueueId(queueIdInput);
  const slugResolver = resolveSlug ?? defaultSlugResolver({ siteRoot, ownerOrigin });
  return withFileLock(context, PROPOSAL_APPLICATION_LOCK, async () => (
    (await evaluateUnlocked({ context, config, queueId, git, resolveSlug: slugResolver, prepare: false })).status
  ));
}

// A not-yet-written input has the same content the adapter would write; build
// it in memory so assessment can run the same derivation without touching disk.
function previewInput(decision, assessment, config) {
  const evidence = decision.reviewEvidence;
  const { proposal } = evidence;
  return validateApprovedProposalInput({
    schemaVersion: 1,
    artifactType: 'owner-alpha-approved-proposal-input',
    queueId: decision.queueId,
    preparedAt: '1970-01-01T00:00:00Z',
    decision: {
      digest: decisionDigest(decision),
      decidedAt: decision.decidedAt,
      reviewEvidenceDigest: decision.reviewEvidenceDigest,
      authority: { type: decision.decisionAuthority.type, identity: decision.decisionAuthority.identity },
    },
    proposal: {
      proposalId: proposal.proposalId,
      proposalDigest: evidence.receipt.proposalDigest,
      lane: evidence.receipt.lane,
      tier: evidence.classification.classification.tier,
      route: evidence.classification.classification.route,
    },
    source: {
      repository: proposal.source.repository,
      path: proposal.source.path,
      revision: proposal.source.revision,
      branch: config.repository.branch,
      branchTip: assessment.branchTip,
      gitMode: assessment.source.gitMode,
      gitObjectId: assessment.source.gitObjectId,
      baseByteLength: assessment.source.baseByteLength,
      baseDigest: proposal.operation.baseDigest,
    },
    operation: {
      type: proposal.operation.type,
      start: proposal.operation.start,
      end: proposal.operation.end,
      expectedOldBytesBase64: proposal.operation.expectedOldBytesBase64,
      replacementBytesBase64: proposal.operation.replacementBytesBase64,
    },
    candidate: assessment.candidate,
    trustPolicy: assessment.trustPolicy,
    applicationGate: { state: 'not-authorized', event: null, note: 'In-memory preview for assessment; never written.' },
    effectBoundary: { appliesSource: false, writesSource: false, commits: false, pushes: false, deploys: false, publishes: false, rebuilds: false },
  });
}

/**
 * The owner application event. Prepares the input if it is missing, re-checks
 * eligibility and applicability, requires the checkout to sit exactly at the
 * branch tip it saw, records one create-once event, and starts one ordinary
 * owner-alpha Save job through `saveEdit`. Returns `{ applied, status, event, job }`.
 */
export async function applyApprovedProposal({
  context,
  config: configInput,
  queueId: queueIdInput,
  saveEdit,
  createJobId,
  checkoutReady = (config) => assertCheckoutReady(config),
  git = defaultProposalReviewGit,
  resolveSlug = null,
  siteRoot = null,
  ownerOrigin = null,
  clock = () => new Date(),
} = {}) {
  if (!context) fail('invalid-application-dependency', 'proposal application requires a store context');
  if (typeof saveEdit !== 'function' || typeof createJobId !== 'function' || typeof checkoutReady !== 'function') {
    fail('invalid-application-dependency', 'proposal application requires saveEdit, createJobId, and checkoutReady');
  }
  const config = validateOwnerAlphaConfig(configInput);
  const queueId = validateQueueId(queueIdInput);
  const slugResolver = resolveSlug ?? defaultSlugResolver({ siteRoot, ownerOrigin });
  return withFileLock(context, PROPOSAL_APPLICATION_LOCK, async () => {
    const evaluated = await evaluateUnlocked({ context, config, queueId, git, resolveSlug: slugResolver, prepare: true });
    if (evaluated.status.state !== 'eligible') {
      return deepFreeze({ applied: false, status: evaluated.status, event: null, job: null });
    }
    const { input, decision, assessment, derived } = evaluated;
    const checkout = await checkoutReady(config);
    if (checkout.head !== assessment.branchTip) {
      return deepFreeze({
        applied: false,
        status: statusResult({ ...evaluated.status, state: 'stale', reason: 'checkout-moved', branchTip: checkout.head }),
        event: null,
        job: null,
      });
    }
    const attempt = (evaluated.status.attempts.at(-1)?.attempt ?? 0) + 1;
    const jobId = validateJobId(createJobId());
    const event = validateProposalApplicationEvent({
      schemaVersion: PROPOSAL_APPLICATION_SCHEMA_VERSION,
      artifactType: PROPOSAL_APPLICATION_ARTIFACT_TYPE,
      queueId,
      attempt,
      appliedAt: applicationTime(clock),
      authority: { type: 'owner-alpha-local', identity: config.owner.identity },
      input: { digest: derived.session.origin.inputDigest, preparedAt: input.preparedAt },
      decision: { digest: input.decision.digest, decidedAt: decision.decidedAt, reviewEvidenceDigest: decision.reviewEvidenceDigest },
      source: {
        repository: input.source.repository,
        path: input.source.path,
        revision: input.source.revision,
        branch: config.repository.branch,
        branchTip: assessment.branchTip,
        gitObjectId: assessment.source.gitObjectId,
        gitMode: assessment.source.gitMode,
        baseDigest: input.source.baseDigest,
        slug: derived.session.slug,
        liveUrl: derived.session.liveUrl,
      },
      candidate: assessment.candidate,
      policyRevision: derived.session.policyRevision,
      job: { jobId },
    });
    await createJsonArtifactOnce(context, eventPath(queueId, attempt), event, { maxBytes: PROPOSAL_APPLICATION_MAX_BYTES });
    // The event is recorded before the job starts. If the start fails, the
    // event names a job that never existed, and the next attempt is allowed.
    const job = await saveEdit({ jobId, session: derived.session, operation: derived.operation });
    if (!job || job.jobId !== jobId) fail('invalid-application-acceptance', 'the pipeline did not accept the application job it was given');
    const status = statusResult({
      ...evaluated.status,
      state: 'applied',
      attempts: [...evaluated.status.attempts, { attempt, appliedAt: event.appliedAt, jobId, jobState: job.state ?? 'accepted', failure: null, retryable: false }],
      latest: { attempt, appliedAt: event.appliedAt, jobId, jobState: job.state ?? 'accepted', failure: null, retryable: false },
    });
    return deepFreeze({ applied: true, status, event, job: { jobId, state: job.state ?? 'accepted' } });
  });
}
