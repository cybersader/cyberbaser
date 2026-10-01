import { createHash } from 'node:crypto';

export class ResearchChangeSetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResearchChangeSetError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new ResearchChangeSetError(code, message); };
const digest = (bytes) => `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
function boundary(bytes, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) return false;
  if (offset === 0 || offset === bytes.length) return true;
  return (bytes[offset] & 0xc0) !== 0x80;
}

export function validateResearchChangeSet(baseInput, operationsInput) {
  const base = Buffer.from(baseInput);
  if (base.toString('utf8') !== new TextDecoder('utf-8', { fatal: true }).decode(base)) fail('invalid-base-utf8', 'research base must use valid UTF-8');
  if (!Array.isArray(operationsInput) || operationsInput.length < 2) fail('operation-count', 'target-v2 research requires at least two operations');
  const operations = operationsInput.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-operation', `operation ${index + 1} must be an object`);
    const keys = ['operationId', 'label', 'start', 'end', 'replacement'];
    if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) fail('operation-shape', `operation ${index + 1} has an invalid shape`);
    if (typeof value.operationId !== 'string' || typeof value.label !== 'string' || typeof value.replacement !== 'string') fail('operation-string', `operation ${index + 1} has invalid text`);
    if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 0 || value.end < value.start || value.end > base.length) fail('operation-range', `operation ${index + 1} range is invalid`);
    if (!boundary(base, value.start) || !boundary(base, value.end)) fail('utf8-boundary', `operation ${index + 1} must align to UTF-8 boundaries`);
    const replacement = Buffer.from(value.replacement, 'utf8');
    if (replacement.toString('utf8') !== value.replacement) fail('invalid-replacement-utf8', `operation ${index + 1} replacement is invalid UTF-8`);
    const old = base.subarray(value.start, value.end);
    if (old.equals(replacement)) fail('no-op', `operation ${index + 1} is a no-op`);
    return Object.freeze({ ...value, oldText: old.toString('utf8'), replacementBytes: replacement });
  });
  for (let index = 1; index < operations.length; index += 1) {
    const previous = operations[index - 1];
    const current = operations[index];
    if (current.start < previous.start) fail('noncanonical-order', 'operations must arrive in canonical ascending order');
    if (current.start === previous.start) fail('duplicate-start', 'operations cannot share a base start boundary');
    if (current.start < previous.end) fail('overlap', 'operations cannot overlap');
  }
  return Object.freeze({ baseByteLength: base.length, baseDigest: digest(base), operations: Object.freeze(operations) });
}

export function buildResearchCandidate(baseInput, operationsInput) {
  const base = Buffer.from(baseInput);
  const validated = validateResearchChangeSet(base, operationsInput);
  const pieces = [];
  let cursor = 0;
  for (const operation of validated.operations) {
    pieces.push(base.subarray(cursor, operation.start), operation.replacementBytes);
    cursor = operation.end;
  }
  pieces.push(base.subarray(cursor));
  const candidate = Buffer.concat(pieces);
  return Object.freeze({
    base,
    candidate,
    baseByteLength: base.length,
    candidateByteLength: candidate.length,
    baseDigest: validated.baseDigest,
    candidateDigest: digest(candidate),
    operations: validated.operations,
  });
}
