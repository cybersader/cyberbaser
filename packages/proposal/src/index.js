export {
  PROPOSAL_SCHEMA_VERSION,
  PROPOSAL_ARTIFACT_TYPE,
  PROPOSAL_MAX_BYTES,
  PROPOSAL_MAX_SPAN_BYTES,
  ProposalError,
  prepareProposal,
  validateProposal,
  serializeProposal,
  parseProposal,
  proposalDigest,
  applyProposal,
} from './proposal.js';

export {
  proposalToTrustChange,
  classifyProposal,
} from './trust.js';
