import { createHash, randomBytes } from 'node:crypto';
import { opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createJsonArtifactOnce, replaceJsonArtifactAtomic } from './artifacts.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail } from './errors.js';
import { withFileLock } from './flock.js';
import { JOB_STATES, validateJobId } from './job-state.js';
import { artifactJson, canonicalJson, deepFreeze, isPlainObject } from './json.js';
import { applyEditorOperation } from './operation.js';
import {
  assertFoldedWorkspaceNote, assertSourceReference, assertWorkspaceDeliveryRoundTrip, foldWorkspaceText, isPublicationDigest,
  prepareOwnerPublication, publicationDigest, readAuthoringSource, revalidateOwnerPublicationSource, validatePublicationAttribution,
} from './owner-publication.js';
import { assertPrivateDirectory, readPrivateFile } from './proposal-decisions.js';
import { defaultProposalReviewGit, exactObjectId, literalPathspec, parseTreeEntry, readBlob, trimFinalLf } from './proposal-review.js';
import { assertWorkspaceNotRetired } from './retired-list.js';
import { liveUrlForSlug, pathMatchesPolicy } from './source.js';
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

export function validatePublicationDraftId(value) {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/u.test(value)) {
    fail('invalid-publication-draft-id', 'draft id must be one full lowercase SHA-256 identifier');
  }
  return value;
}

function paths(draftId) {
  const key = validatePublicationDraftId(draftId);
  return {
    draft: `${OWNER_PUBLICATION_DRAFT_ROOT}/drafts/${key}.json`,
    authorization: `${OWNER_PUBLICATION_DRAFT_ROOT}/authorizations/${key}.json`,
  };
}

function jobIdFor(draftId) {
  return validateJobId(`OA-PUB-${validatePublicationDraftId(draftId)}`);
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

function validateDraftIdentity(value, draftId) {
  exact(value, ['schemaVersion', 'artifactType', 'draftId', 'jobId', 'createdAt', 'checks', 'prepared']);
  exact(value.checks, ['ok']);
  exact(value.prepared, ['schemaVersion', 'artifactType', 'reference', 'session', 'operation', 'candidate']);
  const { reference } = value.prepared;
  const isWorkspace = reference?.mapping?.source?.kind === 'workspace';
  exact(reference, ['mapping', 'policyRevision', 'source', ...(isWorkspace ? ['workspaceBaseline'] : [])]);
  exact(value.prepared.candidate, ['text', 'bytesBase64', 'byteLength', 'digest']);
  if (value.schemaVersion !== 1 || value.artifactType !== DRAFT_TYPE || value.draftId !== validatePublicationDraftId(draftId)
    || value.jobId !== jobIdFor(draftId) || value.checks.ok !== true || hash(value.prepared) !== draftId) {
    fail('invalid-publication-draft', 'publication draft identity or successful-check binding is invalid');
  }
  timestamp(value.createdAt);
  if (isWorkspace) assertBaseline(reference.workspaceBaseline);
}

async function validateDraft(value, config, draftId) {
  validateDraftIdentity(value, draftId);
  if (value.prepared.reference.policyRevision !== computePolicyRevision(config)) {
    fail('publication-draft-policy-mismatch', 'publication draft no longer matches the configured policy');
  }
  const { source, mapping } = value.prepared.reference;
  const { foldedTextDigest, ...rawReference } = source;
  const candidate = value.prepared.candidate;
  let reproduced;
  try {
    // This synthetic reader validates persisted bytes only. It is not a fresh
    // source read and cannot establish current host coherence or publication authority.
    reproduced = await prepareOwnerPublication({
      config, workspaceBaseline: value.prepared.reference.workspaceBaseline, mappingId: value.prepared.reference.mapping?.id, session: value.prepared.session,
      readNote: async () => ({ ...rawReference, text: candidate.text, bytesBase64: candidate.bytesBase64,
        ...(mapping.source.kind === 'workspace' ? { digest: candidate.digest, byteLength: candidate.byteLength } : {}) }),
    });
  } catch (error) {
    if (['workspace-text-repeated', 'workspace-properties-invalid'].includes(error?.code)) throw error;
    fail('invalid-publication-draft', 'persisted publication bindings do not reproduce one exact configured candidate');
  }
  if (!Object.hasOwn(source, 'attribution')) {
    // Older immutable drafts predate attribution. Keep their original hashes.
    reproduced = structuredClone(reproduced);
    delete reproduced.reference.source.attribution;
  }
  if (canonicalJson(reproduced) !== canonicalJson(value.prepared)) {
    fail('invalid-publication-draft', 'persisted publication operation or candidate bindings differ from exact reproduction');
  }
  return deepFreeze(value);
}

const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const workspaceMapping = (config, mappingId) => config.ownerPublication.mappings?.find((entry) => entry.id === mappingId && entry.source.kind === 'workspace');
const workspaceBaselineFile = (mapping) => `${OWNER_PUBLICATION_DRAFT_ROOT}/baselines/${hash(mapping)}.json`;

function assertBaseline(value) {
  if (!Object.hasOwn(value ?? {}, 'foldedTextDigest') && Object.hasOwn(value ?? {}, 'digest')) {
    fail('workspace-snapshot-incompatible', 'workspace baseline predates folded text binding and must be rebound');
  }
  exact(value, ['bindingId', 'commit', 'foldedTextDigest'], 'workspace-baseline-unavailable');
  if (typeof value.bindingId !== 'string' || !/^[0-9a-f]{64}$/u.test(value.bindingId)
    || typeof value.commit !== 'string' || !GIT_COMMIT.test(value.commit) || !isPublicationDigest(value.foldedTextDigest)) {
    fail('workspace-baseline-unavailable', 'workspace baseline is not exact private evidence');
  }
}

async function readBaseline({ context, maximum }, mapping, { forExplicitBind = false } = {}) {
  try {
    const file = workspaceBaselineFile(mapping);
    const directory = path.dirname(resolveStorePath(context, file));
    await assertSafeStoreTarget(context, directory);
    if (!await privateDirectoryIfPresent(directory, 'workspace baselines')) return null;
    for (const parent of [context.workspaceRoot, context.storeRoot, path.dirname(directory)]) {
      await assertPrivateDirectory(parent, 'publication directory');
    }
    const value = await readArtifact(context, file, maximum);
    if (value === null) return null;
    exact(value, ['schemaVersion', 'baseline'], 'workspace-baseline-unavailable');
    if (value.schemaVersion === 1 && forExplicitBind) return {};
    if (value.schemaVersion === 1) fail('workspace-snapshot-incompatible', 'workspace baseline predates folded text binding and must be rebound');
    if (value.schemaVersion !== 2) fail('workspace-baseline-unavailable', 'workspace baseline schema is not supported');
    assertBaseline(value.baseline);
    return deepFreeze(value.baseline);
  } catch (error) {
    if (error?.code === 'workspace-snapshot-incompatible') throw error;
    fail('workspace-baseline-unavailable', 'workspace baseline could not be established from private evidence');
  }
}

async function writeBaseline({ context, maximum }, mapping, baseline, replace) {
  const write = replace ? replaceJsonArtifactAtomic : createJsonArtifactOnce;
  return write(context, workspaceBaselineFile(mapping), { schemaVersion: 2, baseline }, { maxBytes: maximum });
}

const headAt = async (checkout) => exactObjectId(trimFinalLf(await defaultProposalReviewGit(checkout,
  ['rev-parse', '--verify', 'HEAD^{commit}']), 'workspace HEAD'), 'workspace HEAD');

async function currentDelivery(config, mapping, { baseline } = {}) {
  pathMatchesPolicy(mapping.relativePath, config.paths);
  const checkout = config.repository.checkout;
  let commit;
  let entry;
  let bytes;
  try {
    const root = await realpath(checkout);
    const topLevel = trimFinalLf(await defaultProposalReviewGit(checkout, ['rev-parse', '--show-toplevel']), 'workspace Git root');
    if (topLevel !== root || root !== checkout) fail('invalid-workspace-checkout', 'workspace delivery must use its configured vault root');
    commit = await headAt(checkout);
    const tree = await defaultProposalReviewGit(checkout, ['ls-tree', '-z', commit, '--', literalPathspec(mapping.relativePath)]);
    entry = parseTreeEntry(tree, mapping.relativePath, 'workspace delivery', { allowMissing: true });
    if (entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode)) {
      bytes = await readBlob(defaultProposalReviewGit, checkout, entry.objectId, 'workspace delivery', config.limits.maxSourceBytes);
    }
    if (await headAt(checkout) !== commit) fail('source-snapshot-changed', 'workspace delivery HEAD changed during the read');
  } catch (error) {
    if (error?.code === 'source-snapshot-changed') throw error;
    fail('workspace-delivery-unavailable', 'workspace delivery could not be read from the vault HEAD');
  }
  if (bytes === undefined) {
    if (baseline !== undefined) fail('delivery-moved-since-baseline', 'vault delivery no longer matches its workspace baseline');
    fail('workspace-delivery-unavailable', 'workspace delivery is not a regular Git file at the vault HEAD');
  }
  const foldedText = baseline === undefined ? foldWorkspaceText(bytes) : assertWorkspaceDeliveryRoundTrip(bytes);
  const foldedTextDigest = publicationDigest(Buffer.from(foldedText));
  const digest = publicationDigest(bytes);
  if (baseline !== undefined && foldedTextDigest !== baseline.foldedTextDigest) {
    fail('delivery-moved-since-baseline', 'vault delivery no longer matches its workspace baseline');
  }
  return { commit, digest, foldedTextDigest, foldedText, objectId: entry.objectId, mode: entry.mode };
}

/** Runtime-only explicit binding, with no content copy or ordinary Save. */
export async function bindWorkspaceBaseline({ context: contextInput, config: configInput, mappingId, readNote }) {
  const store = inputs(configInput, contextInput);
  const { context, config } = store;
  const mapping = workspaceMapping(config, mappingId);
  if (!mapping) fail('publication-mapping-not-found', 'mapping is not configured for workspace publication');
  await layout(context);
  return locked(context, OWNER_PUBLICATION_PUBLISH_LOCK, async () => {
    const delivery = await currentDelivery(config, mapping);
    const note = await readAuthoringSource({ config, mappingId, readNote });
    assertFoldedWorkspaceNote(delivery.foldedText, foldWorkspaceText(note.text));
    if (note.foldedTextDigest !== delivery.foldedTextDigest) fail('workspace-diverged', 'workspace text differs from the vault delivery file');
    if (await headAt(config.repository.checkout) !== delivery.commit) {
      fail('source-snapshot-changed', 'workspace delivery HEAD changed during binding');
    }
    const previous = await readBaseline(store, mapping, { forExplicitBind: true });
    if (previous?.commit !== delivery.commit || previous?.foldedTextDigest !== delivery.foldedTextDigest) {
      const baseline = { bindingId: randomBytes(32).toString('hex'), commit: delivery.commit, foldedTextDigest: delivery.foldedTextDigest };
      await writeBaseline(store, mapping, baseline, previous !== null);
    }
    return deepFreeze({ mappingId, commit: delivery.commit, foldedTextDigest: delivery.foldedTextDigest });
  });
}

function requireBaseline(baseline) {
  if (baseline === null) fail('workspace-unbound', 'workspace note must be explicitly bound to the vault before publication');
  return baseline;
}

// The durable workspace check precedes operation derivation, including the
// unchanged preview. Mappings without source.kind preserve the synthetic path.
export async function workspacePublicationCapture({ context: contextInput, config: configInput, mappingId, readEvidence }) {
  const config = validateOwnerAlphaConfig(configInput);
  const mapping = workspaceMapping(config, mappingId);
  if (!mapping) return null;
  const store = inputs(config, contextInput);
  const bound = requireBaseline(await readBaseline(store, mapping));
  const baseline = typeof readEvidence !== 'function' ? bound : await locked(store.context, OWNER_PUBLICATION_PUBLISH_LOCK,
    async () => requireBaseline(await refreshBaseline(store, mapping, readEvidence)));
  const delivery = await currentDelivery(config, mapping, { baseline });
  return Object.freeze({
    workspaceBaseline: baseline,
    workspaceNoteGate: (note) => assertWorkspaceNotRetired({ config, context: store.context, mapping, text: note.text }),
    async workspaceGate({ session }) {
      if (session.baseCommit !== delivery.commit || session.source.digest !== delivery.digest
        || session.source.gitObjectId !== delivery.objectId || session.source.gitMode !== delivery.mode
        || await headAt(config.repository.checkout) !== delivery.commit) {
        fail('publication-base-mismatch', 'workspace publication must match the exact vault HEAD and delivery blob');
      }
    },
  });
}

function summary(draft, replayed) {
  return deepFreeze({ draftId: draft.draftId, jobId: draft.jobId, createdAt: draft.createdAt,
    relativePath: draft.prepared.session.relativePath, slug: draft.prepared.session.slug,
    liveUrl: draft.prepared.session.liveUrl, candidateDigest: draft.prepared.candidate.digest,
    capturedVersion: draft.prepared.reference.source.version, ...foldedProjection(draft.prepared.reference.source), replayed });
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
  immediateChecks, readEvidence, clock = () => new Date(),
}) {
  for (const action of [readNote, createEditSession, immediateChecks, clock]) required(action);
  const { config, context, maximum } = inputs(configInput, contextInput);
  const workspace = await workspacePublicationCapture({ config, context, mappingId, readEvidence });
  const prepared = await prepareOwnerPublication({ config, mappingId, readNote, createEditSession, ...workspace });
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
  return boundJob(result, draft, event);
}

function boundJob(result, draft, event) {
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
    capturedVersion: draft.prepared.reference.source.version, candidateDigest: draft.prepared.candidate.digest,
    ...foldedProjection(draft.prepared.reference.source) });
}

// One baseline state for every durable job state. A live-capable state alone is
// not evidence; inspect the confirmation history AND the matching result below.
export const PUBLICATION_JOB_STATES = Object.freeze({
  accepted: 'publishing',
  preflighting: 'publishing',
  checking: 'publishing',
  rendering: 'publishing',
  'ready-to-apply': 'publishing',
  applying: 'publishing',
  'source-applied': 'publishing',
  committing: 'publishing',
  committed: 'publishing',
  pushing: 'publishing',
  'awaiting-approval': 'publishing',
  pushed: 'publishing',
  'discovering-run': 'publishing',
  'run-bound': 'publishing',
  'monitoring-deployment': 'publishing',
  'deployment-succeeded': 'publishing',
  'verifying-live': 'publishing',
  'live-confirmed': 'live',
  'rebuilding-local': 'live',
  completed: 'live',
  'blocked-pre-apply': 'needs-attention',
  'deployment-failed': 'needs-attention',
  'live-verification-failed': 'not-verified',
  'manual-intervention': 'needs-attention',
  cancelled: 'needs-attention',
  failed: 'needs-attention',
});

async function privateDirectoryIfPresent(directory, label) {
  try {
    await assertPrivateDirectory(directory, label);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function openReadLayout(context) {
  const directory = resolveStorePath(context, `${OWNER_PUBLICATION_DRAFT_ROOT}/drafts`);
  await assertSafeStoreTarget(context, directory);
  if (!await privateDirectoryIfPresent(directory, 'publication drafts')) return null;
  for (const parent of [context.workspaceRoot, context.storeRoot, path.dirname(directory)]) {
    await assertPrivateDirectory(parent, 'publication directory');
  }
  await privateDirectoryIfPresent(path.join(path.dirname(directory), 'authorizations'), 'publication authorizations');
  return directory;
}

function samePublicationTarget(draft, mapping, config) {
  return isPlainObject(draft?.prepared?.reference?.mapping)
    && canonicalJson(draft.prepared.reference.mapping) === canonicalJson(mapping)
    && draft.prepared.session?.liveUrl === liveUrlForSlug(config.live.baseUrl, mapping.slug);
}

function foldedProjection(source) {
  return source.foldedTextDigest === undefined ? {} : { foldedTextDigest: source.foldedTextDigest };
}

function digestProjection(source) {
  return source.foldedTextDigest === undefined ? { digest: source.digest } : foldedProjection(source);
}

async function validateReadDraft(draft, config, draftId, mapping, policyRevision) {
  if (draft.prepared.reference.policyRevision === policyRevision) return validateDraft(draft, config, draftId);
  // Policy changes revoke an old draft's write usability, not the fact that the
  // same configured note and URL were witnessed. Recheck frozen bytes without
  // requiring that the old operation be authorizable under today's policy.
  validateDraftIdentity(draft, draftId);
  const { reference, session, operation, candidate } = draft.prepared;
  const { source } = reference;
  assertSourceReference(source, mapping, Number.MAX_SAFE_INTEGER);
  const workspace = mapping.source.kind === 'workspace';
  const bytes = applyEditorOperation(session, operation, { workspacePublication: workspace, allowProperties: workspace });
  if (workspace) {
    const foldedBase = assertWorkspaceDeliveryRoundTrip(Buffer.from(session.source.bytesBase64, 'base64'));
    const foldedCandidate = assertWorkspaceDeliveryRoundTrip(bytes);
    if (publicationDigest(Buffer.from(foldedBase)) !== reference.workspaceBaseline.foldedTextDigest
      || publicationDigest(Buffer.from(foldedCandidate)) !== source.foldedTextDigest) {
      fail('invalid-publication-draft', 'historical workspace evidence does not match the folded baseline and capture');
    }
    assertFoldedWorkspaceNote(foldedBase, foldedCandidate);
  }
  if (session.relativePath !== mapping.relativePath || session.slug !== mapping.slug
    || session.policyRevision !== reference.policyRevision || session.origin !== undefined
    || candidate.digest !== publicationDigest(bytes)
    || (!workspace && (source.digest !== candidate.digest || bytes.length !== source.byteLength))
    || bytes.length !== candidate.byteLength
    || bytes.toString('base64') !== candidate.bytesBase64 || bytes.toString('utf8') !== candidate.text) {
    fail('invalid-publication-draft', 'historical publication evidence is not bound to the exact configured candidate');
  }
  return draft;
}

async function projectReadDraft({ context, config, maximum, policyRevision, readEvidence }, draft) {
  const { mapping, source } = draft.prepared.reference;
  let jobId = null;
  let state = 'needs-attention';
  let liveVerified = false;
  let liveKind;
  let liveOrder = null;
  let publishedCommit = null;
  try {
    let event = await readArtifact(context, paths(draft.draftId).authorization, maximum);
    if (event !== null) event = validateAuthorization(event, draft, config);
    const evidence = await readEvidence(draft.jobId, draft.prepared.reference.policyRevision);
    const job = boundJob(evidence.job, draft, event);
    if (job === null) {
      if (event === null && draft.prepared.reference.policyRevision === policyRevision) state = 'prepared';
    } else {
      jobId = job.jobId;
      liveVerified = evidence.confirmedAt !== null && evidence.verified === true;
      state = PUBLICATION_JOB_STATES[job.state];
      if (evidence.confirmedAt !== null && !liveVerified) state = 'not-verified';
      if (liveVerified) {
        liveKind = evidence.liveKind ?? 'text';
        liveOrder = [evidence.confirmedAt, evidence.createdAt, job.authorizedAt, draft.draftId];
        const effect = evidence.committed;
        const commit = effect?.status === 'committed' && effect.commit === effect.verification?.commit
          ? effect.verification : effect;
        const { session } = draft.prepared;
        if (commit?.status === 'commit-verified' && typeof commit.commit === 'string' && GIT_COMMIT.test(commit.commit)
          && commit.commit !== session.baseCommit && commit.parentCommit === session.baseCommit
          && commit.sourcePath === session.relativePath && commit.sourceMode === session.source.gitMode
          && commit.parentBlob === session.source.gitObjectId && commit.candidateDigest === draft.prepared.candidate.digest
          && typeof commit.candidateBlob === 'string' && GIT_COMMIT.test(commit.candidateBlob)) {
          publishedCommit = commit.commit;
        }
      }
    }
  } catch { /* Partial or invalid job evidence can never assert live or prepared. */ }
  return { receipt: { draftId: draft.draftId, mappingId: mapping.id, version: source.version,
    ...digestProjection(source), attribution: validatePublicationAttribution(source.attribution ?? 'unknown'),
    jobId, state, liveVerified, ...(liveVerified && { liveKind }) }, liveOrder, publishedCommit };
}

// Sort only immutable timestamps; confirmation time, not preparation time or
// source version, determines the last witnessed publication. Resolve timestamp
// ties consistently without persisting another order record.
function isLater(order, previous) {
  if (previous === null) return true;
  const firstDifference = order.findIndex((part, i) => part !== previous[i]);
  return firstDifference >= 0 && order[firstDifference] > previous[firstDifference];
}

async function scanPublicationDrafts(store, mapping, readEvidence, visit) {
  const { context, config, maximum } = store;
  const request = { ...store, policyRevision: computePolicyRevision(config), readEvidence };
  const directory = await openReadLayout(context);
  if (directory === null) return;
  // Drafts are immutable and capped at 64. No extra queue/index to recover.
  let count = 0;
  for await (const entry of await opendir(directory)) {
    if (entry.isFile() && /^[0-9a-f]{64}\.json\.tmp-\d+-[0-9a-f-]{36}$/u.test(entry.name)) continue;
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name) || ++count > OWNER_PUBLICATION_DRAFT_LIMIT) {
      fail('invalid-publication-artifact', 'publication draft layout is not bounded private evidence');
    }
    const draftId = entry.name.slice(0, -5);
    const record = await readArtifact(context, paths(draftId).draft, maximum);
    if (record === null || !isPlainObject(record.prepared?.reference?.mapping)) {
      fail('invalid-publication-artifact', 'publication draft evidence is missing or malformed');
    }
    if (!samePublicationTarget(record, mapping, config)) continue;
    let draft;
    try { draft = await validateReadDraft(record, config, draftId, mapping, request.policyRevision); }
    catch (error) { if (error?.code === 'workspace-snapshot-incompatible') continue; throw error; }
    visit(draft, await projectReadDraft(request, draft));
  }
}

async function refreshBaseline(store, mapping, readEvidence, visit = () => {}) {
  const baseline = await readBaseline(store, mapping);
  if (baseline === null || typeof readEvidence !== 'function') return baseline;
  let next = null;
  let order = null;
  await scanPublicationDrafts(store, mapping, readEvidence, (draft, result) => {
    visit(draft, result);
    if (result.publishedCommit !== null && result.liveOrder !== null && isLater(result.liveOrder, order)
      && canonicalJson(draft.prepared.reference.workspaceBaseline) === canonicalJson(baseline)) {
      next = { bindingId: baseline.bindingId, commit: result.publishedCommit, foldedTextDigest: draft.prepared.reference.source.foldedTextDigest };
      order = result.liveOrder;
    }
  });
  if (next === null) return baseline;
  await writeBaseline(store, mapping, next, true);
  return deepFreeze(next);
}

export async function readOwnerPublicationStatus({ context: contextInput, config: configInput, mappingId, readEvidence }) {
  const store = inputs(configInput, contextInput);
  const mapping = store.config.ownerPublication.mappings?.find((entry) => entry.id === mappingId);
  if (!mapping) fail('publication-mapping-not-found', 'mapping id is not configured for owner publication');
  let latest = null;
  let live = null;
  let latestOrder = null;
  let liveOrder = null;
  const visit = (draft, result) => {
    const { version, attribution, jobId, state, liveKind } = result.receipt;
    const digest = digestProjection(draft.prepared.reference.source);
    const order = [draft.createdAt, draft.draftId];
    if (isLater(order, latestOrder)) {
      latest = { draftId: draft.draftId, version, ...digest, attribution, jobId, state };
      latestOrder = order;
    }
    if (result.liveOrder !== null && isLater(result.liveOrder, liveOrder)) {
      live = { version, ...digest, attribution, jobId, verified: true, liveKind, confirmedAt: result.liveOrder[0] };
      liveOrder = result.liveOrder;
    }
  };
  try {
    if (mapping.source.kind === 'workspace' && await readBaseline(store, mapping) !== null) {
      await locked(store.context, OWNER_PUBLICATION_PUBLISH_LOCK, () => refreshBaseline(store, mapping, readEvidence, visit));
    } else {
      await scanPublicationDrafts(store, mapping, readEvidence, visit);
    }
  } catch (error) {
    if (error?.code === 'workspace-snapshot-incompatible') throw error;
    fail('publication-status-unavailable', 'publication status could not be established from private evidence');
  }
  return deepFreeze({ mappingId, selected: true, live, latest });
}

export async function readOwnerPublicationReceipt({ context: contextInput, config: configInput, draftId, readEvidence }) {
  const store = inputs(configInput, contextInput);
  const { context, config, maximum } = store;
  let receipt;
  try {
    const directory = await openReadLayout(context);
    const record = directory === null ? null : await readArtifact(context, paths(draftId).draft, maximum);
    const mapping = config.ownerPublication.mappings?.find((entry) => samePublicationTarget(record, entry, config));
    if (mapping) {
      const policyRevision = computePolicyRevision(config);
      const draft = await validateReadDraft(record, config, draftId, mapping, policyRevision);
      ({ receipt } = await projectReadDraft({ ...store, policyRevision, readEvidence }, draft));
    }
  } catch (error) {
    if (error?.code === 'workspace-snapshot-incompatible') throw error;
    fail('publication-receipt-unavailable', 'publication receipt could not be established from private evidence');
  }
  if (!receipt) fail('publication-draft-not-found', 'configured publication draft does not exist');
  return deepFreeze(receipt);
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
  readJob, readEvidence, startEdit, onCompletion, clock = () => new Date(),
}) {
  for (const action of [readNote, checkoutReady, readJob, startEdit, onCompletion, clock]) required(action);
  const store = inputs(configInput, contextInput);
  const { config, context, maximum } = store;
  validatePublicationDraftId(draftId);
  await layout(context);
  return locked(context, OWNER_PUBLICATION_PUBLISH_LOCK, async () => {
    const draft = await load(context, config, draftId, maximum);
    let event = await readArtifact(context, paths(draftId).authorization, maximum);
    if (event !== null) event = validateAuthorization(event, draft, config);
    const existing = await inspectJob(readJob, draft, event);
    const { reference, session } = draft.prepared;
    const { mapping } = reference;
    // An existing job is a read-only replay, not a request for a new effect.
    const baseline = mapping.source.kind === 'workspace' ? await refreshBaseline(store, mapping, readEvidence) : undefined;
    if (existing !== null) return deepFreeze({ ...existing, replayed: true });
    let delivery;
    if (baseline !== undefined) {
      requireBaseline(baseline);
      delivery = await currentDelivery(config, mapping, { baseline });
      await assertWorkspaceNotRetired({ config, context, mapping, text: draft.prepared.candidate.text });
      if (canonicalJson(reference.workspaceBaseline) !== canonicalJson(baseline)
        || delivery.commit !== session.baseCommit || delivery.objectId !== session.source.gitObjectId
        || delivery.mode !== session.source.gitMode || delivery.digest !== session.source.digest) {
        fail('publication-base-mismatch', 'workspace publication must match the exact reviewed binding and vault base');
      }
    }
    await revalidateOwnerPublicationSource({ config, reference, readNote,
      async checkNote(note) {
        if (delivery) assertFoldedWorkspaceNote(delivery.foldedText, foldWorkspaceText(note.text));
        await assertWorkspaceNotRetired({ config, context, mapping, text: note.text });
      },
    });
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
  const { reference, candidate } = draft.prepared;
  await assertWorkspaceNotRetired({ config, context, mapping: reference.mapping, text: candidate.text });
  return revalidateOwnerPublicationSource({ config, reference, readNote,
    async checkNote(note) {
      if (reference.mapping.source.kind === 'workspace') {
        const foldedBase = foldWorkspaceText(draft.prepared.session.source.text);
        assertFoldedWorkspaceNote(foldedBase, foldWorkspaceText(note.text));
      }
      await assertWorkspaceNotRetired({ config, context, mapping: reference.mapping, text: note.text });
    },
  });
}
