export class OwnerAlphaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OwnerAlphaError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  throw new OwnerAlphaError(code, message, details);
}
