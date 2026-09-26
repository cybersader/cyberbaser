import { exposeInvisibleText } from './invisible-text.js';
import { markdownBlocks } from './markdown-projection.js';

const UNAVAILABLE = Object.freeze({
  noBase: 'This page does not exist in the pinned base, so there is no current text to read.',
  noCandidate: 'No candidate result is derivable from this evidence, so the proposed document cannot be shown.',
  unorderedOperations: 'The declared operations are not canonically ordered and non-overlapping, so no document projection is derivable.',
  oldBytesMismatch: 'The declared old bytes do not match the pinned base, so no document projection is derivable.',
  candidateMismatch: 'Replaying the declared operations does not reproduce the declared candidate, so no document projection is derivable.',
  invalidOffsets: 'The declared byte offsets do not fall on character boundaries inside the pinned base, so no document projection is derivable.',
});

function charOffset(buffer, byteOffset) {
  return buffer.subarray(0, byteOffset).toString('utf8').length;
}

function fileOperations(operations, path) {
  return operations
    .map((operation, index) => ({ ...operation, number: index + 1 }))
    .filter((operation) => operation.path === path);
}

function canonicallyOrdered(operations) {
  let previous = null;
  for (const operation of operations) {
    if (operation.end < operation.start) return false;
    if (previous !== null && (operation.start < previous.end || operation.start === previous.start)) return false;
    previous = operation;
  }
  return true;
}

// A byte offset is a character boundary when it is inside the buffer and does
// not point at a UTF-8 continuation byte. Anything else cannot be turned into
// a string index honestly, so the projection refuses rather than guessing.
function characterBoundary(buffer, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) return false;
  return offset === buffer.length || (buffer[offset] & 0xc0) !== 0x80;
}

function offsets(baseText, operations) {
  const buffer = Buffer.from(baseText, 'utf8');
  if (!operations.every((operation) => characterBoundary(buffer, operation.start) && characterBoundary(buffer, operation.end))) {
    return null;
  }
  return operations.map((operation) => ({
    ...operation,
    charStart: charOffset(buffer, operation.start),
    charEnd: charOffset(buffer, operation.end),
  }));
}

function replay(baseText, operations) {
  let cursor = 0;
  let candidate = '';
  for (const operation of operations) {
    candidate += baseText.slice(cursor, operation.charStart) + operation.replacementText;
    cursor = operation.charEnd;
  }
  return candidate + baseText.slice(cursor);
}

const segment = (kind, text, operation = null, start = 0, end = start) => Object.freeze({
  kind,
  text: exposeInvisibleText(text),
  operation,
  start,
  end,
});

function currentSegments(baseText, operations) {
  const segments = [];
  let cursor = 0;
  for (const operation of operations) {
    if (operation.charStart > cursor) segments.push(segment('context', baseText.slice(cursor, operation.charStart), null, cursor, operation.charStart));
    if (operation.charEnd > operation.charStart) {
      segments.push(segment('removed', baseText.slice(operation.charStart, operation.charEnd), operation.number, operation.charStart, operation.charEnd));
    } else {
      segments.push(segment('insertion-point', '', operation.number, operation.charStart, operation.charStart));
    }
    cursor = operation.charEnd;
  }
  if (cursor < baseText.length) segments.push(segment('context', baseText.slice(cursor), null, cursor, baseText.length));
  return segments;
}

function proposedSegments(candidateText, operations) {
  const segments = [];
  let cursor = 0;
  let delta = 0;
  for (const operation of operations) {
    const start = operation.charStart + delta;
    const length = operation.replacementText.length;
    if (start > cursor) segments.push(segment('context', candidateText.slice(cursor, start), null, cursor, start));
    if (length > 0) segments.push(segment('added', candidateText.slice(start, start + length), operation.number, start, start + length));
    else segments.push(segment('deletion-point', '', operation.number, start, start));
    cursor = start + length;
    delta += length - (operation.charEnd - operation.charStart);
  }
  if (cursor < candidateText.length) segments.push(segment('context', candidateText.slice(cursor), null, cursor, candidateText.length));
  return segments;
}

function unifiedSegments(baseText, operations) {
  const segments = [];
  let cursor = 0;
  for (const operation of operations) {
    if (operation.charStart > cursor) segments.push(segment('context', baseText.slice(cursor, operation.charStart), null, cursor, operation.charStart));
    if (operation.charEnd > operation.charStart) {
      segments.push(segment('removed', baseText.slice(operation.charStart, operation.charEnd), operation.number, operation.charStart, operation.charEnd));
    }
    if (operation.replacementText.length > 0) {
      segments.push(segment('added', operation.replacementText, operation.number, operation.charEnd, operation.charEnd));
    }
    if (operation.charEnd === operation.charStart && operation.replacementText.length === 0) {
      segments.push(segment('insertion-point', '', operation.number, operation.charStart, operation.charStart));
    }
    cursor = operation.charEnd;
  }
  if (cursor < baseText.length) segments.push(segment('context', baseText.slice(cursor), null, cursor, baseText.length));
  return segments;
}

/**
 * Does a segment fall inside a span? A zero-width segment (a pure insertion or
 * deletion anchor) belongs to the block that contains its position; when that
 * position is the end of the document, it belongs to the final block, which is
 * the only reading of an appended change that keeps it visible.
 */
export function segmentWithinSpan(segment, span, documentEnd = null) {
  if (segment.end > segment.start) return segment.start < span.end && segment.end > span.start;
  if (segment.start >= span.start && segment.start < span.end) return true;
  return documentEnd !== null && segment.start === documentEnd && span.end === documentEnd;
}

export function segmentsWithinSpan(segments, span, documentEnd = null) {
  return segments.filter((segment) => segmentWithinSpan(segment, span, documentEnd));
}

// Context segments are cut at the edges of every block that holds a change, so
// a consumer that shows the exact source of a changed block never has to slice
// exposed text, whose length no longer matches its raw span once invisible
// characters have been spelled out.
function alignContextToChangedBlocks(segments, blocks, source) {
  if (blocks.length === 0) return segments;
  const documentEnd = blocks.at(-1).end;
  const changed = blocks.filter((block) => segments.some((item) => item.kind !== 'context' && segmentWithinSpan(item, block, documentEnd)));
  if (changed.length === 0) return segments;
  const cuts = [...new Set(changed.flatMap((block) => [block.start, block.end]))].sort((left, right) => left - right);
  const aligned = [];
  for (const item of segments) {
    if (item.kind !== 'context') {
      aligned.push(item);
      continue;
    }
    let cursor = item.start;
    for (const cut of cuts) {
      if (cut <= cursor || cut >= item.end) continue;
      aligned.push(segment('context', source.slice(cursor, cut), null, cursor, cut));
      cursor = cut;
    }
    aligned.push(cursor === item.start ? item : segment('context', source.slice(cursor, item.end), null, cursor, item.end));
  }
  return aligned;
}

const view = (available, reason, segments, source = null) => {
  const blocks = source === null ? Object.freeze([]) : markdownBlocks(source);
  return Object.freeze({
    available,
    reason,
    segments: Object.freeze(source === null ? segments : alignContextToChangedBlocks(segments, blocks, source)),
    blocks,
  });
};

function projectFile(file, operations) {
  const scoped = fileOperations(operations, file.path);
  const numbers = Object.freeze(scoped.map((operation) => operation.number));
  const blocked = (reason) => Object.freeze({
    path: exposeInvisibleText(file.path),
    exists: file.exists,
    operationNumbers: numbers,
    current: view(false, reason, []),
    proposed: view(false, reason, []),
    unified: view(false, reason, []),
  });

  if (!canonicallyOrdered(scoped)) return blocked(UNAVAILABLE.unorderedOperations);
  if (file.baseText === null) {
    return Object.freeze({
      path: exposeInvisibleText(file.path),
      exists: file.exists,
      operationNumbers: numbers,
      current: view(false, UNAVAILABLE.noBase, []),
      proposed: file.candidateText === null
        ? view(false, UNAVAILABLE.noCandidate, [])
        : view(true, null, [segment('added', file.candidateText, numbers[0] ?? null, 0, file.candidateText.length)], file.candidateText),
      unified: file.candidateText === null
        ? view(false, UNAVAILABLE.noCandidate, [])
        : view(true, null, [segment('added', file.candidateText, numbers[0] ?? null, 0, file.candidateText.length)], file.candidateText),
    });
  }

  const positioned = offsets(file.baseText, scoped);
  if (positioned === null) return blocked(UNAVAILABLE.invalidOffsets);
  for (const operation of positioned) {
    if (file.baseText.slice(operation.charStart, operation.charEnd) !== operation.oldText) {
      return blocked(UNAVAILABLE.oldBytesMismatch);
    }
  }
  const current = view(true, null, currentSegments(file.baseText, positioned), file.baseText);
  if (file.candidateText === null) {
    return Object.freeze({
      path: exposeInvisibleText(file.path),
      exists: file.exists,
      operationNumbers: numbers,
      current,
      proposed: view(false, UNAVAILABLE.noCandidate, []),
      unified: view(false, UNAVAILABLE.noCandidate, []),
    });
  }
  if (replay(file.baseText, positioned) !== file.candidateText) {
    return Object.freeze({
      path: exposeInvisibleText(file.path),
      exists: file.exists,
      operationNumbers: numbers,
      current,
      proposed: view(false, UNAVAILABLE.candidateMismatch, []),
      unified: view(false, UNAVAILABLE.candidateMismatch, []),
    });
  }
  return Object.freeze({
    path: exposeInvisibleText(file.path),
    exists: file.exists,
    operationNumbers: numbers,
    current,
    proposed: view(true, null, proposedSegments(file.candidateText, positioned), file.candidateText),
    unified: view(true, null, unifiedSegments(file.baseText, positioned), file.baseText),
  });
}

function modeAvailability(files, key) {
  const blocked = files.find((file) => !file[key].available);
  return Object.freeze({ available: blocked === undefined, reason: blocked?.[key].reason ?? null });
}

/**
 * Project a pinned base and its declared exact operations into reading views.
 *
 * @param {{ files: Array<{path: string, exists: boolean, baseText: string|null, candidateText: string|null}>,
 *           operations: Array<{path: string, start: number, end: number, oldText: string, replacementText: string}> }} input
 */
export function documentProjection({ files: sourceFiles, operations }) {
  const files = sourceFiles.map((file) => projectFile(file, operations));
  return Object.freeze({
    files: Object.freeze(files),
    modes: Object.freeze({
      changes: modeAvailability(files, 'unified'),
      proposed: modeAvailability(files, 'proposed'),
      current: modeAvailability(files, 'current'),
    }),
  });
}

export const DOCUMENT_UNAVAILABLE_REASONS = UNAVAILABLE;
