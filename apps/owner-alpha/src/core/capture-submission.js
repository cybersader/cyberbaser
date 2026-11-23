import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createChangeSetProposal } from '@cyberbaser/proposal';
import { deriveContiguousCorrection } from '../../../../packages/correction/src/index.js';
import { fail, OwnerAlphaError } from '../errors.js';
import { isPlainObject } from '../json.js';
import { spellWorkspaceCandidate } from '../owner-publication.js';
import {
  defaultProposalReviewGit, literalPathspec, parseTreeEntry, readBlob, runGit, trimFinalLf, exactObjectId,
} from '../proposal-review.js';
import { pathMatchesPolicy } from '../source.js';

// A paired device sends the text it has open; the node, not the device, binds
// it to the vault. This is the same binding agent-propose.js does on the
// agent's side: the committed blob at the publication branch head is the base,
// the workspace text is folded and spelled in the vault's own line endings, and
// exactly one contiguous splice becomes a normal signed change-set proposal.

const MAX_PATH_BYTES = 1024;
export const CAPTURE_REFUSALS = Object.freeze([
  'capture-path-refused', 'capture-base-unavailable', 'capture-too-large',
  'delivery-not-round-trippable', 'workspace-diff-too-complex', 'publication-candidate-mismatch',
]);

function refusePath() {
  fail('capture-path-refused', 'the note is not a Markdown file this vault publishes');
}

export function validateCaptureInput(input, maxSourceBytes) {
  if (!isPlainObject(input)) fail('invalid-command-input', 'capture requires path and text');
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'path,text') fail('invalid-command-input', 'capture accepts only path and text');
  const { path: notePath, text } = input;
  if (typeof notePath !== 'string' || Buffer.byteLength(notePath) > MAX_PATH_BYTES || !notePath.endsWith('.md')
    || notePath.split('/').some((part) => !part || part === '.' || part === '..')
    || /[\\\p{Cc}\p{Cs}]/u.test(notePath)) refusePath();
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxSourceBytes) {
    fail('capture-too-large', 'the note is larger than this vault accepts');
  }
  return { path: notePath, text };
}

// The workspace path names a vault file: the configured publication mapping's
// delivery file when the workspace path is its source, otherwise the same path.
export function deliveryPathFor(config, notePath) {
  const mapping = config.ownerPublication?.mappings?.find((entry) => entry.source.path === notePath);
  return mapping ? mapping.relativePath : notePath;
}

// The committed bytes at the publication branch head, from the node's own
// checkout. Never the working tree, never the device.
export async function readCommittedDelivery({ config, relativePath, git = defaultProposalReviewGit }) {
  try {
    const checkout = config.repository.checkout;
    if (await realpath(checkout) !== checkout) throw new Error('checkout');
    const revision = exactObjectId(trimFinalLf(await runGit(git, checkout,
      ['rev-parse', '--verify', `refs/heads/${config.repository.branch}^{commit}`]), 'branch head'), 'branch head');
    const entry = parseTreeEntry(await runGit(git, checkout, ['ls-tree', '-z', revision, '--', literalPathspec(relativePath)]),
      relativePath, 'capture delivery entry', { allowMissing: true });
    if (entry === null || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error('missing');
    const base = await readBlob(git, checkout, entry.objectId, 'capture delivery', config.limits.maxSourceBytes);
    return { repository: config.repository.remote.url, revision, base };
  } catch {
    fail('capture-base-unavailable', 'the vault has no committed copy of this note');
  }
}

export function createCaptureProposalBuilder({ config, readBase = readCommittedDelivery, clock = Date.now }) {
  return async (input) => {
    const capture = validateCaptureInput(input, config.limits.maxSourceBytes);
    const relativePath = deliveryPathFor(config, capture.path);
    if (path.posix.normalize(relativePath) !== relativePath) refusePath();
    try { pathMatchesPolicy(relativePath, config.paths); } catch { refusePath(); }
    const { repository, revision, base } = await readBase({ config, relativePath });
    let text;
    try {
      text = spellWorkspaceCandidate(base, capture.text);
    } catch (error) {
      if (error instanceof OwnerAlphaError && CAPTURE_REFUSALS.includes(error.code)) throw error;
      fail('delivery-not-round-trippable', 'the note cannot be matched to the vault text exactly');
    }
    if (Buffer.from(text).equals(base)) return Object.freeze({ unchanged: true, deliveryPath: relativePath });
    const { start, end, expectedOldBytes, replacementBytes } = deriveContiguousCorrection(base, text);
    const at = clock();
    const proposal = createChangeSetProposal(base, {
      proposalId: `device-${randomUUID()}`, source: { repository, revision, path: relativePath },
      operations: [{ operationId: 'device-edit', start, end,
        expected: expectedOldBytes.toString('utf8'), replacement: replacementBytes.toString('utf8') }],
      submission: { submittedAt: new Date(at).toISOString().replace(/\.\d{3}Z$/u, 'Z'),
        rationale: 'Review this exact edit sent from a paired device.', evidence: [], identityClaim: null },
    });
    return Object.freeze({ unchanged: false, deliveryPath: relativePath, proposal });
  };
}
