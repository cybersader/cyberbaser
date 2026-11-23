import { validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { createProposalDecisionOverlay, recordProposalDecision, recoverProposalDecisions } from './proposal-decisions.js';
import { applyApprovedProposal, assessProposalApplication, listProposalApplicationProgress } from './proposal-application.js';

export function createOwnerProposalReviewService({
  config: configInput,
  context,
  source,
  decisionClock = () => new Date(),
  recoverDecisions = recoverProposalDecisions,
  recordDecision = recordProposalDecision,
  application = null,
  assessApplication = assessProposalApplication,
  applyApplication = applyApprovedProposal,
  listProgress = listProposalApplicationProgress,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (!config.proposalReview.enabled) return null;
  // Applying an approved suggestion needs the owner pipeline's Save entry, a
  // way to find the rendered page, and a job ID factory. Without them the
  // service still reviews and decides, and the receipt says applying is not
  // available here.
  if (application !== null
    && (typeof application.saveEdit !== 'function'
      || typeof application.createJobId !== 'function'
      || (typeof application.resolveSlug !== 'function'
        && (typeof application.siteRoot !== 'string' || typeof application.ownerOrigin !== 'string')))) {
    throw new TypeError('proposal application requires saveEdit, createJobId, and a slug resolver or siteRoot plus ownerOrigin');
  }
  if (!context
    || !source
    || typeof source.list !== 'function'
    || typeof source.load !== 'function'
    || typeof decisionClock !== 'function'
    || typeof recoverDecisions !== 'function'
    || typeof recordDecision !== 'function') {
    throw new TypeError('enabled proposal review requires context, source, clock, recovery, and decision dependencies');
  }

  let cachedDecisions = null;
  let recoveryInFlight = null;

  async function recovered({ refresh = false } = {}) {
    if (refresh && recoveryInFlight !== null) await recoveryInFlight;
    if (!refresh && cachedDecisions !== null) return cachedDecisions;
    if (recoveryInFlight !== null) return recoveryInFlight;
    recoveryInFlight = Promise.resolve(recoverDecisions(context)).then((value) => {
      cachedDecisions = value;
      return value;
    });
    try {
      return await recoveryInFlight;
    } finally {
      recoveryInFlight = null;
    }
  }

  return Object.freeze({
    ...(typeof source.submitSigned === 'function' ? {
      submitSigned: (input) => source.submitSigned(input, context.projectRoot),
    } : {}),
    async list({ cursor = null } = {}) {
      const local = await recovered();
      const seenCursors = new Set();
      let filteredEntries = 0;
      let pageCursor = cursor;
      let page;
      let complete;

      while (true) {
        const cursorKey = pageCursor ?? '<first-page>';
        if (seenCursors.has(cursorKey)) {
          throw new OwnerAlphaError('review-ipc-invalid-cursor', 'proposal review pagination repeated a cursor');
        }
        seenCursors.add(cursorKey);
        page = await source.list({
          state: 'pending-review',
          cursor: pageCursor,
          limit: config.proposalReview.maxListEntries,
        });
        complete = createProposalDecisionOverlay({
          entries: page.entries,
          decisions: local.decisions,
        });
        if (complete.actionable.length > 0 || page.nextCursor === null) break;
        if (page.entries.length === 0 || page.nextCursor === pageCursor) {
          throw new OwnerAlphaError('review-ipc-invalid-cursor', 'proposal review pagination made no forward progress');
        }
        filteredEntries += page.entries.length;
        if (filteredEntries > local.decisions.length) {
          throw new OwnerAlphaError('review-ipc-invalid-cursor', 'proposal review pagination exceeded the local decision bound');
        }
        pageCursor = page.nextCursor;
      }

      let history = complete.history.slice(0, config.proposalReview.maxListEntries);
      if (application !== null && history.length > 0) {
        // Applied and Live come from events and job state only; no Git here.
        const progress = await listProgress(context, config);
        history = history.map((entry) => Object.freeze({ ...entry, application: progress.get(entry.summary.queueId) ?? null }));
      }
      return Object.freeze({
        actionable: complete.actionable,
        history: Object.freeze(history),
        historyTruncated: complete.history.length > history.length,
        nextCursor: page.nextCursor,
      });
    },
    async load(queueId) {
      const local = await recovered();
      const decision = local.decisions.find((entry) => entry.queueId === queueId) ?? null;
      if (decision !== null) return Object.freeze({ entry: null, decision });
      return Object.freeze({ entry: await source.load(queueId), decision: null });
    },
    async loadDecision(queueId) {
      const local = await recovered();
      const decision = local.decisions.find((entry) => entry.queueId === queueId) ?? null;
      if (decision === null) return null;
      let queueRetained = null;
      let document = null;
      try {
        const current = await source.load(queueId);
        createProposalDecisionOverlay({ entries: [current], decisions: [decision] });
        queueRetained = true;
        // The overlay proved this entry is the decided one. Its pinned page
        // text is kept for display only, never written into the decision.
        document = current.document ?? null;
      } catch (error) {
        if (error instanceof OwnerAlphaError
          && ['review-ipc-not-found', 'review-ipc-queue-entry-not-found'].includes(error.code)) {
          queueRetained = false;
        } else if (error instanceof OwnerAlphaError
          && ['review-not-actionable', 'review-expired'].includes(error.code)) {
          queueRetained = true;
        } else if (!(error instanceof OwnerAlphaError)
          || !['review-source-unavailable', 'review-source-timeout'].includes(error.code)) {
          throw error;
        }
      }
      const overlay = createProposalDecisionOverlay({ entries: [], decisions: [decision] });
      return Object.freeze({ ...overlay.history[0], queueRetained, ...(document === null ? {} : { document }) });
    },
    async record(intent) {
      const result = await recordDecision({
        context,
        source,
        ownerIdentity: config.owner.identity,
        intent,
        clock: decisionClock,
      });
      await recovered({ refresh: true });
      return result;
    },
    applicationAvailable: application !== null,
    async applicationStatus(queueId) {
      if (application === null) return null;
      return assessApplication({
        context,
        config,
        queueId,
        git: application.git,
        resolveSlug: application.resolveSlug ?? null,
        siteRoot: application.siteRoot ?? null,
        ownerOrigin: application.ownerOrigin ?? null,
      });
    },
    async apply(queueId) {
      if (application === null) fail('application-unavailable', 'applying suggestions is not available in this runtime');
      return applyApplication({
        context,
        config,
        queueId,
        saveEdit: application.saveEdit,
        createJobId: application.createJobId,
        checkoutReady: application.checkoutReady,
        git: application.git,
        resolveSlug: application.resolveSlug ?? null,
        siteRoot: application.siteRoot ?? null,
        ownerOrigin: application.ownerOrigin ?? null,
        clock: application.clock,
      });
    },
  });
}
