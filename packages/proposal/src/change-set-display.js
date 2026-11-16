import { ProposalError, applyProposal, proposalDigest, deepFreeze, requireExactKeys, requireSafeInteger, utf8Bytes } from './proposal.js';
import { applyChangeSetProposal, changeSetProposalDigest, validateChangeSetProposal, projectV1ToChangeSet } from './change-set.js';

function position(base, offset) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (base[index] === 10) { line += 1; column = 1; }
    else if ((base[index] & 0xc0) !== 0x80) column += 1;
  }
  return { line, column };
}

function context(base, start, end, count) {
  if (count === 0) return { before: '', after: '' };
  let left = Math.max(0, start - count * 4);
  let right = Math.min(base.length, end + count * 4);
  while (left < start && (base[left] & 0xc0) === 0x80) left += 1;
  while (right < base.length && (base[right] & 0xc0) === 0x80) right += 1;
  return {
    before: Array.from(base.subarray(left, start).toString('utf8')).slice(-count).join(''),
    after: Array.from(base.subarray(end, right).toString('utf8')).slice(0, count).join(''),
  };
}

/** Source-verified display data. Columns are 1-based Unicode code points, not bytes. */
export function describeChangeSet(baseBytes, value, options = {}) {
  const keys = Object.keys(options);
  if (keys.some((key) => key !== 'contextCodePoints')) throw new ProposalError('unknown-field', 'unknown display option');
  const contextCodePoints = options.contextCodePoints ?? 40;
  requireSafeInteger(contextCodePoints, 'contextCodePoints');
  if (contextCodePoints > 200) throw new ProposalError('context-too-large', 'context is limited to 200 code points per side');
  const isV1 = value?.schemaVersion === 1;
  // Always apply the original v1 artifact to retain its quote-uniqueness checks.
  if (isV1) applyProposal(baseBytes, value);
  else applyChangeSetProposal(baseBytes, value);
  const proposal = isV1 ? projectV1ToChangeSet(value) : validateChangeSetProposal(value);
  const base = Buffer.from(baseBytes);
  const file = proposal.changeSet.files[0];
  return deepFreeze({
    version: isV1 ? 1 : 2,
    proposalId: proposal.proposalId,
    proposalDigest: isV1 ? proposalDigest(value) : changeSetProposalDigest(value),
    path: file.path,
    operations: file.operations.map((operation) => ({
      ...operation,
      startPosition: position(base, operation.start),
      endPosition: position(base, operation.end),
      context: context(base, operation.start, operation.end, contextCodePoints),
    })),
  });
}

// Plain-text display escaping, not a lossless CriticMarkup import/export codec.
// Hosts must render this text as text, never insert it as HTML.
const escapeCriticText = (text) => text.replace(/[\\{}~]/gu, '\\$&');
export const criticMarkupAdapter = Object.freeze({
  id: 'critic-markup',
  renderOperation(operation) {
    const old = escapeCriticText(operation.expected);
    const replacement = escapeCriticText(operation.replacement);
    if (operation.start === operation.end) return `{++${replacement}++}`;
    if (operation.replacement === '') return `{--${old}--}`;
    return `{~~${old}~>${replacement}~~}`;
  },
});

export const changeSetDisplayAdapters = Object.freeze({ 'critic-markup': criticMarkupAdapter });

/** Adapter interface: {id: string, renderOperation(frozenDescription): string}.
 * The core verifies all source bindings first and refuses malformed providers or
 * output. No provider output is ever part of the integrity envelope.
 */
export function renderChangeSet(baseBytes, value, adapter = criticMarkupAdapter, options = {}) {
  const description = describeChangeSet(baseBytes, value, options);
  requireExactKeys(adapter, ['id', 'renderOperation'], 'display adapter');
  if (typeof adapter.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(adapter.id)
    || typeof adapter.renderOperation !== 'function') {
    throw new ProposalError('invalid-display-adapter', 'adapter requires a bounded ID and renderOperation function');
  }
  const operations = description.operations.map((operation) => {
    let rendered;
    try { rendered = adapter.renderOperation(operation); }
    catch { throw new ProposalError('display-adapter-failed', 'display adapter failed'); }
    utf8Bytes(rendered, 'display adapter output', { maxBytes: 512 * 1024 });
    return { operationId: operation.operationId, text: rendered };
  });
  return deepFreeze({ adapter: adapter.id, proposalDigest: description.proposalDigest, operations });
}
