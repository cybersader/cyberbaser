// The owner pipeline keeps the original complete v2 artifact through recovery.
// No contiguous replacement or presentation diff is substituted for its operations.
import { applyChangeSetProposal, validateChangeSetProposal } from '@cyberbaser/proposal';
import { fail } from './errors.js';

export function changeSetCorrection(proposalInput) {
  const proposal = validateChangeSetProposal(proposalInput);
  const file = proposal.changeSet.files[0];
  return {
    operationType: 'change-set', proposal,
    baseByteLength: file.base.byteLength, baseDigest: file.base.digest,
    candidateByteLength: file.candidate.byteLength, candidateDigest: file.candidate.digest,
  };
}

export function validateChangeSetCorrection(value) {
  const correction = changeSetCorrection(value.proposal);
  for (const key of ['operationType', 'baseByteLength', 'baseDigest', 'candidateByteLength', 'candidateDigest']) {
    if (value[key] !== correction[key]) fail('change-set-binding-mismatch', `change set ${key} does not match its complete proposal`);
  }
  if (value.source && value.source.relativePath !== correction.proposal.changeSet.files[0].path) {
    fail('change-set-binding-mismatch', 'change set path does not match the owner operation');
  }
  return correction;
}

export function applyOwnerChangeSet(base, operation) {
  const correction = validateChangeSetCorrection(operation);
  return applyChangeSetProposal(base, correction.proposal);
}

export function changeSetStats(proposal) {
  const operations = validateChangeSetProposal(proposal).changeSet.files[0].operations;
  const lines = (text) => text.length === 0 ? 0 : text.split('\n').length;
  return operations.reduce((sum, op) => ({
    changedBytes: sum.changedBytes + Math.max(Buffer.byteLength(op.expected), Buffer.byteLength(op.replacement)),
    changedLines: sum.changedLines + Math.max(lines(op.expected), lines(op.replacement)),
    replacementBytes: sum.replacementBytes + Buffer.byteLength(op.replacement),
  }), { changedBytes: 0, changedLines: 0, replacementBytes: 0 });
}

/** Independent proof for every undeclared interval, including gaps between edits. */
export function proveChangeSetOutsideBytes(base, candidate, proposal) {
  const operations = validateChangeSetProposal(proposal).changeSet.files[0].operations;
  let baseOffset = 0;
  let candidateOffset = 0;
  for (const op of operations) {
    const length = op.start - baseOffset;
    if (!base.subarray(baseOffset, op.start).equals(candidate.subarray(candidateOffset, candidateOffset + length))) {
      fail('outside-operation-bytes-changed', 'an undeclared interval between changes was modified');
    }
    candidateOffset += length + Buffer.byteLength(op.replacement);
    baseOffset = op.end;
  }
  if (!base.subarray(baseOffset).equals(candidate.subarray(candidateOffset))) fail('outside-operation-bytes-changed', 'undeclared suffix changed');
  return { operationCount: operations.length, outsideBytesIdentical: true };
}
