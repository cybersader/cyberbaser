import { validateOwnerAlphaConfig } from '../config.js';
import { fail, OwnerAlphaError } from '../errors.js';
import { validateJobId } from '../job-state.js';
import { authorizeOwnerDirect, deriveOwnerDirect, validateOwnerHandoff } from '../owner-direct.js';
import { storeContextFromConfig } from '../store.js';

// Distinguish command preconditions from same-named errors raised by injected
// effects, whose existing HTTP error mappings differ.
export class OwnerCommandPrecondition extends OwnerAlphaError {}

export function createOwnerCommands({
  config: configInput, projectRoot, principalAdapter, createEditSession,
  editSessions, handoffs, directEdits, saveEdit, lookupJob, createJobId,
  proposalReview = null, publication = null,
}) {
  const config = validateOwnerAlphaConfig(configInput);
  const inFlight = new Set();

  function requireGrant(grant, principal) {
    if (!principalAdapter.isVerified(principal) || principal.id !== config.owner.identity) {
      fail('invalid-session', 'a verified owner session is required');
    }
    switch (grant) {
      case 'read':
      case 'save':
        return;
      case 'review':
      case 'apply':
        if (!config.proposalReview.enabled) fail('proposal-review-disabled', 'proposal review is disabled');
        if (grant === 'apply' && (typeof proposalReview?.apply !== 'function' || proposalReview.applicationAvailable !== true)) {
          fail('application-unavailable', 'applying suggestions is not available in this runtime');
        }
        return;
      case 'publication':
      case 'publish':
        if (!config.ownerPublication.enabled) fail('publication-disabled', 'owner publication is disabled');
        if (grant === 'publish' && publication?.publishAvailable !== true) {
          fail('publication-read-only', 'publication is read-only in this runtime');
        }
        return;
      default:
        throw new TypeError('unknown owner grant');
    }
  }

  function command(grant, fallback, execute, { preserveCode = false } = {}) {
    return async (input, principal) => {
      requireGrant(grant, principal);
      try {
        return await execute(input, principal);
      } catch (error) {
        if (error instanceof OwnerAlphaError) throw error;
        fail(preserveCode ? error?.code ?? fallback : fallback, 'owner command failed');
      }
    };
  }

  return Object.freeze({
    // The HTTP binding uses the same check before parsing for routes where
    // feature/availability errors have precedence over malformed input.
    requireGrant,

    readPageSource: command('read', 'edit-session-failed', async (input) => {
      return createEditSession({ config, renderer: input });
    }, { preserveCode: true }),

    // Anonymous by design: staging only keeps a bounded, expiring draft; it
    // does not read source or authorize an effect.
    async stageOwnerDirect(input) {
      return { stageId: handoffs.create(validateOwnerHandoff(input?.handoff)) };
    },

    inspectOwnerDirect: command('read', 'owner-handoff-unavailable', async (input, principal) => {
      const { stageId } = input;
      const handoff = handoffs.get(stageId);
      if (!handoff) throw new OwnerCommandPrecondition('owner-handoff-expired', 'the staged change has expired');
      const session = await createEditSession({ config, renderer: { relativePath: handoff.source.path, slug: handoff.slug } });
      const derived = deriveOwnerDirect({ config, session, handoff });
      const stored = directEdits.create({ ...derived, stageId, sessionId: principal.sessionId });
      return { ...derived, editId: stored.id, operationCount: handoff.operations.length };
    }, { preserveCode: true }),

    saveOwnerDirect: command('save', 'owner-save-failed', async (input, principal) => {
      const { editId } = input;
      const edit = directEdits.get(editId);
      if (!edit || edit.sessionId !== principal.sessionId || !handoffs.get(edit.stageId)) {
        throw new OwnerCommandPrecondition('owner-handoff-expired', 'the staged change has expired');
      }
      if (inFlight.has(edit.stageId)) throw new OwnerCommandPrecondition('save-in-progress', 'a Save is already in progress');
      inFlight.add(edit.stageId);
      try {
        const jobId = validateJobId(createJobId());
        const session = await authorizeOwnerDirect({ context: storeContextFromConfig(config, projectRoot), jobId, session: edit.session, operation: edit.operation });
        const accepted = await saveEdit({ jobId, session, operation: edit.operation });
        if (accepted?.jobId !== jobId || accepted.state !== 'accepted') fail('owner-save-failed', 'Save did not return exact durable acceptance');
        directEdits.delete(editId);
        handoffs.delete(edit.stageId);
        return { jobId, state: 'accepted' };
      } finally {
        inFlight.delete(edit.stageId);
      }
    }, { preserveCode: true }),

    openRawEdit: command('read', 'edit-session-failed', async (input) => {
      const session = await createEditSession({ config, renderer: input });
      if (typeof session?.source?.text !== 'string') {
        throw new OwnerCommandPrecondition('invalid-edit-session', 'the source session did not contain editable text');
      }
      const stored = editSessions.create(session);
      return { session, editSessionId: stored.id };
    }),

    saveRawEdit: command('save', 'save-failed', async (input) => {
      const { editSessionId, editedText } = input;
      if (typeof editedText !== 'string' || Buffer.byteLength(editedText, 'utf8') > config.limits.maxSourceBytes) {
        fail('invalid-save-request', 'the edited text exceeds the source limit or is not text');
      }
      const session = editSessions.get(editSessionId);
      if (session === null) throw new OwnerCommandPrecondition('edit-session-expired', 'the edit session has expired');
      if (inFlight.has(editSessionId)) throw new OwnerCommandPrecondition('save-in-progress', 'a Save is already in progress');
      inFlight.add(editSessionId);
      let jobId;
      let started;
      try {
        jobId = validateJobId(createJobId());
        started = await saveEdit({ jobId, session, editedText });
        if (!started || started.jobId !== jobId || started.state !== 'accepted') {
          throw new OwnerAlphaError('invalid-save-acceptance', 'Save did not return exact durable acceptance');
        }
      } catch (error) {
        inFlight.delete(editSessionId);
        if (error instanceof OwnerAlphaError) throw error;
        throw new OwnerCommandPrecondition('save-failed', 'Save failed');
      }
      editSessions.delete(editSessionId);
      inFlight.delete(editSessionId);
      return { jobId, state: started.state ?? 'accepted' };
    }),

    listProposals: command('review', 'review-list-failed', async (input) => {
      return proposalReview.list(input);
    }),

    readProposal: command('review', 'review-load-failed', async (input) => {
      return proposalReview.load(input.queueId);
    }),

    recordDecision: command('review', 'decision-record-failed', async (input) => {
      const recorded = await proposalReview.record(input);
      const summary = recorded.index.decisions.find((entry) => entry.queueId === input.queueId);
      if (!summary) fail('invalid-decision-result', 'decision index omitted its new immutable decision');
      return { action: recorded.decision.action, decidedAt: recorded.decision.decidedAt, replayed: recorded.replayed, summary };
    }),

    readDecision: command('review', 'decision-load-failed', async (input) => {
      const { queueId } = input;
      const history = await proposalReview.loadDecision(queueId);
      if (history === null) throw new OwnerCommandPrecondition('decision-not-found', 'the decision was not found');
      let application = null;
      if (history.decision.action === 'approve' && typeof proposalReview.applicationStatus === 'function') {
        try {
          application = await proposalReview.applicationStatus(queueId);
        } catch (error) {
          application = {
            queueId,
            state: 'unknown',
            reason: error instanceof OwnerAlphaError ? error.code : 'application-status-failed',
          };
        }
      }
      return { ...history, application };
    }),

    applyProposal: command('apply', 'application-failed', async (input) => {
      return proposalReview.apply(input.queueId);
    }),

    preparePublication: command('publication', 'publication-prepare-failed', async (input) => {
      return publication.prepare(input);
    }),

    readPublicationCurrent: command('publication', 'publication-review-unavailable', async (input) => {
      return publication.loadCurrent(input);
    }),

    readPublicationReview: command('publication', 'publication-review-unavailable', async (input) => {
      const draft = await publication.load(input);
      const job = await publication.readJob(draft.jobId);
      return { draft, job, publishAvailable: publication.publishAvailable === true };
    }),

    publish: command('publish', 'publication-publish-refused', async (input) => {
      return publication.publish(input);
    }),

    readJob: command('read', 'job-lookup-failed', async (input) => {
      const jobId = validateJobId(input?.jobId);
      let job;
      try {
        job = await lookupJob(jobId);
      } catch (error) {
        if (error instanceof OwnerAlphaError && ['artifact-not-found', 'job-not-found'].includes(error.code)) {
          fail('job-not-found', 'the job was not found');
        }
        fail('job-lookup-failed', 'the job lookup failed');
      }
      if (!job || job.jobId !== jobId) fail('job-not-found', 'the job was not found');
      return job;
    }),
  });
}
