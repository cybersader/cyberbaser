import { exposeInvisibleText } from './invisible-text.js';
import { markdownBlocks } from './markdown-projection.js';

const UNAVAILABLE = Object.freeze({
  noBase: 'This page does not exist in the pinned base, so there is no current text to read.',
  noCandidate: 'No candidate result is derivable from this evidence, so the proposed document cannot be shown.',
  unorderedOperations: 'The declared operations are not canonically ordered and non-overlapping, so no document projection is derivable.',
  oldBytesMismatch: 'The declared old bytes do not match the pinned base, so no document projection is derivable.',
  candidateMismatch: 'Replaying the declared operations does not reproduce the declared candidate, so no document projection is derivable.',
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

function offsets(baseText, operations) {
  const buffer = Buffer.from(baseText, 'utf8');
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

const view = (available, reason, segments, source = null) => Object.freeze({
  available,
  reason,
  segments: Object.freeze(segments),
  blocks: source === null ? Object.freeze([]) : markdownBlocks(source),
});

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
