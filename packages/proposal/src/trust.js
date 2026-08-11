import { TextDecoder } from 'node:util';
import { classify } from '@cyberbaser/trust';
import {
  applyProposal,
  proposalDigest,
  ProposalError,
  validateProposal,
} from './proposal.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const VERIFIED_SUBJECT_KEYS = ['author', 'authorType'];

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeVerifiedSubject(value) {
  if (value === undefined || value === null) {
    return { author: '', authorType: 'anonymous' };
  }
  if (!isRecord(value)) {
    throw new ProposalError(
      'invalid-verified-subject',
      'verifiedSubject must be an object supplied by the receiving lane',
    );
  }
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !VERIFIED_SUBJECT_KEYS.includes(key));
  const missing = VERIFIED_SUBJECT_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new ProposalError(
      'invalid-verified-subject',
      'verifiedSubject must contain exactly author and authorType',
    );
  }
  if (!['human', 'agent'].includes(value.authorType)) {
    throw new ProposalError(
      'invalid-verified-subject',
      'verifiedSubject.authorType must be human or agent',
    );
  }
  if (typeof value.author !== 'string' || value.author.trim().length === 0) {
    throw new ProposalError(
      'invalid-verified-subject',
      'verifiedSubject.author must be a nonblank receiver-verified identifier',
    );
  }
  return { author: value.author, authorType: value.authorType };
}

function countLeadingUtf8Boms(bytes) {
  let count = 0;
  let offset = 0;
  while (
    bytes.length - offset >= UTF8_BOM.length
    && bytes.subarray(offset, offset + UTF8_BOM.length).equals(UTF8_BOM)
  ) {
    count += 1;
    offset += UTF8_BOM.length;
  }
  return count;
}

function freezeChange(change) {
  Object.freeze(change.files[0]);
  Object.freeze(change.files);
  Object.freeze(change.meta.source);
  Object.freeze(change.meta.evidence);
  if (change.meta.identityClaim !== null) Object.freeze(change.meta.identityClaim);
  Object.freeze(change.meta);
  return Object.freeze(change);
}

export function proposalToTrustChange(baseBytes, value, verifiedSubject) {
  const proposal = validateProposal(value);
  const base = Buffer.from(baseBytes);
  const candidate = applyProposal(base, proposal);
  const baseBomCount = countLeadingUtf8Boms(base);
  const candidateBomCount = countLeadingUtf8Boms(candidate);
  if (baseBomCount !== candidateBomCount) {
    throw new ProposalError(
      'leading-bom-change',
      'trust conversion refuses a change that adds or removes a leading UTF-8 BOM',
    );
  }
  const trustOffset = baseBomCount * UTF8_BOM.length;
  let before;
  let after;
  try {
    before = UTF8_DECODER.decode(base.subarray(trustOffset));
    after = UTF8_DECODER.decode(candidate.subarray(trustOffset));
  } catch {
    throw new ProposalError(
      'invalid-utf8',
      'proposal trust conversion requires valid UTF-8 base and candidate bytes',
    );
  }
  const subject = normalizeVerifiedSubject(verifiedSubject);
  return freezeChange({
    author: subject.author,
    authorType: subject.authorType,
    files: [{
      path: proposal.source.path,
      before,
      after,
      status: 'modified',
    }],
    meta: {
      proposalId: proposal.proposalId,
      proposalDigest: proposalDigest(proposal),
      submittedAt: proposal.submission.submittedAt,
      rationale: proposal.submission.rationale,
      evidence: [...proposal.submission.evidence],
      source: { ...proposal.source },
      identityClaim: proposal.submission.identityClaim === null
        ? null
        : { ...proposal.submission.identityClaim },
    },
  });
}

export function classifyProposal(
  baseBytes,
  value,
  trustConfig,
  verifiedSubject,
) {
  return classify(
    proposalToTrustChange(baseBytes, value, verifiedSubject),
    trustConfig,
  );
}
