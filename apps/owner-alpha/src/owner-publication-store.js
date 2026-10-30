import { createHash } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { createJsonArtifactOnce } from './artifacts.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail } from './errors.js';
import { withFileLock } from './flock.js';
import { JOB_STATES, validateJobId } from './job-state.js';
import { artifactJson, canonicalJson, deepFreeze, isPlainObject } from './json.js';
import { prepareOwnerPublication, revalidateOwnerPublicationSource } from './owner-publication.js';
import { assertPrivateDirectory, readPrivateFile } from './proposal-decisions.js';
import { assertSafeStoreTarget, defineStoreContext, prepareStore, prepareStoreParent, resolveStorePath } from './store.js';

export const OWNER_PUBLICATION_DRAFT_ROOT = 'owner-publication';
export const OWNER_PUBLICATION_DRAFT_LIMIT = 64;
export const OWNER_PUBLICATION_DRAFT_LOCK = `${OWNER_PUBLICATION_DRAFT_ROOT}/.draft.lock`;
export const OWNER_PUBLICATION_PUBLISH_LOCK = `${OWNER_PUBLICATION_DRAFT_ROOT}/.publish.lock`;
const DRAFT_TYPE = 'owner-alpha-publication-draft';
const AUTHORIZATION_TYPE = 'owner-alpha-publication-authorization';
const MAX_BYTES = 8 * 1024 * 1024;
const queues = new Map();

function exact(value, keys, code = 'invalid-publication-artifact') {
  if (!isPlainObject(value) || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    fail(code, 'owner publication value must contain exactly its declared fields');
  }
}

function required(action) {
  if (typeof action !== 'function') fail('publication-dependency-required', 'owner publication requires all declared injected functions');
}

function sameJson(left, right, code) {
  try { return canonicalJson(left) === canonicalJson(right); } catch {
    fail(code, 'publication handoff requires exact JSON evidence');
  }
}

function hash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function id(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    fail('invalid-publication-draft-id', 'draft id must be one full lowercase SHA-256 identifier');
  }
  return value;
}

function paths(draftId) {
  const key = id(draftId);
  return {
    draft: `${OWNER_PUBLICATION_DRAFT_ROOT}/drafts/${key}.json`,
    authorization: `${OWNER_PUBLICATION_DRAFT_ROOT}/authorizations/${key}.json`,
  };
}

function jobIdFor(draftId) {
  return validateJobId(`OA-PUB-${id(draftId)}`);
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length !== 24) fail('invalid-publication-clock', 'publication timestamp must be exact UTC ISO-8601');
  try {
    if (new Date(value).toISOString() === value) return value;
  } catch { /* Refuse without returning clock contents. */ }
  fail('invalid-publication-clock', 'publication timestamp must be exact UTC ISO-8601');
}

function now(clock) {
  try {
    const value = clock();
    return timestamp(value instanceof Date ? value.toISOString() : value);
  } catch {
    fail('invalid-publication-clock', 'publication clock did not return an exact UTC timestamp');
  }
}

function inputs(configInput, contextInput) {
  const config = validateOwnerAlphaConfig(configInput);
  exact(contextInput, ['projectRoot', 'workspaceRoot', 'storeRoot'], 'invalid-publication-context');
  const context = defineStoreContext(contextInput);
  if (context.workspaceRoot !== path.resolve(context.projectRoot, config.workspace.root)
    || context.storeRoot !== path.resolve(context.projectRoot, config.workspace.store)) {
    fail('invalid-publication-context', 'publication store must match the configured private workspace');
  }
  return { config, context, maximum: Math.min(config.limits.maxArtifactBytes, MAX_BYTES) };
}

async function layout(context) {
  await prepareStore(context);
  for (const directory of [context.workspaceRoot, context.storeRoot]) {
    await assertPrivateDirectory(directory, 'publication workspace');
  }
  for (const directory of [OWNER_PUBLICATION_DRAFT_ROOT, `${OWNER_PUBLICATION_DRAFT_ROOT}/drafts`, `${OWNER_PUBLICATION_DRAFT_ROOT}/authorizations`]) {
    const target = resolveStorePath(context, `${directory}/.layout`);
    await prepareStoreParent(context, target);
    await assertPrivateDirectory(path.dirname(target), 'publication directory');
  }
}

async function locked(context, lockPath, action) {
  // Queue same-process callers; flock also excludes other processes. Cross-process
  // contention refuses lock-busy rather than assuming absence or retrying effects.
  const key = resolveStorePath(context, lockPath);
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  queues.set(key, turn);
  await previous;
  try {
    return await withFileLock(context, lockPath, action);
  } finally {
    release();
    if (queues.get(key) === turn) queues.delete(key);
  }
}

async function readArtifact(context, relativePath, maximum) {
  const file = resolveStorePath(context, relativePath);
  await assertSafeStoreTarget(context, file);
  const bytes = await readPrivateFile(file, 'owner publication artifact', maximum);
  if (bytes === undefined) return null;
  if (bytes.length > maximum) fail('publication-artifact-too-large', 'publication artifact grew beyond its read limit');
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!bytes.equals(Buffer.from(artifactJson(value)))) {
      fail('invalid-publication-artifact', 'publication artifact must retain exact canonical JSON bytes');
    }
    return value;
  } catch {
    fail('invalid-publication-artifact', 'publication artifact is not exact canonical JSON evidence');
  }
}

async function validateDraft(value, config, draftId) {
  exact(value, ['schemaVersion', 'artifactType', 'draftId', 'jobId', 'createdAt', 'checks', 'prepared']);
  exact(value.checks, ['ok']);
  exact(value.prepared, ['schemaVersion', 'artifactType', 'reference', 'session', 'operation', 'candidate']);
  exact(value.prepared.reference, ['mapping', 'policyRevision', 'source']);
  exact(value.prepared.reference.source, ['identity', 'path', 'version', 'byteLength', 'digest']);
  exact(value.prepared.candidate, ['text', 'bytesBase64', 'byteLength', 'digest']);
  if (value.schemaVersion !== 1 || value.artifactType !== DRAFT_TYPE || value.draftId !== id(draftId)
    || value.jobId !== jobIdFor(draftId) || value.checks.ok !== true || hash(value.prepared) !== draftId) {
    fail('invalid-publication-draft', 'publication draft identity or successful-check binding is invalid');
  }
  timestamp(value.createdAt);
  if (value.prepared.reference.policyRevision !== computePolicyRevision(config)) {
    fail('publication-draft-policy-mismatch', 'publication draft no longer matches the configured policy');
  }
  let reproduced;
  try {
    // This synthetic reader validates persisted bytes only. It is not a fresh
    // source read and cannot establish current host coherence or publication authority.
    reproduced = await prepareOwnerPublication({
      config, mappingId: value.prepared.reference.mapping?.id, session: value.prepared.session,
      readNote: async () => ({ ...value.prepared.reference.source, text: value.prepared.candidate.text,
        bytesBase64: value.prepared.candidate.bytesBase64 }),
    });
  } catch {
    fail('invalid-publication-draft', 'persisted publication bindings do not reproduce one exact configured candidate');
  }
  if (canonicalJson(reproduced) !== canonicalJson(value.prepared)) {
    fail('invalid-publication-draft', 'persisted publication operation or candidate bindings differ from exact reproduction');
  }
  return deepFreeze(value);
}

function summary(draft, replayed) {
  return deepFreeze({ draftId: draft.draftId, jobId: draft.jobId, createdAt: draft.createdAt,
    relativePath: draft.prepared.session.relativePath, slug: draft.prepared.session.slug,
    liveUrl: draft.prepared.session.liveUrl, candidateDigest: draft.prepared.candidate.digest,
    capturedVersion: draft.prepared.reference.source.version, replayed });
}

async function load(context, config, draftId, maximum) {
  const value = await readArtifact(context, paths(draftId).draft, maximum);
  if (value === null) fail('publication-draft-not-found', 'configured publication draft does not exist');
  return validateDraft(value, config, draftId);
}

/** Internal/private result contains source evidence. Expose only summary publicly. */
export async function loadOwnerPublicationDraft({ context: contextInput, config: configInput, draftId }) {
  const { config, context, maximum } = inputs(configInput, contextInput);
  await layout(context);
  return load(context, config, draftId, maximum);
}

/** Only mappingId is client intent. All source/session/check functions are trusted injections. */
export async function prepareOwnerPublicationDraft({
  context: contextInput, config: configInput, mappingId, readNote, createEditSession,
  immediateChecks, clock = () => new Date(),
}) {
  for (const action of [readNote, createEditSession, immediateChecks, clock]) required(action);
  const { config, context, maximum } = inputs(configInput, contextInput);
  const prepared = await prepareOwnerPublication({ config, mappingId, readNote, createEditSession });
  let checks;
  try {
    checks = await immediateChecks({ config, sourcePath: prepared.session.relativePath,
      baseBytes: Buffer.from(prepared.session.source.bytesBase64, 'base64'),
      candidateBytes: Buffer.from(prepared.candidate.bytesBase64, 'base64'), operation: prepared.operation });
  } catch {
    fail('publication-immediate-checks-failed', 'publication candidate did not pass required immediate checks');
  }
  if (!isPlainObject(checks) || checks.ok !== true) {
    fail('publication-immediate-checks-failed', 'publication candidate did not pass required immediate checks');
  }
  const draftId = hash(prepared);
  await layout(context);
  return locked(context, OWNER_PUBLICATION_DRAFT_LOCK, async () => {
    let count = 0;
    const directory = await opendir(resolveStorePath(context, `${OWNER_PUBLICATION_DRAFT_ROOT}/drafts`));
    for await (const entry of directory) {
      if (!/^[0-9a-f]{64}\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        fail('unsafe-publication-entry', 'publication draft directory contains an unexpected or unsafe entry');
      }
      if (++count > OWNER_PUBLICATION_DRAFT_LIMIT) fail('publication-draft-capacity', 'publication draft capacity is exceeded');
    }
    const existing = await readArtifact(context, paths(draftId).draft, maximum);
    if (existing !== null) {
      const draft = await validateDraft(existing, config, draftId);
      return deepFreeze({ draft, summary: summary(draft, true) });
    }
    if (count >= OWNER_PUBLICATION_DRAFT_LIMIT) fail('publication-draft-capacity', 'publication draft store is full');
    const draft = deepFreeze({ schemaVersion: 1, artifactType: DRAFT_TYPE, draftId, jobId: jobIdFor(draftId),
      createdAt: now(clock), checks: { ok: true }, prepared });
    await createJsonArtifactOnce(context, paths(draftId).draft, draft, { maxBytes: maximum });
    return deepFreeze({ draft, summary: summary(draft, false) });
  });
}

function validateAuthorization(event, draft, config) {
  exact(event, ['schemaVersion', 'artifactType', 'action', 'draftId', 'jobId', 'authorizedAt', 'authority',
    'policyRevision', 'baseCommit', 'candidateDigest']);
  exact(event.authority, ['type', 'identity']);
  if (event.schemaVersion !== 1 || event.artifactType !== AUTHORIZATION_TYPE || event.action !== 'publish'
    || event.draftId !== draft.draftId || event.jobId !== draft.jobId
    || event.authority.type !== 'owner-alpha-local' || event.authority.identity !== config.owner.identity
    || event.policyRevision !== draft.prepared.reference.policyRevision
    || event.baseCommit !== draft.prepared.session.baseCommit || event.candidateDigest !== draft.prepared.candidate.digest) {
    fail('publication-authorization-mismatch', 'publication authorization does not bind this owner, draft and job');
  }
  timestamp(event.authorizedAt);
  return deepFreeze(event);
}

function publicationBinding(draft, event) {
  return deepFreeze({ draftId: draft.draftId, authorizationDigest: hash(event) });
}

function jobInputs(draft, event) {
  const publication = publicationBinding(draft, event);
  return deepFreeze({ jobId: draft.jobId, operation: draft.prepared.operation, publication,
    session: { ...draft.prepared.session, origin: { type: 'owner-publication', ...publication,
      reference: draft.prepared.reference } } });
}

async function inspectJob(readJob, draft, event) {
  let result;
  try { result = await readJob(draft.jobId); } catch {
    fail('publication-job-unavailable', 'publication job status could not be established');
  }
  if (!isPlainObject(result) || !Object.hasOwn(result, 'status')
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(result, 'status'), 'value')) {
    fail('invalid-publication-job-status', 'publication job status must be exact data');
  }
  if (result.status === 'missing') {
    // Contract: missing means no state, input OR effect traces, not merely a
    // missing state.json. Any incomplete/uncertain trace must be ambiguous.
    exact(result, ['status'], 'invalid-publication-job-status');
    return null;
  }
  if (result?.status !== 'present') fail('publication-job-unavailable', 'publication job status is unavailable or ambiguous');
  exact(result, ['status', 'jobId', 'state', 'session', 'operation', 'publication'], 'invalid-publication-job-status');
  if (!event) fail('publication-handoff-unapproved', 'a durable publication job has no matching owner authorization');
  if (result.jobId !== draft.jobId || !JOB_STATES.includes(result.state)
    || !sameJson(result.session, jobInputs(draft, event).session, 'publication-job-binding-mismatch')
    || !sameJson(result.operation, draft.prepared.operation, 'publication-job-binding-mismatch')
    || !sameJson(result.publication, publicationBinding(draft, event), 'publication-job-binding-mismatch')) {
    fail('publication-job-binding-mismatch', 'durable publication job does not match the immutable authorized draft');
  }
  return deepFreeze({ draftId: draft.draftId, jobId: draft.jobId, state: result.state, authorizedAt: event.authorizedAt,
    capturedVersion: draft.prepared.reference.source.version, candidateDigest: draft.prepared.candidate.digest });
}

function observe(completion, onCompletion, draft) {
  const outcome = (status, value) => onCompletion(deepFreeze({ draftId: draft.draftId, jobId: draft.jobId, status,
    state: status === 'fulfilled' && JOB_STATES.includes(value?.state) ? value.state : null,
    failureCode: status === 'rejected' ? 'publication-completion-failed' : null }));
  // Observe both settlement branches immediately, even if durable acceptance fails.
  // An observer failure gets a fixed warning; no raw provider error is logged.
  Promise.resolve(completion).then((value) => outcome('fulfilled', value), () => outcome('rejected'))
    .catch(() => process.emitWarning('owner publication completion observer failed', { code: 'PUBLICATION_OBSERVER_FAILED' }));
}

/** Authenticated owner Publish intent only; this function is not an auth boundary.
 * readJob(id) returns {status:'missing'} ONLY for authoritative no-traces absence,
 * {status:'present',jobId,state,session,operation,publication}, or unavailable/ambiguous.
 * startEdit({jobId,session,operation,publication}) synchronously returns
 * {jobId,accepted:Promise<job summary>,completion:Promise<job summary>}.
 * onCompletion receives a sanitized settlement. Never await completion under lock.
 */
export async function publishOwnerPublicationDraft({
  context: contextInput, config: configInput, draftId, readNote, checkoutReady,
  readJob, startEdit, onCompletion, clock = () => new Date(),
}) {
  for (const action of [readNote, checkoutReady, readJob, startEdit, onCompletion, clock]) required(action);
  const { config, context, maximum } = inputs(configInput, contextInput);
  id(draftId);
  await layout(context);
  return locked(context, OWNER_PUBLICATION_PUBLISH_LOCK, async () => {
    const draft = await load(context, config, draftId, maximum);
    let event = await readArtifact(context, paths(draftId).authorization, maximum);
    if (event !== null) event = validateAuthorization(event, draft, config);
    const existing = await inspectJob(readJob, draft, event);
    if (existing !== null) return deepFreeze({ ...existing, replayed: true });
    await revalidateOwnerPublicationSource({ config, reference: draft.prepared.reference, readNote });
    let checkout;
    try { checkout = await checkoutReady(config); } catch {
      fail('publication-checkout-unavailable', 'publication checkout readiness could not be established');
    }
    exact(checkout, ['root', 'origin', 'branch', 'head'], 'invalid-publication-checkout');
    if (checkout.root !== config.repository.checkout || checkout.origin !== config.repository.remote.url
      || checkout.branch !== config.repository.branch || checkout.head !== draft.prepared.session.baseCommit) {
      fail('publication-base-mismatch', 'publication checkout must be clean and match the exact configured remote and reviewed base');
    }
    if (event === null) {
      event = deepFreeze({ schemaVersion: 1, artifactType: AUTHORIZATION_TYPE, action: 'publish', draftId,
        jobId: draft.jobId, authorizedAt: now(clock), authority: { type: 'owner-alpha-local', identity: config.owner.identity },
        policyRevision: draft.prepared.reference.policyRevision, baseCommit: draft.prepared.session.baseCommit,
        candidateDigest: draft.prepared.candidate.digest });
      await createJsonArtifactOnce(context, paths(draftId).authorization, event, { maxBytes: maximum });
    }
    let started;
    try {
      started = startEdit(jobInputs(draft, event));
    } catch {
      fail('publication-start-unavailable', 'authorized publication job could not be started or its start is uncertain');
    }
    // Refuse an accidentally async starter, but still observe its eventual
    // completion/rejection so a malformed adapter cannot leak an unhandled error.
    if (typeof started?.then === 'function') {
      observe(Promise.resolve(started).then((handle) => {
        if (typeof handle?.accepted?.then === 'function') Promise.resolve(handle.accepted).catch(() => {});
        return handle?.completion;
      }), onCompletion, draft);
      fail('invalid-publication-acceptance', 'publication start must synchronously return its durable acceptance handle');
    }
    // Observe a returned completion even if another start-result field is invalid.
    if (started?.completion && typeof started.completion.then === 'function') observe(started.completion, onCompletion, draft);
    if (started?.jobId !== draft.jobId || typeof started?.accepted?.then !== 'function'
      || typeof started?.completion?.then !== 'function') {
      if (typeof started?.accepted?.then === 'function') Promise.resolve(started.accepted).catch(() => {});
      fail('invalid-publication-acceptance', 'publication start must return the same job id and acceptance/completion promises');
    }
    let accepted;
    try { accepted = await started.accepted; } catch {
      fail('publication-not-accepted', 'authorized publication did not establish durable acceptance');
    }
    if (accepted?.jobId !== draft.jobId || !JOB_STATES.includes(accepted?.state)) {
      fail('invalid-publication-acceptance', 'publication acceptance does not identify the expected durable job');
    }
    const durable = await inspectJob(readJob, draft, event);
    if (durable === null) fail('publication-acceptance-uncertain', 'publication acceptance has no verifiable durable job');
    return deepFreeze({ ...durable, replayed: false });
  });
}

/** Invoke only immediately before application (also on recovered pre-apply jobs).
 * Later runtime persists publication provenance. Post-apply recovery must not call
 * this guard or depend on host availability. No job or pipeline is resumed here.
 */
export async function guardOwnerPublicationSource({
  context: contextInput, config: configInput, draftId, jobId, session, operation, readNote,
}) {
  required(readNote);
  const { config, context, maximum } = inputs(configInput, contextInput);
  await layout(context);
  const draft = await load(context, config, draftId, maximum);
  const event = await readArtifact(context, paths(draftId).authorization, maximum);
  if (event === null) fail('publication-handoff-unapproved', 'publication source guard requires a stored owner authorization');
  validateAuthorization(event, draft, config);
  if (jobId !== draft.jobId || !sameJson(session, jobInputs(draft, event).session, 'publication-handoff-mismatch')
    || !sameJson(operation, draft.prepared.operation, 'publication-handoff-mismatch')) {
    fail('publication-handoff-mismatch', 'publication source guard must match the authorized immutable job inputs');
  }
  return revalidateOwnerPublicationSource({ config, reference: draft.prepared.reference, readNote });
}
