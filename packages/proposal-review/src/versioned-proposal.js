// Readers dispatch explicitly; legacy proposal APIs and persisted v1 records stay unchanged.
import {
  validateProposal, serializeProposal, proposalDigest, applyProposal, classifyProposal,
  validateChangeSetProposal, serializeChangeSetProposal, changeSetProposalDigest,
  applyChangeSetProposal, projectV1ToChangeSet, classifyChangeSetProposal,
} from '@cyberbaser/proposal';

export const validateReviewProposal = (value) => value?.schemaVersion === 2
  ? validateChangeSetProposal(value) : validateProposal(value);
export const serializeReviewProposal = (value) => value?.schemaVersion === 2
  ? serializeChangeSetProposal(value) : serializeProposal(value);
export const reviewProposalDigest = (value) => value?.schemaVersion === 2
  ? changeSetProposalDigest(value) : proposalDigest(value);
export const applyReviewProposal = (base, value) => value?.schemaVersion === 2
  ? applyChangeSetProposal(base, value) : applyProposal(base, value);

export function reviewProposalBinding(value) {
  const proposal = validateReviewProposal(value);
  const set = proposal.schemaVersion === 2 ? proposal.changeSet : projectV1ToChangeSet(proposal).changeSet;
  const file = set.files[0];
  return {
    source: { repository: set.repository, revision: set.baseRevision, path: file.path },
    base: file.base, candidate: file.candidate, operations: file.operations,
  };
}

/** Classify the whole verified candidate, never individual changes. Sender claims are not identity. */
export function classifyReviewProposal(baseBytes, value, config, verifiedSubject) {
  return value?.schemaVersion === 2
    ? classifyChangeSetProposal(baseBytes, value, config, verifiedSubject)
    : classifyProposal(baseBytes, value, config, verifiedSubject);
}
