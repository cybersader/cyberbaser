import { validateQueueId, validateSignedProposal } from '@cyberbaser/proposal-queue';
import { fail } from '../errors.js';

export const PROPOSAL_BUDGET = Object.freeze({ windowMs: 60_000, attempts: 8, bytes: 512 * 1024, keys: 256 });

function refuseProposal() {
  fail('proposal-submission-refused', 'proposal submission was refused');
}

function refuseBudget() {
  fail('proposal-budget-exhausted', 'proposal submission budget is unavailable');
}

export function createProposalSubmission({ clock, submit }) {
  if (typeof clock !== 'function') throw new TypeError('proposal submission requires a clock');
  const counters = new Map();
  let lastTime = -1;

  function chargeAttempt(keyId) {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < lastTime) refuseBudget();
    lastTime = now;
    let counter = counters.get(keyId);
    if (counter && now - counter.start >= PROPOSAL_BUDGET.windowMs) {
      counters.delete(keyId);
      counter = null;
    }
    if (!counter) {
      if (counters.size >= PROPOSAL_BUDGET.keys) {
        for (const [key, previous] of counters) {
          if (now - previous.start >= PROPOSAL_BUDGET.windowMs) counters.delete(key);
        }
        if (counters.size >= PROPOSAL_BUDGET.keys) refuseBudget();
      }
      counter = { start: now, attempts: 0, bytes: 0 };
      counters.set(keyId, counter);
    }
    if (counter.attempts >= PROPOSAL_BUDGET.attempts) refuseBudget();
    counter.attempts += 1;
    return counter;
  }

  // `build` runs after the attempt is charged, so a device cannot make the node
  // read Git repeatedly for free. It returns the proposal input, or null when
  // there is nothing to submit.
  async function submitBuilt(build, principal) {
    const counter = chargeAttempt(principal.keyId);
    const input = await build();
    if (input === null) return null;
    return submitCharged(counter, input, principal);
  }

  async function submitCharged(counter, input, principal) {
    const { kind, id, label } = principal.actor;
    const submitter = Object.freeze({ kind, id, label, keyId: principal.keyId });
    let validated;
    try {
      validated = validateSignedProposal(input, submitter);
    } catch {
      refuseProposal();
    }
    const bytes = Buffer.byteLength(validated.proposalText, 'utf8');
    if (counter.bytes + bytes > PROPOSAL_BUDGET.bytes) refuseBudget();
    counter.bytes += bytes;
    try {
      const { queueId, acceptedAt, baseBound } = await submit({ proposalText: validated.proposalText, submitter });
      if (baseBound !== true || typeof acceptedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(acceptedAt)
        || new Date(acceptedAt).toISOString().replace('.000Z', 'Z') !== acceptedAt) refuseProposal();
      return Object.freeze({ queueId: validateQueueId(queueId), acceptedAt, baseBound: true });
    } catch {
      refuseProposal();
    }
  }

  const run = (input, principal) => submitCharged(chargeAttempt(principal.keyId), input, principal);
  run.submitBuilt = submitBuilt;
  return run;
}
