import { Buffer } from 'node:buffer';
import { trackedChanges } from './publication-tracked-changes.js';
import { documentProjection, segmentsWithinSpan, DOCUMENT_UNAVAILABLE_REASONS } from '@cyberbaser/review-projection';

// Display-only budgets. These are not authoring policy or pipeline limits.
export const PUBLICATION_DISPLAY_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, maxLines: 4000,
  maxDiffCells: 2000000, maxBlocks: 3000, maxMarks: 500 });
const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];

/** Bounded line LCS within a possibly MID-LINE authoritative splice. Offsets are
 * UTF-8 byte offsets, not Markdown boundaries. This is one textual decomposition,
 * never unique author intent, and never an operation to save or apply. */
export function refineForDisplay(operation, limits = PUBLICATION_DISPLAY_LIMITS) {
  const old = lines(operation.oldText); const next = lines(operation.replacementText);
  if (Buffer.byteLength(operation.oldText) + Buffer.byteLength(operation.replacementText) > limits.maxBytes
    || old.length > limits.maxLines || next.length > limits.maxLines
    || (old.length + 1) * (next.length + 1) > limits.maxDiffCells) {
    return { operations: [operation], coarseReason: 'The display difference budget was exceeded. Review this whole version; individual change navigation is unavailable.' };
  }
  const width = next.length + 1;
  const grid = new Uint32Array((old.length + 1) * width);
  for (let i = old.length - 1; i >= 0; i -= 1) for (let j = next.length - 1; j >= 0; j -= 1) {
    grid[i * width + j] = old[i] === next[j] ? grid[(i + 1) * width + j + 1] + 1
      : Math.max(grid[(i + 1) * width + j], grid[i * width + j + 1]);
  }
  const offsets = [0];
  for (const line of old) offsets.push(offsets.at(-1) + Buffer.byteLength(line));
  const operations = []; let i = 0; let j = 0; let fromOld = 0; let fromNext = 0;
  const flush = () => {
    if (i !== fromOld || j !== fromNext) operations.push({ path: operation.path,
      start: operation.start + offsets[fromOld], end: operation.start + offsets[i],
      oldText: old.slice(fromOld, i).join(''), replacementText: next.slice(fromNext, j).join('') });
  };
  while (i < old.length || j < next.length) {
    if (i < old.length && j < next.length && old[i] === next[j]) {
      flush(); i += 1; j += 1; fromOld = i; fromNext = j;
    } else if (i < old.length && (j === next.length || grid[(i + 1) * width + j] >= grid[i * width + j + 1])) i += 1;
    else j += 1;
  }
  flush();
  return { operations: operations.length ? operations : [operation], coarseReason: null };
}

/** Reuse the existing replay gate, including for the ORIGINAL splice. A passing
 * gate proves byte equivalence, not semantic equivalence or unique edit history. */
export function verifiedDisplayProjection({ path, baseText, candidateText, operation }, refined) {
  const files = [{ path, exists: baseText !== null, baseText, candidateText }];
  if (baseText === null) return { available: false, reason: DOCUMENT_UNAVAILABLE_REASONS.noBase };
  const original = documentProjection({ files, operations: [operation] });
  const available = (value) => value.modes.current.available && value.modes.proposed.available && value.modes.changes.available;
  if (!available(original)) return { available: false, reason: original.modes.proposed.reason ?? original.modes.current.reason };
  const proposal = documentProjection({ files, operations: refined.operations });
  return available(proposal) ? { available: true, projection: proposal, operations: refined.operations,
    coarseReason: refined.coarseReason } : { available: true, projection: original, operations: [operation],
    coarseReason: 'The refined display could not be verified. Review the whole version with the original exact operation below.' };
}

export function publicationDisplay(input, overrides = {}) {
  const limits = { ...PUBLICATION_DISPLAY_LIMITS, ...overrides };
  const refined = refineForDisplay(input.operation, limits);
  const verified = verifiedDisplayProjection(input, refined);
  if (!verified.available) return { ...verified, rows: [], markCount: 0, coarse: false };
  const file = verified.projection.files[0]; const source = file.proposed;
  const blocks = source.blocks.filter((block) => block.kind !== 'gap');
  const changed = source.segments.filter((segment) => segment.kind !== 'context');
  const rows = blocks.map((block) => {
    const matches = segmentsWithinSpan(changed.filter((part) => part.kind === 'added'), block, input.candidateText.length);
    const numbers = [...new Set(matches.map((part) => part.operation))];
    return { block, position: block.start, changed: numbers.length > 0,
      previous: numbers.map((number) => verified.operations[number - 1]?.oldText ?? '') };
  });
  // Pure deletions, including at the beginning/end and in gaps, need their own
  // visible location. Do not falsely mark a neighbouring unchanged block.
  for (const part of changed) {
    if (part.kind === 'deletion-point' || !rows.some((row) => row.block && part.start < row.block.end && part.end > row.block.start)) {
      rows.push({ position: part.start, changed: true, removed: part.kind === 'deletion-point',
        previous: [verified.operations[part.operation - 1]?.oldText ?? ''] });
    }
  }
  rows.sort((a, b) => a.position - b.position || (a.block ? 1 : -1));
  const markCount = rows.filter((row) => row.changed).length;
  const proseBlocks = blocks.filter((block) => ['paragraph', 'quote', 'list', 'ordered-list', 'code'].includes(block.kind)).length;
  const broad = markCount >= 8 && markCount > proseBlocks * 0.6;
  const coarseReason = verified.coarseReason ?? (source.blocks.length > limits.maxBlocks
    ? 'The structural rendering budget was exceeded. Review the complete candidate as exact source below.'
    : markCount > limits.maxMarks ? 'There are too many blocks to mark individually. Review this whole version; individual change navigation is unavailable.'
      : broad ? `Broad rewrite: ${markCount} of ${blocks.length} readable blocks differ. Review the whole version rather than a wall of individual marks.` : null);
  const coarse = coarseReason !== null;
  let number = 0;
  const display = { ...verified, file, rows: rows.map((row) => ({ ...row, mark: row.changed && !coarse ? ++number : null })),
    coarse, coarseReason, markCount: coarse ? 0 : markCount, differingBlocks: markCount,
    exactOnly: source.blocks.length > limits.maxBlocks };
  return { ...display, tracked: trackedChanges(display, input) };
}
