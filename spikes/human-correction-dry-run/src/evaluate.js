import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { prepareCorrection, applyCorrection } from '@cyberbaser/correction';
import { checkChange } from '@cyberbaser/ofm';
import { classify } from '@cyberbaser/trust';
import { caseId, deepFreeze, publicSafeCase, validateCase } from './case.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const AUTHOR_TYPES = new Set(['anonymous', 'human', 'agent']);

export class DryRunEvaluationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DryRunEvaluationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new DryRunEvaluationError(code, message, details);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateTrustSubject(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid-trust-subject', 'trustSubject must be an object');
  }
  const authorType = input.authorType ?? 'anonymous';
  const author = input.author ?? '';
  if (!AUTHOR_TYPES.has(authorType)) fail('invalid-author-type', 'trustSubject.authorType is invalid');
  if (typeof author !== 'string') fail('invalid-author', 'trustSubject.author must be a string');
  return { authorType, author };
}

async function resolveMappedSource(checkoutDir, sourcePath) {
  if (typeof checkoutDir !== 'string' || checkoutDir.length === 0 || !path.isAbsolute(checkoutDir)) {
    fail('invalid-checkout-dir', 'checkoutDir must be a caller-supplied absolute directory');
  }

  let checkoutReal;
  let sourceReal;
  try {
    checkoutReal = await realpath(checkoutDir);
    const mappedPath = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.join(checkoutReal, ...sourcePath.split('/'));
    sourceReal = await realpath(mappedPath);
  } catch (error) {
    fail('source-unavailable', 'the owner-supplied source mapping could not be read', { cause: error.code });
  }

  const relative = path.relative(checkoutReal, sourceReal);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    fail('source-outside-checkout', 'the owner-supplied source mapping resolves outside checkoutDir');
  }

  const sourceStat = await stat(sourceReal);
  if (!sourceStat.isFile()) fail('source-not-file', 'the owner-supplied source mapping is not a regular file');
  return { sourceFile: sourceReal, repositoryRelativePath: relative.split(path.sep).join('/') };
}

function selectorFromCase(value) {
  return {
    quote: value.quote,
    ...(Object.hasOwn(value, 'prefix') ? { prefix: value.prefix } : {}),
    ...(Object.hasOwn(value, 'suffix') ? { suffix: value.suffix } : {}),
  };
}

function countByteOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function proveOutsideSpliceIdentity(baseBytes, candidateBytes, correction) {
  const prefixIdentical = candidateBytes
    .subarray(0, correction.start)
    .equals(baseBytes.subarray(0, correction.start));
  const candidateSuffixStart = correction.start + correction.replacementBytes.length;
  const suffixIdentical = candidateBytes
    .subarray(candidateSuffixStart)
    .equals(baseBytes.subarray(correction.end));

  if (!prefixIdentical || !suffixIdentical) {
    fail('outside-splice-change', 'candidate bytes changed outside the prepared splice');
  }

  return {
    prefixBytesPreserved: correction.start,
    suffixBytesPreserved: baseBytes.length - correction.end,
    prefixIdentical,
    suffixIdentical,
    exactlyOneFile: true,
    exactlyOneSplice: true,
  };
}

export async function evaluateCorrection({
  caseData,
  checkoutDir,
  ownerPolicy,
  policyRevision,
  trustSubject,
}) {
  const value = validateCase(caseData);
  if (ownerPolicy === null || typeof ownerPolicy !== 'object' || Array.isArray(ownerPolicy)) {
    fail('invalid-owner-policy', 'ownerPolicy must be injected as an object');
  }
  if (typeof policyRevision !== 'string' || policyRevision.length === 0) {
    fail('invalid-policy-revision', 'policyRevision must be a non-empty string');
  }
  const subject = validateTrustSubject(trustSubject);
  const { sourceFile, repositoryRelativePath } = await resolveMappedSource(checkoutDir, value.sourcePath);
  const baseBytes = await readFile(sourceFile);
  const baseSnapshot = Buffer.from(baseBytes);

  const correction = prepareCorrection(baseBytes, {
    selector: selectorFromCase(value),
    replacement: value.replacement,
  });
  const candidateBytes = applyCorrection(baseBytes, correction);
  const byteProof = proveOutsideSpliceIdentity(baseBytes, candidateBytes, correction);

  let before;
  let after;
  try {
    before = UTF8_DECODER.decode(baseBytes);
    after = UTF8_DECODER.decode(candidateBytes);
  } catch {
    fail('invalid-utf8', 'base or candidate is not valid UTF-8');
  }

  const ofm = checkChange(before, after);
  const trust = classify({
    authorType: subject.authorType,
    author: subject.author,
    files: [{
      path: repositoryRelativePath,
      before,
      after,
      status: 'modified',
    }],
    meta: { kind: value.kind, evidenceItems: value.evidence.length },
  }, ownerPolicy);

  const sourceAfterEvaluation = await readFile(sourceFile);
  const sourceBytesUnchangedAfterEvaluation = sourceAfterEvaluation.equals(baseSnapshot);
  if (!sourceBytesUnchangedAfterEvaluation) {
    fail('source-changed-during-evaluation', 'source bytes changed while the no-write evaluation ran');
  }

  const record = {
    schemaVersion: 1,
    artifactType: 'private-no-write-correction-evaluation',
    caseId: caseId(value),
    case: publicSafeCase(value),
    source: {
      ownerSuppliedMapping: true,
      repositoryRelativePath,
      baseCommit: value.baseCommit,
    },
    base: {
      byteLength: correction.baseByteLength,
      digest: correction.baseDigest,
    },
    anchor: {
      quoteOccurrencesWithoutContext: countByteOccurrences(baseBytes, Buffer.from(value.quote, 'utf8')),
      contextRequired: Object.hasOwn(value, 'prefix') || Object.hasOwn(value, 'suffix'),
      resolvedExactlyOnce: true,
      selector: selectorFromCase(value),
      start: correction.start,
      end: correction.end,
      expectedOldBytesVerified: correction.expectedOldBytes.equals(Buffer.from(value.quote, 'utf8')),
    },
    splice: {
      removedByteLength: correction.expectedOldBytes.length,
      replacementByteLength: correction.replacementBytes.length,
      ...byteProof,
    },
    candidate: {
      byteLength: correction.candidateByteLength,
      digest: correction.candidateDigest,
    },
    ofm: clonePlain(ofm),
    trust: {
      policyRevision,
      authorType: subject.authorType,
      tier: trust.tier,
      route: trust.route,
      reasons: [...trust.reasons],
      checks: clonePlain(trust.checks),
    },
    noWrite: {
      sourceWritePerformed: false,
      sourceBytesUnchangedAfterEvaluation,
      candidateExistsInMemoryOnly: true,
    },
  };

  return deepFreeze(record);
}
