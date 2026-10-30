import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { runImmediateChecks } from './checks.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { validateJobId, validateJobState } from './job-state.js';
import { artifactJson, deepFreeze } from './json.js';
import { assertPrivateDirectory, readPrivateFile } from './proposal-decisions.js';
import { defaultProposalReviewGit, readTrustPolicy } from './proposal-review.js';
import { assertCheckoutReady, createEditSession } from './source.js';
import { assertSafeStoreTarget, resolveStorePath } from './store.js';
import {
  guardOwnerPublicationSource, loadOwnerPublicationDraft,
  prepareOwnerPublicationDraft, publishOwnerPublicationDraft,
} from './owner-publication-store.js';

const MAXIMUM = 8 * 1024 * 1024;

/** Private on-disk authority, never the HTTP job projection. An existing empty or
 * partial job directory is ambiguous, not an invitation to start another job. */
export function createPublicationJobReader({ config: configInput, context }) {
  const config = validateOwnerAlphaConfig(configInput);
  const maximum = Math.min(config.limits.maxArtifactBytes, MAXIMUM);
  return async (jobId) => {
    try {
      validateJobId(jobId);
      const directory = resolveStorePath(context, `jobs/${jobId}`);
      await assertSafeStoreTarget(context, directory);
      await assertPrivateDirectory(context.workspaceRoot, 'publication workspace');
      await assertPrivateDirectory(context.storeRoot, 'publication store');
      const jobs = path.dirname(directory);
      try { await lstat(jobs); } catch (error) {
        if (error?.code === 'ENOENT') return deepFreeze({ status: 'missing' });
        throw error;
      }
      await assertPrivateDirectory(jobs, 'publication jobs');
      try { await lstat(directory); } catch (error) {
        if (error?.code === 'ENOENT') return deepFreeze({ status: 'missing' });
        throw error;
      }
      await assertPrivateDirectory(directory, 'publication job');
      const read = async (name) => {
        const file = path.join(directory, name);
        await assertSafeStoreTarget(context, file);
        const bytes = await readPrivateFile(file, 'publication job artifact', maximum);
        if (bytes === undefined || bytes.length > maximum) throw new Error('incomplete');
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!bytes.equals(Buffer.from(artifactJson(parsed)))) throw new Error('noncanonical');
        return parsed;
      };
      const state = validateJobState(await read('state.json'));
      const session = await read('session.json');
      const operation = await read('operation.json');
      if (state.jobId !== jobId || state.policyRevision !== computePolicyRevision(config)
        || session.policyRevision !== state.policyRevision
        || session.origin?.type !== 'owner-publication') throw new Error('binding');
      const { draftId, authorizationDigest } = session.origin;
      return deepFreeze({ status: 'present', jobId, state: state.state, session, operation,
        publication: { draftId, authorizationDigest } });
    } catch {
      return deepFreeze({ status: 'unavailable' });
    }
  };
}

const SOURCE_GUARD_FAILURES = Object.freeze({
  'authoring-source-stale': 'publication authoring source changed after the reviewed capture',
  'authoring-read-failed': 'publication authoring source could not be read coherently',
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
      try {
        // Never evaluate an error's code/message/details getters. Even known
        // codes get fixed messages, not dependency-controlled diagnostic text.
        if (error instanceof OwnerAlphaError) {
          const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
          if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
            && Object.hasOwn(SOURCE_GUARD_FAILURES, descriptor.value)) code = descriptor.value;
        }
      } catch { /* Hostile reflection is an unknown failure, never evidence. */ }
      if (code !== undefined) fail(code, SOURCE_GUARD_FAILURES[code]);
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
  onCompletion = () => {},
}) {
  const config = validateOwnerAlphaConfig(configInput);
  const reader = typeof readNote === 'function' ? readNote : async () => {
    fail('publication-reader-unavailable', 'publication source reader is unavailable');
  };
  const readJob = createPublicationJobReader({ config, context });
  return Object.freeze({
    async prepare({ mappingId }) {
      let baseCommit;
      return prepareOwnerPublicationDraft({ config, context, mappingId, readNote: reader,
        createEditSession: async (input) => {
          const session = await sourceSession(input);
          baseCommit = session.baseCommit;
          return session;
        },
        immediateChecks: async (input) => {
          // Same policy source and owner subject as normal preapply, pinned to the
          // reviewed Git base. Missing/malformed policies remain null, fail closed.
          const policy = await readTrustPolicy(git, config.repository.checkout, baseCommit);
          return immediateChecks({ ...input, trustPolicy: policy.config });
        },
      });
    },
    load({ draftId }) { return loadOwnerPublicationDraft({ config, context, draftId }); },
    publish({ draftId }) {
      return publishOwnerPublicationDraft({ config, context, draftId, readNote: reader,
        checkoutReady, readJob, onCompletion,
        startEdit: (input) => {
          if (typeof pipeline?.startEdit !== 'function') fail('publication-start-unavailable', 'publication pipeline is unavailable');
          return pipeline.startEdit(input);
        },
      });
    },
    readJob,
  });
}
