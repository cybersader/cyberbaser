export class ProposalQueueError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProposalQueueError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  throw new ProposalQueueError(code, message, details);
}
