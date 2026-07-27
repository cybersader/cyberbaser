import { TextDecoder } from 'node:util';
import { checkChange } from '@cyberbaser/ofm';
import { classify } from '@cyberbaser/trust';
import {
  parseSha256Digest,
  sha256Digest,
  verifySha256Digest,
} from './contracts.js';
import { isFixtureLogicalUrl } from './topology.js';

export class ProposalValidationError extends Error {
  constructor(code, message, phase = 'precondition', details = {}) {
    super(message);
    this.name = 'ProposalValidationError';
    this.code = code;
    this.phase = phase;
    this.details = details;
  }
}

function fail(code, message, phase = 'precondition', details = {}) {
  throw new ProposalValidationError(code, message, phase, details);
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-record', `${label} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail('invalid-string', `${label} must be a non-empty string`);
  return value;
}

function normalizePublisher(value) {
  let url;
  try {
    url = new URL(requireNonEmptyString(value, 'receiver.publisher'));
  } catch (error) {
    if (error instanceof ProposalValidationError) throw error;
    fail('invalid-receiver-publisher', 'receiver.publisher must be an absolute HTTPS origin');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    fail('invalid-receiver-publisher', 'receiver.publisher must be an absolute HTTPS origin');
  }
  return url.origin;
}

function normalizeTargetUrl(value, publisher, label) {
  let url;
  try {
    url = new URL(requireNonEmptyString(value, label));
  } catch (error) {
    if (error instanceof ProposalValidationError) throw error;
    fail('invalid-target-url', `${label} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.origin !== publisher
    || !isFixtureLogicalUrl(url.href)
  ) {
    fail('invalid-target-url', `${label} must be a fixture HTTPS URL owned by ${publisher}`);
  }
  return url.href;
}

function exactBuffer(value, label, phase = 'precondition') {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail('invalid-bytes', `${label} must be a Buffer or Uint8Array`, phase);
}

function decodeUtf8(bytes, label, phase) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid-utf8', `${label} must decode as valid UTF-8`, phase);
  }
}

/**
 * Verify the receiver-owned target and exact base representation. Digest
 * verification deliberately precedes splice normalization and every expensive
 * or policy-bearing operation.
 */
export function validateProposalBase({ proposal, receiver } = {}) {
  requireRecord(proposal, 'proposal');
  requireRecord(receiver, 'receiver');
  const proposalId = requireNonEmptyString(proposal.proposalId, 'proposal.proposalId');
  const publisher = normalizePublisher(receiver.publisher);
  const receiverTargetUrl = normalizeTargetUrl(receiver.targetUrl, publisher, 'receiver.targetUrl');
  const target = requireRecord(proposal.target, 'proposal.target');
  const proposalTargetUrl = normalizeTargetUrl(target.url, publisher, 'proposal.target.url');
  if (proposalTargetUrl !== receiverTargetUrl) {
    fail('target-url-mismatch', 'proposal target URL does not equal the receiver-owned target URL');
  }

  const currentBytes = exactBuffer(receiver.currentBytes, 'receiver.currentBytes');
  if (!Number.isSafeInteger(target.byteLength) || target.byteLength < 0) {
    fail('invalid-target-length', 'proposal.target.byteLength must be a non-negative safe integer');
  }
  if (currentBytes.byteLength !== target.byteLength) {
    fail('target-length-mismatch', 'receiver bytes do not match proposal.target.byteLength');
  }
  if (!parseSha256Digest(target.digest)) {
    fail('invalid-target-digest', 'proposal.target.digest must be an RFC-9530-style SHA-256 digest');
  }
  if (!verifySha256Digest(currentBytes, target.digest)) {
    fail('target-digest-mismatch', 'receiver bytes have changed since the proposal base was created');
  }

  return {
    proposalId,
    publisher,
    targetUrl: receiverTargetUrl,
    targetDigest: target.digest,
    targetByteLength: target.byteLength,
    currentBytes,
  };
}

/** Normalize ordered, non-overlapping splices expressed only as exact bytes. */
export function validateByteSplices(splices, baseByteLength) {
  if (!Number.isSafeInteger(baseByteLength) || baseByteLength < 0) {
    fail('invalid-base-length', 'baseByteLength must be a non-negative safe integer', 'splices');
  }
  if (!Array.isArray(splices) || splices.length === 0) {
    fail('invalid-splices', 'proposal.splices must be a non-empty array', 'splices');
  }

  let previousStart = -1;
  let previousEnd = 0;
  return splices.map((splice, index) => {
    requireRecord(splice, `proposal.splices[${index}]`);
    const { start, end } = splice;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      fail('invalid-splice-offset', `proposal.splices[${index}] start and end must be safe integers`, 'splices');
    }
    if (start < 0 || end < start || end > baseByteLength) {
      fail('splice-out-of-bounds', `proposal.splices[${index}] is outside the base byte range`, 'splices');
    }
    if (start < previousStart || start < previousEnd) {
      fail('splices-overlap-or-unsorted', 'proposal splices must be ordered and non-overlapping', 'splices', { index });
    }
    if (!Buffer.isBuffer(splice.insert)) {
      fail('splice-insert-not-buffer', `proposal.splices[${index}].insert must be a Buffer`, 'splices');
    }
    previousStart = start;
    previousEnd = end;
    return {
      start,
      end,
      insert: Buffer.from(splice.insert),
    };
  });
}

/** Apply original-coordinate byte splices without parsing or serializing text. */
export function applyByteSplices(baseBytes, splices) {
  const base = exactBuffer(baseBytes, 'baseBytes', 'apply');
  const normalized = validateByteSplices(splices, base.byteLength);
  const chunks = [];
  let cursor = 0;
  for (const splice of normalized) {
    chunks.push(base.subarray(cursor, splice.start));
    chunks.push(splice.insert);
    cursor = splice.end;
  }
  chunks.push(base.subarray(cursor));
  return Buffer.concat(chunks);
}

function receiverContributor(receiver) {
  const contributor = receiver?.contributor;
  if (!contributor || typeof contributor !== 'object' || Array.isArray(contributor)) {
    return { author: '', authorType: 'unknown' };
  }
  return {
    author: typeof contributor.id === 'string' ? contributor.id : '',
    authorType: typeof contributor.type === 'string' ? contributor.type : 'unknown',
  };
}

/**
 * Build a receiver whose exact-byte applicator, OFM check, contributor identity,
 * and trust classifier are configured locally. The proposal object cannot
 * provide or replace them.
 */
export function createProposalReceiver({
  applySplicesFn = applyByteSplices,
  ofmCheckFn = checkChange,
  trustClassifyFn = classify,
} = {}) {
  if (typeof applySplicesFn !== 'function' || typeof ofmCheckFn !== 'function' || typeof trustClassifyFn !== 'function') {
    throw new TypeError('proposal receiver dependencies must be functions');
  }

  return function receive({ proposal, receiver } = {}) {
    // Exact URL, byte length, and digest checks happen before even normalizing
    // splices. A same-length stale representation therefore cannot reach apply,
    // any rebase behavior (none exists), OFM, or trust classification.
    const base = validateProposalBase({ proposal, receiver });
    const splices = validateByteSplices(proposal.splices, base.targetByteLength);
    const beforeText = decodeUtf8(base.currentBytes, 'receiver.currentBytes', 'precondition');
    const candidateBytes = exactBuffer(applySplicesFn(base.currentBytes, splices), 'candidateBytes', 'apply');
    const candidateText = decodeUtf8(candidateBytes, 'candidateBytes', 'candidate');

    const ofm = ofmCheckFn(beforeText, candidateText);
    if (!ofm || typeof ofm !== 'object' || typeof ofm.verdict !== 'string') {
      fail('invalid-ofm-result', 'receiver-owned OFM check returned an invalid result', 'classification');
    }

    const contributor = receiverContributor(receiver);
    const path = requireNonEmptyString(receiver.path, 'receiver.path');
    const change = {
      author: contributor.author,
      authorType: contributor.authorType,
      files: [{
        path,
        before: beforeText,
        after: candidateText,
        status: 'modified',
      }],
      meta: {
        proposalId: base.proposalId,
        targetUrl: base.targetUrl,
        source: 'federation-fixture-proposal',
      },
    };
    const trust = trustClassifyFn(change, receiver.trustConfig);
    if (!trust || typeof trust !== 'object' || typeof trust.route !== 'string') {
      fail('invalid-trust-result', 'receiver-owned trust classifier returned an invalid result', 'classification');
    }

    return {
      status: 'receiver-evaluated',
      proposalId: base.proposalId,
      target: {
        url: base.targetUrl,
        baseByteLength: base.targetByteLength,
        baseDigest: base.targetDigest,
      },
      candidate: {
        byteLength: candidateBytes.byteLength,
        digest: sha256Digest(candidateBytes),
      },
      candidateBytes: Buffer.from(candidateBytes),
      candidateText,
      receiverChecks: {
        ofm,
        trust,
      },
      moderation: {
        receiverOwned: true,
        route: trust.route,
        tier: trust.tier,
        reasons: Array.isArray(trust.reasons) ? [...trust.reasons] : [],
      },
      sourceWritePerformed: false,
      rebased: false,
    };
  };
}

export const receiveProposal = createProposalReceiver();
