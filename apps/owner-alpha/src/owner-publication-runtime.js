import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { runImmediateChecks } from './checks.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { validateJobId, validateJobState } from './job-state.js';
import { artifactJson, deepFreeze, isPlainObject } from './json.js';
import { hasExactSuccessfulDeployment, hasStableLiveProof } from './live-confirm.js';
import { PIPELINE_SCHEMA_VERSION, pipelineArtifactPaths } from './pipeline.js';
import { assertPrivateDirectory, readPrivateFile } from './proposal-decisions.js';
import { defaultProposalReviewGit, readTrustPolicy } from './proposal-review.js';
import { assertCheckoutReady, createEditSession } from './source.js';
import { captureOwnerPublicationReview, WORKSPACE_READER_FAILURES } from './owner-publication.js';
import { assertSafeStoreTarget, resolveStorePath } from './store.js';
import {
  bindWorkspaceBaseline, guardOwnerPublicationSource, loadOwnerPublicationDraft,
  prepareOwnerPublicationDraft, publishOwnerPublicationDraft,
  readOwnerPublicationReceipt, readOwnerPublicationStatus, workspacePublicationCapture,
} from './owner-publication-store.js';

export { bindWorkspaceBaseline };

const MAXIMUM = 8 * 1024 * 1024;
export const PUBLICATION_VIEW_LIMIT = 8;
// Account for serialized UTF-8 evidence plus the retained UTF-16 document text.
export const PUBLICATION_VIEW_BYTE_LIMIT = 2 * 1024 * 1024;
export const PUBLICATION_VIEW_TTL_MS = 30 * 60 * 1000;

/** Private on-disk authority, never the HTTP job projection. An existing empty or
 * partial job directory is ambiguous, not an invitation to start another job. */
export function createPublicationJobReader(input) {
  return publicationJobReader(input, false);
}

function publicationJobReader({ config: configInput, context }, includeEvidence) {
  const config = validateOwnerAlphaConfig(configInput);
  const policyRevision = computePolicyRevision(config);
  const maximum = Math.min(config.limits.maxArtifactBytes, MAXIMUM);
  const result = (job, extra = {}) => deepFreeze(includeEvidence ? { job, ...extra } : job);
  return async (jobId, draftPolicyRevision) => {
    try {
      validateJobId(jobId);
      const directory = resolveStorePath(context, `jobs/${jobId}`);
      await assertSafeStoreTarget(context, directory);
      await assertPrivateDirectory(context.workspaceRoot, 'publication workspace');
      await assertPrivateDirectory(context.storeRoot, 'publication store');
      const jobs = path.dirname(directory);
      try { await lstat(jobs); } catch (error) {
        if (error?.code === 'ENOENT') return result({ status: 'missing' });
        throw error;
      }
      await assertPrivateDirectory(jobs, 'publication jobs');
      try { await lstat(directory); } catch (error) {
        if (error?.code === 'ENOENT') return result({ status: 'missing' });
        throw error;
      }
      await assertPrivateDirectory(directory, 'publication job');
      const read = async (file) => {
        await assertSafeStoreTarget(context, file);
        const bytes = await readPrivateFile(file, 'publication job artifact', maximum);
        if (bytes === undefined || bytes.length > maximum) throw new Error('incomplete');
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!bytes.equals(Buffer.from(artifactJson(parsed)))) throw new Error('noncanonical');
        return parsed;
      };
      const files = pipelineArtifactPaths(jobId);
      const state = validateJobState(await read(path.join(directory, 'state.json')));
      const session = await read(resolveStorePath(context, files.session));
      const operation = await read(resolveStorePath(context, files.operation));
      const expectedPolicy = includeEvidence ? draftPolicyRevision : policyRevision;
      if (state.jobId !== jobId || state.policyRevision !== expectedPolicy
        || session.policyRevision !== state.policyRevision
        || session.origin?.type !== 'owner-publication') throw new Error('binding');
      const { draftId, authorizationDigest } = session.origin;
      const job = { status: 'present', jobId, state: state.state, session, operation,
        publication: { draftId, authorizationDigest } };
      if (!includeEvidence) return result(job);
      const confirmedAt = state.history.find(({ to }) => to === 'live-confirmed')?.at ?? null;
      let liveKind = null;
      let committed = null;
      const readResult = async (file, artifactType) => {
        const absolute = resolveStorePath(context, file);
        await assertPrivateDirectory(path.dirname(absolute), 'publication evidence');
        const record = await read(absolute);
        if (record?.schemaVersion !== PIPELINE_SCHEMA_VERSION || record.artifactType !== artifactType
          || record.jobId !== jobId || !isPlainObject(record.result)) throw new Error('binding');
        return record.result;
      };
      if (confirmedAt !== null) {
        try {
          const live = await readResult(files.live, 'owner-alpha-live-result');
          if (Object.hasOwn(live, 'pageUrl') && live.pageUrl !== session.liveUrl) throw new Error('binding');
          if (live.kind === 'no-visible-change') {
            committed = await readResult(files.committed, 'owner-alpha-committed-effect');
            const binding = await readResult(files.runBound, 'owner-alpha-run-bound-effect');
            const deployment = await readResult(files.deployment, 'owner-alpha-deployment-result');
            const preApply = await readResult(files.preApplyChecks, 'owner-alpha-pre-apply-check-result');
            if (hasStableLiveProof(live, { pageUrl: session.liveUrl, commit: committed.commit, witness: preApply.rendered?.witnesses })
              && hasExactSuccessfulDeployment(committed.commit, binding, deployment)) liveKind = live.kind;
          } else if ((live.kind ?? 'text') === 'text' && live.oldWitnessAbsent === true && live.newWitnessUnique === true) {
            liveKind = 'text';
          }
        } catch { /* Preserve job state when live evidence is missing or unsafe. */ }
      }
      if (liveKind === 'text' && session.origin.reference?.mapping?.source?.kind === 'workspace') {
        try { committed = await readResult(files.committed, 'owner-alpha-committed-effect'); }
        catch { /* Never advance a baseline without bound committed evidence. */ }
      }
      return result(job, { createdAt: state.createdAt, confirmedAt, verified: liveKind !== null, liveKind, committed });
    } catch {
      return result({ status: 'unavailable' });
    }
  };
}

const SOURCE_GUARD_FAILURES = Object.freeze({
  ...WORKSPACE_READER_FAILURES,
  'retired-material': 'workspace publication contains retired material',
  'retired-list-unavailable': 'private retirement policy is unavailable',
  'authoring-source-stale': 'publication authoring source changed after the reviewed capture',
  'authoring-read-failed': 'publication authoring source could not be read coherently',
  'delivery-not-round-trippable': 'workspace text cannot round-trip through exact UTF-8',
  'workspace-snapshot-incompatible': 'workspace draft predates folded text binding and must be prepared again',
  'workspace-text-repeated': 'workspace note repeats the vault text',
  'workspace-properties-invalid': 'workspace note has invalid frontmatter structure',
  'publication-handoff-unapproved': 'publication requires its immutable owner authorization',
  'publication-authorization-mismatch': 'publication owner authorization does not match the reviewed draft',
  'publication-handoff-mismatch': 'publication job inputs do not match the owner authorization',
  'publication-draft-not-found': 'publication reviewed draft is unavailable',
  'publication-draft-policy-mismatch': 'publication reviewed draft no longer matches the configured policy',
  'publication-policy-mismatch': 'publication source binding no longer matches the configured policy',
  'invalid-publication-draft': 'publication reviewed draft could not be validated',
  'invalid-publication-artifact': 'publication private evidence could not be validated',
});

/** Injected into the pipeline on both start and recovery. No transport default. */
export function createPublicationSourceGuard({ config, context, readNote }) {
  return async ({ jobId, session, operation }) => {
    if (session.origin?.type !== 'owner-publication') return;
    if (typeof readNote !== 'function') fail('publication-reader-unavailable', 'publication source reader is unavailable');
    try {
      await guardOwnerPublicationSource({ config, context, readNote, jobId, session, operation,
        draftId: session.origin.draftId });
    } catch (error) {
      let code;
      let repeats;
      try {
        // Never evaluate an error's code/message/details getters. Even known
        // codes get fixed messages, not dependency-controlled diagnostic text.
        if (error instanceof OwnerAlphaError) {
          const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
          if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
            && Object.hasOwn(SOURCE_GUARD_FAILURES, descriptor.value)) code = descriptor.value;
          if (code === 'workspace-text-repeated') {
            const details = Object.getOwnPropertyDescriptor(error, 'details')?.value;
            if (isPlainObject(details)) {
              const value = Object.getOwnPropertyDescriptor(details, 'repeats')?.value;
              if (Number.isSafeInteger(value) && value >= 2) repeats = value;
            }
          }
        }
      } catch { /* Hostile reflection is an unknown failure, never evidence. */ }
      if (code !== undefined) fail(code, SOURCE_GUARD_FAILURES[code], repeats === undefined ? {} : { repeats });
      fail('publication-source-check-failed', 'publication source and authorization could not be validated');
    }
  };
}

/** Host-neutral owner controller. Defaults are real Git/check implementations;
 * test overrides must be explicit. No source identity is returned by summaries. */
export function createOwnerPublicationRuntime({
  config: configInput, context, readNote, pipeline,
  sourceSession = createEditSession, checkoutReady = assertCheckoutReady,
  git = defaultProposalReviewGit, immediateChecks = runImmediateChecks,
  onCompletion = () => {}, clock = () => Date.now(),
}) {
  const config = validateOwnerAlphaConfig(configInput);
  const reader = typeof readNote === 'function' ? readNote : async () => {
    fail('publication-reader-unavailable', 'publication source reader is unavailable');
  };
  const readJob = createPublicationJobReader({ config, context });
  const readEvidence = publicationJobReader({ config, context }, true);
  const writer = pipeline?.startEdit;
  const startEdit = typeof writer === 'function' ? writer.bind(pipeline) : null;
  const publishAvailable = startEdit !== null;
  const views = new Map();
  let viewBytes = 0;
  const removeView = (id) => {
    viewBytes -= views.get(id).bytes;
    views.delete(id);
  };
  const expireViews = (now) => {
    for (const [id, entry] of views) if (entry.expiresAt <= now) removeView(id);
  };
  const retainView = (view) => {
    const now = clock();
    expireViews(now);
    const bytes = Buffer.byteLength(artifactJson(view), 'utf8') + 2 * view.text.length;
    if (bytes > PUBLICATION_VIEW_BYTE_LIMIT) fail('publication-view-too-large', 'unchanged review exceeds the memory byte limit');
    while (views.size >= PUBLICATION_VIEW_LIMIT || viewBytes + bytes > PUBLICATION_VIEW_BYTE_LIMIT) {
      removeView(views.keys().next().value);
    }
    const viewId = randomBytes(32).toString('hex');
    views.set(viewId, { view, bytes, expiresAt: now + PUBLICATION_VIEW_TTL_MS });
    viewBytes += bytes;
    return deepFreeze({ outcome: 'unchanged', reviewUrl: `/owner/publication/current/${viewId}` });
  };
  return Object.freeze({
    publishAvailable,
    bindWorkspaceBaseline({ mappingId }) { return bindWorkspaceBaseline({ config, context, mappingId, readNote: reader }); },
    async prepare({ mappingId, expectedDigest }) {
      const workspace = await workspacePublicationCapture({ config, context, mappingId, readEvidence });
      const capture = await captureOwnerPublicationReview({ config, mappingId, expectedDigest,
        readNote: reader, createEditSession: sourceSession, ...workspace });
      if (capture.view) return retainView(capture.view);
      const baseCommit = capture.session.baseCommit;
      // The detached note is already verified; revalidation still recomputes its
      // folded binding rather than taking a digest from the reader shape.
      const { foldedTextDigest, ...capturedNote } = capture.note;
      return prepareOwnerPublicationDraft({ config, context, mappingId, readNote: async () => capturedNote,
        createEditSession: async () => capture.session,
        immediateChecks: async (input) => {
          // Same policy source and owner subject as normal preapply, pinned to the
          // reviewed Git base. Missing/malformed policies remain null, fail closed.
          const policy = await readTrustPolicy(git, config.repository.checkout, baseCommit);
          return immediateChecks({ ...input, trustPolicy: policy.config });
        },
      });
    },
    readStatus({ mappingId }) { return readOwnerPublicationStatus({ config, context, mappingId, readEvidence }); },
    readReceipt({ draftId }) { return readOwnerPublicationReceipt({ config, context, draftId, readEvidence }); },
    load({ draftId }) { return loadOwnerPublicationDraft({ config, context, draftId }); },
    loadCurrent({ viewId }) {
      expireViews(clock());
      if (typeof viewId !== 'string' || !/^[0-9a-f]{64}$/u.test(viewId) || !views.has(viewId)) {
        fail('publication-view-not-found', 'unchanged review is unavailable or expired');
      }
      return views.get(viewId).view;
    },
    async publish({ draftId }) {
      // Deny before the store can inspect layout, revalidate or authorize anything.
      if (!publishAvailable) fail('publication-start-unavailable', 'publication pipeline is unavailable');
      return publishOwnerPublicationDraft({ config, context, draftId, readNote: reader,
        checkoutReady, readJob, readEvidence, onCompletion,
        startEdit,
      });
    },
    readJob,
  });
}
