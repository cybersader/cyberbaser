import { validateOwnerAlphaConfig } from '../config.js';
import { fail, OwnerAlphaError } from '../errors.js';
import { validateJobId } from '../job-state.js';
import { isPlainObject } from '../json.js';
import { authorizeOwnerDirect, deriveOwnerDirect, validateOwnerHandoff } from '../owner-direct.js';
import { isPublicationDigest } from '../owner-publication.js';
import { validatePublicationDraftId } from '../owner-publication-store.js';
import { storeContextFromConfig } from '../store.js';
import { actorAllowsGrant } from './grants.js';
import { createCaptureProposalBuilder, deliveryPathFor } from './capture-submission.js';
import { createProposalSubmission } from './proposal-submission.js';
import { refuseSignedRequest } from './signed-request.js';

const signedCommands = new WeakMap();

export async function executeSigned(commands, verifier, envelope) {
  const registered = signedCommands.get(commands);
  const { command, input, principal } = verifier.verify(envelope, (name) => registered?.has(name) === true);
  const run = registered?.get(command);
  if (!run) refuseSignedRequest();
  return run(input, principal);
}

function directEditScope(principal) {
  return principal.method === 'device-key' ? { deviceKeyId: principal.keyId } : { sessionId: principal.sessionId };
}

function closedInput(input, required, optional = []) {
  if (!isPlainObject(input) || !Object.hasOwn(input, required)) {
    fail('invalid-command-input', 'owner command requires its declared input fields');
  }
  return Object.fromEntries(Reflect.ownKeys(input).map((key) => {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if ((key !== required && !optional.includes(key)) || !field || !Object.hasOwn(field, 'value')) {
      fail('invalid-command-input', 'owner command accepts only its declared data fields');
    }
    return [key, field.value];
  }));
}

function mappingInput(input, optional) {
  const request = closedInput(input, 'mappingId', optional);
  const { mappingId } = request;
  if (typeof mappingId !== 'string' || mappingId.length > 128 || mappingId.trim() !== mappingId
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(mappingId) || mappingId.includes('..')) {
    fail('invalid-publication-mapping-id', 'mapping id must be one opaque safe identifier');
  }
  return request;
}

function draftInput(input) {
  return { draftId: validatePublicationDraftId(closedInput(input, 'draftId').draftId) };
}

// Distinguish command preconditions from same-named errors raised by injected
// effects, whose existing HTTP error mappings differ.
export class OwnerCommandPrecondition extends OwnerAlphaError {}

export function createOwnerCommands({
  config: configInput, projectRoot, principalAdapter, devicePrincipalAdapter = null, createEditSession,
  editSessions, handoffs, directEdits, saveEdit, lookupJob, createJobId,
  proposalReview = null, publication = null, proposalClock = Date.now, readCaptureBase,
  // Optional: status for every published note, and the owner's note links.
  noteStatus = null, noteLinks = null,
  // Optional: the relay between the publisher and the owner's signing device
  // (core/approvals.js). Only owner devices that may publish reach it.
  approvals = null,
}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (devicePrincipalAdapter !== null && devicePrincipalAdapter.ownerId !== config.owner.identity) {
    throw new TypeError('device registry owner does not match the configured owner');
  }
  const inFlight = new Set();
  const signedHandlers = new Map();
  const submitProposal = createProposalSubmission({
    clock: proposalClock,
    submit: (input) => proposalReview.submitSigned(input),
  });
  const buildCapture = createCaptureProposalBuilder({ config, clock: proposalClock,
    resolvePath: (notePath) => noteLinks?.resolve(notePath) ?? null,
    ...(readCaptureBase === undefined ? {} : { readBase: readCaptureBase }) });
  const isOwnerDevice = (principal) => principal?.method === 'device-key' && principal.actor?.kind === 'owner-device'
    && principal.id === config.owner.identity;
  // A device Send the node cannot place: leave a request for the owner's
  // linking step and give the device one plain reason.
  const needsLinking = (principal, notePath, text = null) => {
    if (noteLinks === null || !isOwnerDevice(principal)) return false;
    return noteLinks.request({ notePath, text }) !== null;
  };
  // The public tier of note status: what the public site shows anyway.
  const publicStatusAllowed = (principal) => devicePrincipalAdapter?.isVerified(principal) === true
    && principal.method === 'device-key'
    && ['publication', 'propose'].some((grant) => actorAllowsGrant(principal.actor.kind, grant)
      && devicePrincipalAdapter.hasGrant(principal, grant));

  // An owner device the owner allowed to publish. Independent of the owner
  // publication page: a signing device approves every kind of publish.
  function signingGrant(principal) {
    if (!isOwnerDevice(principal) || devicePrincipalAdapter?.isVerified(principal) !== true
      || !devicePrincipalAdapter.hasGrant(principal, 'publish')) refuseSignedRequest();
    if (approvals === null) fail('signing-unavailable', 'this node does not relay signed approvals');
  }

  function requireGrant(grant, principal) {
    const bootstrap = principalAdapter?.isVerified(principal) && principal.method === 'bootstrap-session';
    const device = !bootstrap && devicePrincipalAdapter?.isVerified(principal) && principal.method === 'device-key'
      && actorAllowsGrant(principal.actor.kind, grant) && devicePrincipalAdapter.hasGrant(principal, grant);
    if (grant === 'propose') {
      if (!device) refuseSignedRequest();
      if (!config.proposalReview.enabled || typeof proposalReview?.submitSigned !== 'function') {
        fail('proposal-submission-refused', 'proposal submission was refused');
      }
      return;
    }
    if ((!bootstrap && !device) || principal.id !== config.owner.identity) refuseSignedRequest();
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
    const run = async (input, principal) => {
      // A function grant decides for itself and passes its tier to execute.
      const tier = typeof grant === 'function' ? grant(principal) : requireGrant(grant, principal);
      // A device attestation authorizes only its one signed request, even if
      // an in-process binding invokes the core without executeSigned().
      if (principal.method === 'device-key'
        && !devicePrincipalAdapter.consumeRequest(principal, signedHandlers.get(run), input)) refuseSignedRequest();
      try {
        return await execute(input, principal, tier);
      } catch (error) {
        if (error instanceof OwnerAlphaError) throw error;
        fail(preserveCode ? error?.code ?? fallback : fallback, 'owner command failed');
      }
    };
    signedHandlers.set(run, null);
    return run;
  }

  const commands = Object.freeze({
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
      const stored = directEdits.create({ ...derived, stageId, ...directEditScope(principal) });
      return { ...derived, editId: stored.id, operationCount: handoff.operations.length };
    }, { preserveCode: true }),

    saveOwnerDirect: command('save', 'owner-save-failed', async (input, principal) => {
      const { editId } = input;
      const edit = directEdits.get(editId);
      const scope = directEditScope(principal);
      if (!edit || edit.sessionId !== scope.sessionId || edit.deviceKeyId !== scope.deviceKeyId || !handoffs.get(edit.stageId)) {
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

    submitProposal: command('propose', 'proposal-submission-refused', submitProposal),

    // A paired device's open note, bound by the node to the committed vault
    // text and queued as an ordinary proposal: same grant, budget and queue
    // rules as submitProposal.
    submitCapture: command('propose', 'proposal-submission-refused', async (input, principal) => {
      let deliveryPath = null;
      const receipt = await submitProposal.submitBuilt(async () => {
        let built;
        try { built = await buildCapture(input); } catch (error) {
          // No committed file at the path the node would use, and the owner
          // has not linked this note: ask the owner to link it on the node.
          if (error instanceof OwnerAlphaError && error.code === 'capture-base-unavailable'
            && noteLinks?.resolve(input.path) === null && needsLinking(principal, input.path, input.text)) {
            fail('note-needs-linking', 'link this note to the vault on the node first');
          }
          throw error;
        }
        deliveryPath = built.deliveryPath;
        return built.unchanged ? null : built.proposal;
      }, principal);
      return receipt === null ? { unchanged: true, deliveryPath } : { ...receipt, deliveryPath };
    }, { preserveCode: true }),

    // Whether the device's open note is public and which version is live.
    // Owner devices with the publication grant get the full answer (drafts,
    // the publication page, publishing). Any device holding `propose` gets
    // only what the public site shows: public or not, and the live version.
    // Paths, never note text; only the path the device asked about.
    readNoteStatus: command((principal) => {
      try { requireGrant('publication', principal); return 'owner'; } catch (error) {
        if (!publicStatusAllowed(principal)) throw error;
        return 'public';
      }
    }, 'publication-status-unavailable', async (input, principal, tier) => {
      const { path: notePath } = closedInput(input, 'path');
      if (typeof notePath !== 'string' || notePath.length > 1024) fail('invalid-command-input', 'path must be text');
      const publishAvailable = tier === 'owner' && publication?.publishAvailable === true;
      const mapping = tier === 'owner' ? config.ownerPublication.mappings.find((entry) => entry.source.path === notePath
        || entry.relativePath === notePath) : undefined;
      if (mapping && publication !== null) {
        const status = await publication.readStatus({ mappingId: mapping.id });
        const live = status.live === null ? null : { version: status.live.version,
          digest: status.live.foldedTextDigest ?? status.live.digest, folded: status.live.foldedTextDigest !== undefined };
        // When it was confirmed live: the publication job's own record, else
        // the verified deployment when it carries this same text.
        if (live !== null && typeof status.live.confirmedAt === 'string') live.at = status.live.confirmedAt;
        else if (live !== null && noteStatus !== null) {
          const general = await noteStatus.status(mapping.relativePath).catch(() => null);
          if (general?.live?.digest === live.digest) live.at = general.live.at;
        }
        const latest = status.latest === null ? null : { version: status.latest.version, state: status.latest.state,
          draftId: status.latest.draftId };
        return { path: notePath, selected: true, mappingId: mapping.id, workspace: mapping.source.kind === 'workspace',
          live, latest, publishAvailable };
      }
      if (noteStatus === null) return tier === 'owner' ? { path: notePath, selected: false, publishAvailable } : { path: notePath, selected: false, live: null };
      const vaultPath = noteLinks?.resolve(notePath) ?? deliveryPathFor(config, notePath);
      const found = await noteStatus.status(vaultPath);
      const live = found.live === null ? null : { digest: found.live.digest, folded: true, at: found.live.at };
      return tier === 'owner' ? { path: notePath, selected: found.selected, live, publishAvailable: false }
        : { path: notePath, selected: found.selected, live };
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

    preparePublication: command('publication', 'publication-prepare-failed', async (input, principal) => {
      const request = mappingInput(input, ['expectedVersion', 'expectedDigest']);
      if (Object.hasOwn(request, 'expectedVersion')
        && (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion <= 0)) {
        fail('invalid-publication-expected-version', 'expected version must be a positive safe integer');
      }
      if (Object.hasOwn(request, 'expectedDigest') && !isPublicationDigest(request.expectedDigest)) {
        fail('invalid-publication-expected-digest', 'expected digest must be one canonical SHA-256 digest');
      }
      try {
        return await publication.prepare(request);
      } catch (error) {
        // The publication page has no baseline yet: the owner links it on the node.
        const mapping = config.ownerPublication.mappings.find((entry) => entry.id === request.mappingId);
        if (error instanceof OwnerAlphaError && error.code === 'workspace-unbound' && mapping
          && needsLinking(principal, mapping.source.path)) {
          fail('note-needs-linking', 'link this note to the vault on the node first');
        }
        throw error;
      }
    }),

    readPublicationStatus: command('publication', 'publication-status-unavailable', async (input) => {
      return publication.readStatus(mappingInput(input));
    }),

    readPublicationReceipt: command('publication', 'publication-receipt-unavailable', async (input) => {
      return publication.readReceipt(draftInput(input));
    }),

    readPublicationCurrent: command('publication', 'publication-review-unavailable', async (input) => {
      return publication.loadCurrent(input);
    }),

    readPublicationReview: command('publication', 'publication-review-unavailable', async (input) => {
      const draft = await publication.load(draftInput(input));
      const job = await publication.readJob(draft.jobId);
      return { draft, job, publishAvailable: publication.publishAvailable === true };
    }),

    publish: command('publish', 'publication-publish-refused', async (input) => {
      return publication.publish(draftInput(input));
    }),

    // Signing device: enrol with the publisher, then approve publishes. The
    // node relays; the device and the publisher check everything themselves.
    readSigningChallenge: command(signingGrant, 'signing-unavailable', async (input) => {
      const { publisher } = closedInput(input, 'publisher');
      if (typeof publisher !== 'string' || !/^[0-9a-f]{64}$/u.test(publisher)) fail('invalid-command-input', 'publisher must be 64 hex');
      return approvals.challenge();
    }, { preserveCode: true }),
    enrollSigningKey: command(signingGrant, 'enroll-refused', async (input) => {
      const { intent, approval } = closedInput(input, 'intent', ['approval']);
      return approvals.enroll({ intent, approval });
    }, { preserveCode: true }),
    listApprovals: command(signingGrant, 'approval-not-found', async (input) => {
      if (closedInput(input, 'waiting').waiting !== true) fail('invalid-command-input', 'waiting must be true');
      return { waiting: await approvals.list() };
    }),
    readApproval: command(signingGrant, 'approval-not-found', async (input) => {
      return approvals.read(closedInput(input, 'requestId'));
    }),
    submitApproval: command(signingGrant, 'approval-invalid', async (input) => {
      return approvals.submit(closedInput(input, 'requestId', ['intent', 'approval']));
    }),
    declineApproval: command(signingGrant, 'approval-not-found', async (input) => {
      return approvals.decline(closedInput(input, 'requestId'));
    }),

    readJob: command('read', 'job-lookup-failed', async (input) => {
      const jobId = validateJobId(closedInput(input, 'jobId').jobId);
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
  // Only public command wrappers belong here, never requireGrant or the
  // browser's anonymous owner-direct staging route.
  const byName = new Map();
  for (const [name, run] of Object.entries(commands)) {
    if (!signedHandlers.has(run)) continue;
    signedHandlers.set(run, name);
    byName.set(name, run);
  }
  signedCommands.set(commands, byName);
  return commands;
}
