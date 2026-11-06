// Pure endpoint-projection comparison. No source-offset mapping, parser, I/O,
// authority, attribution or durable review state. Source replay is a separate gate.
export const TRACKED_CHANGE_LIMITS = Object.freeze({ maxBlockCells: 2000000, maxTokenCells: 20000,
  maxWordCells: 40000, maxEligibleBlocks: 400, maxMarks: 2000, maxTotalCells: 2000000 });
export function identity(value) {
  if (Array.isArray(value)) return `[${value.map(identity).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${identity(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const metadata = (block) => Object.fromEntries(Object.entries(block).filter(([key]) => !['start', 'end', 'tokens', 'items', 'text'].includes(key)));
const streams = (block) => block.items ? block.items.map((item) => item.tokens)
  : [block.tokens ?? (block.kind === 'code' ? [{ type: 'code', text: block.text }] : [])];
export function comparable(block) {
  return { metadata: { ...metadata(block), ...(block.items ? { items: block.items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'tokens'))) } : {}) }, streams: streams(block) };
}
function align(before, after, key, cap, state, name) {
  const cells = (before.length + 1) * (after.length + 1);
  if (cells > cap) return { reason: `${name} budget exceeded (${cap} cells).` };
  if (state.cells + cells > state.limit) return { reason: `Cumulative comparison budget exceeded (${state.limit} cells).` };
  state.cells += cells;
  const a = before.map(key); const b = after.map(key); const width = b.length + 1;
  const grid = new Uint32Array(cells);
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) {
    grid[i * width + j] = a[i] === b[j] ? grid[(i + 1) * width + j + 1] + 1 : Math.max(grid[(i + 1) * width + j], grid[i * width + j + 1]);
  }
  const result = []; let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ kind: 'context', old: i++, next: j++ }); }
    else if (i < a.length && (j === b.length || grid[(i + 1) * width + j] >= grid[i * width + j + 1])) result.push({ kind: 'removed', old: i++ });
    else result.push({ kind: 'added', next: j++ });
  }
  return { result };
}
/** Cuts are validated against grapheme boundaries in the DERIVED text only.
 * Merge unsafe whitespace cuts; without Segmenter decline refinement entirely. */
export function wordUnits(text, Segmenter = Intl.Segmenter) {
  if (typeof Segmenter !== 'function') return null;
  const boundaries = new Set([0, text.length]);
  for (const part of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) boundaries.add(part.index);
  const result = []; let pending = ''; let end = 0;
  for (const part of text.match(/\s+|\S+/gu) ?? []) {
    pending += part; end += part.length;
    if (boundaries.has(end)) { result.push(pending); pending = ''; }
  }
  if (pending) result.push(pending);
  return result;
}
/** Reassemble original token entries, not just visible text. All metadata must
 * match, even for split text pieces; no endpoint token can disappear or reorder. */
export function reconstruct(runs, side) {
  const out = []; const indexKey = side === 'base' ? 'old' : 'next'; const excluded = side === 'base' ? 'added' : 'removed';
  for (const run of runs) {
    if (run.kind === excluded) continue;
    const index = run[indexKey]; if (!Number.isInteger(index) || index < 0 || index > out.length) return null;
    if (index === out.length) out.push({ ...run.token });
    else {
      const previous = out[index];
      if (index !== out.length - 1 || identity({ ...previous, text: '' }) !== identity({ ...run.token, text: '' })) return null;
      previous.text += run.token.text;
    }
  }
  return out;
}
export function verifyRuns(runs, before, after) {
  return identity(reconstruct(runs, 'base')) === identity(before) && identity(reconstruct(runs, 'candidate')) === identity(after);
}
function tokenRuns(before, after, limits, state, Segmenter) {
  const aligned = align(before, after, identity, limits.maxTokenCells, state, 'Token LCS');
  if (aligned.reason) return aligned;
  const runs = []; let note = null;
  for (let index = 0; index < aligned.result.length;) {
    const entry = aligned.result[index];
    if (entry.kind === 'context') { runs.push({ ...entry, token: after[entry.next] }); index += 1; continue; }
    const changed = []; while (index < aligned.result.length && aligned.result[index].kind !== 'context') changed.push(aligned.result[index++]);
    const removed = changed.filter((part) => part.kind === 'removed'); const added = changed.filter((part) => part.kind === 'added');
    if (removed.length === 1 && added.length === 1 && before[removed[0].old].type === 'text' && after[added[0].next].type === 'text'
      && identity({ ...before[removed[0].old], text: '' }) === identity({ ...after[added[0].next], text: '' })) {
      const old = removed[0].old; const next = added[0].next;
      const a = wordUnits(before[old].text, Segmenter); const b = wordUnits(after[next].text, Segmenter);
      if (a && b) {
        const words = align(a, b, (value) => value, limits.maxWordCells, state, 'Word LCS');
        if (words.reason) return words;
        for (const word of words.result) runs.push({ kind: word.kind,
          ...(word.old !== undefined ? { old } : {}), ...(word.next !== undefined ? { next } : {}),
          token: { ...(word.kind === 'removed' ? before[old] : after[next]), text: word.kind === 'removed' ? a[word.old] : b[word.next] } });
        continue;
      }
      note = 'Grapheme segmentation unavailable: whole text tokens are marked.';
    }
    for (const part of changed) runs.push({ ...part, token: part.kind === 'removed' ? before[part.old] : after[part.next] });
  }
  return verifyRuns(runs, before, after) ? { runs, note } : { reason: 'Two-way rendered-token reconstruction failed.' };
}
function refinePair(before, after, oldText, newText, limits, state, Segmenter) {
  const a = comparable(before); const b = comparable(after);
  if (identity(a) === identity(b)) return { kind: 'source', reason: 'Source/formatting changed; this projection does not expose the difference.' };
  if (before.uninterpreted?.length || after.uninterpreted?.length) return { kind: 'exact', reason: 'Unsupported syntax: labelled exact-source fallback.' };
  if (oldText.includes('\r') || newText.includes('\r')) return { kind: 'block', reason: 'CRLF source: inline refinement unavailable.' };
  if (!['paragraph', 'heading', 'quote', 'list', 'ordered-list', 'code'].includes(before.kind) || identity(a.metadata) !== identity(b.metadata) || a.streams.length !== b.streams.length) return { kind: 'block', reason: 'Block structure changed: block-level review only.' };
  if (state.eligible >= limits.maxEligibleBlocks) return { kind: 'block', reason: `Eligible-block budget exceeded (${limits.maxEligibleBlocks}).` };
  state.eligible += 1;
  const groups = [];
  for (let index = 0; index < a.streams.length; index += 1) {
    const result = tokenRuns(a.streams[index], b.streams[index], limits, state, Segmenter);
    if (result.reason) return { kind: 'block', reason: result.reason };
    groups.push(result);
  }
  const marks = groups.reduce((count, group) => count + group.runs.filter((run) => run.kind !== 'context').length, 0);
  if (state.marks + marks > limits.maxMarks) return { kind: 'block', reason: `Inline-mark budget exceeded (${limits.maxMarks}).` };
  state.marks += marks;
  return { kind: 'inline', groups, base: a, candidate: b, note: groups.find((group) => group.note)?.note ?? null };
}
/** Input is an already source-replay-verified display. Never run this on an
 * unavailable projection. The two-way proof concerns projections, NOT bytes. */
export function trackedChanges(display, { baseText, candidateText }, overrides = {}, Segmenter = Intl.Segmenter) {
  if (!display.available) return { available: false, rows: [], counts: {}, reason: 'Source projection unavailable.' };
  const limits = { ...TRACKED_CHANGE_LIMITS, ...overrides }; const state = { cells: 0, limit: limits.maxTotalCells, eligible: 0, marks: 0 };
  const base = display.file.current.blocks.filter((block) => block.kind !== 'gap');
  const candidate = display.file.proposed.blocks.filter((block) => block.kind !== 'gap');
  const source = (block, text) => text.slice(block.start, block.end);
  const a = base.map((block) => ({ block, key: identity([block.kind, source(block, baseText)]) }));
  const b = candidate.map((block) => ({ block, key: identity([block.kind, source(block, candidateText)]) }));
  const counts = { inline: 0, block: 0, exact: 0, source: 0, deleted: 0, added: 0 };
  const fallback = (reason) => {
    const rows = display.rows.map((row) => ({ ...row, tracked: row.changed ? { kind: row.block?.uninterpreted.length ? 'exact' : 'block', reason } : null }));
    for (const row of rows) if (row.tracked) counts[row.tracked.kind] += 1;
    return { available: true, rows, counts, reason, coarse: true, cells: state.cells, marks: 0, defaultClean: display.coarse };
  };
  const pairing = align(a, b, (item) => item.key, limits.maxBlockCells, state, 'Block-pairing LCS');
  if (pairing.reason || display.exactOnly) return fallback(pairing.reason ?? 'Structural rendering budget: complete exact-source fallback.');
  const expected = new Set(display.rows.filter((row) => row.block && row.changed).map((row) => row.block));
  const derived = new Set(pairing.result.filter((item) => item.kind === 'added').map((item) => candidate[item.next]));
  const deletionPoints = display.file.proposed.segments.filter((segment) => segment.kind === 'deletion-point');
  if ([...expected].some((block) => !derived.has(block)) || [...derived].some((block) => !expected.has(block)
    && !deletionPoints.some((point) => point.start >= block.start && point.start <= block.end))) return fallback('Block pairing disagrees with source-bound change regions: block-level review only.');
  const rows = []; let offset = 0;
  while (offset < pairing.result.length) {
    const part = pairing.result[offset];
    if (part.kind === 'context') { rows.push({ block: candidate[part.next], position: candidate[part.next].start, changed: false, previous: [] }); offset += 1; continue; }
    const run = []; while (offset < pairing.result.length && pairing.result[offset].kind !== 'context') run.push(pairing.result[offset++]);
    const old = run.filter((item) => item.kind === 'removed').map((item) => base[item.old]);
    const next = run.filter((item) => item.kind === 'added').map((item) => candidate[item.next]);
    // Pair corresponding positions only when the run lengths match. Never
    // search text to guess a moved/repeated block's location.
    if (old.length === next.length) {
      for (let index = 0; index < old.length; index += 1) {
        const tracked = refinePair(old[index], next[index], source(old[index], baseText), source(next[index], candidateText), limits, state, Segmenter);
        rows.push({ block: next[index], position: next[index].start, changed: true, previous: [source(old[index], baseText)], tracked }); counts[tracked.kind] += 1;
      }
    } else {
      // Deleted blocks retain BASE spans for rendering/evidence, never for
      // ordering. Anchor this run at its first added/next context block in the
      // PROPOSED projection (or its end), retaining base order only within a tie.
      const position = next[0]?.start ?? candidate[pairing.result[offset]?.next]?.start ?? candidateText.length;
      for (const block of old) { rows.push({ block, position, deleted: true, changed: true, previous: [source(block, baseText)], tracked: { kind: 'deleted', reason: 'Removed from this version; shown from the pinned repository projection.' } }); counts.deleted += 1; }
      for (const block of next) { rows.push({ block, position: block.start, changed: true, previous: [], tracked: { kind: 'added', reason: 'Inserted block; whole-block markup, not inline pairing.' } }); counts.added += 1; }
    }
  }
  // A deletion point is redundant ONLY when its same-operation BASE removed
  // span is fully covered by displayed deleted blocks and existing gap spans,
  // with at least one deleted block actually intersecting that operation. A
  // gap-only deletion cannot qualify. No BASE/PROPOSED offsets are compared.
  const deleted = rows.filter((row) => row.deleted).map((row) => row.block);
  const coveredDeletion = (point) => {
    const spans = display.file.current.segments.filter((part) => part.kind === 'removed' && part.operation === point.operation);
    if (spans.length !== 1) return false;
    const span = spans[0];
    if (!deleted.some((block) => block.start < span.end && block.end > span.start)) return false;
    const coverage = [...deleted, ...display.file.current.blocks.filter((block) => block.kind === 'gap')]
      .filter((block) => block.start < span.end && block.end > span.start)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    let cursor = span.start;
    for (const block of coverage) {
      if (block.start > cursor) return false;
      cursor = Math.max(cursor, block.end);
      if (cursor >= span.end) return true;
    }
    return false;
  };
  // Reuse segment operation provenance rather than guessing which same-position
  // marker in display.rows belongs to which operation (its sort may tie).
  for (const part of display.file.proposed.segments) {
    const removed = part.kind === 'deletion-point';
    if (!removed && (part.kind !== 'added' || candidate.some((block) => part.start < block.end && part.end > block.start))) continue;
    if (removed && coveredDeletion(part)) continue;
    rows.push({ position: part.start, operation: part.operation, changed: true, removed,
      previous: [display.operations[part.operation - 1]?.oldText ?? ''], tracked: { kind: 'source', reason: removed
        ? 'Source text removed at this position; inspect the exact previous text.'
        : 'Source whitespace changed outside readable blocks.' } });
    counts.source += 1;
  }
  // Every position above is PROPOSED-space. Stable sequence makes co-located
  // markers total and deterministic; markers precede the surviving block.
  const rank = (row) => row.deleted ? 0 : row.block ? 2 : 1;
  const ordered = rows.map((row, sequence) => ({ ...row, sequence })).sort((left, right) => left.position - right.position
    || rank(left) - rank(right) || left.sequence - right.sequence);
  const coarse = display.coarse; let number = 0;
  return { available: true, rows: ordered.map((row) => ({ ...row, mark: row.changed && !coarse ? ++number : null })), counts,
    reason: null, coarse, cells: state.cells, marks: state.marks, defaultClean: coarse, markCount: number };
}
