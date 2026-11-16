import { encode, decode } from './coordinates.js';

/** A provider is { id: string, render({baseText, operations, metadata}): T }. */
export function createDisplayAdapterRegistry(providers) {
  if (!Array.isArray(providers)) throw new TypeError('Display providers must be an array');
  const entries = new Map();
  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string' || !provider.id || typeof provider.render !== 'function' || entries.has(provider.id)) {
      throw new TypeError('Invalid or duplicate display adapter');
    }
    entries.set(provider.id, Object.freeze({ id: provider.id, render: provider.render.bind(provider) }));
  }
  return Object.freeze({
    ids: Object.freeze([...entries.keys()]),
    get(id) {
      if (!entries.has(id)) throw new RangeError(`Unknown display adapter: ${id}`);
      return entries.get(id);
    },
  });
}

export const viewSegmentsAdapter = Object.freeze({
  id: 'view-segments',
  render({ baseText, operations }) {
    const base = encode(baseText), segments = [];
    const push = (kind, text, baseStart, baseEnd) => {
      if (text) segments.push(Object.freeze({ kind, text, baseStart, baseEnd }));
    };
    let cursor = 0;
    for (const op of operations) {
      push('equal', decode(base.subarray(cursor, op.start)), cursor, op.start);
      push('delete', op.expected, op.start, op.end);
      // Insertion text has a zero-width original anchor, not a fabricated source range.
      push('insert', op.replacement, op.start, op.start);
      cursor = op.end;
    }
    push('equal', decode(base.subarray(cursor)), cursor, base.length);
    return Object.freeze(segments);
  },
});

const criticTokens = /\{\+\+|\+\+\}|\{--|--\}|\{~~|~>|~~\}|\{>>|<<\}/;
export const criticMarkupAdapter = Object.freeze({
  id: 'critic-markup',
  render({ baseText, operations, metadata }) {
    // CriticMarkup has no universal escaping convention. Refuse ambiguous literal markers.
    if ([baseText, ...operations.map((op) => op.replacement), ...Object.values(metadata).map((item) => item.comment)]
      .some((text) => criticTokens.test(text))) throw new Error('Literal CriticMarkup delimiter cannot be represented unambiguously');
    const base = encode(baseText), chunks = [];
    let cursor = 0;
    for (const op of operations) {
      chunks.push(decode(base.subarray(cursor, op.start)));
      if (op.expected && op.replacement) chunks.push(`{~~${op.expected}~>${op.replacement}~~}`);
      else if (op.replacement) chunks.push(`{++${op.replacement}++}`);
      else chunks.push(`{--${op.expected}--}`);
      if (metadata[op.operationId].comment) chunks.push(`{>>${metadata[op.operationId].comment}<<}`);
      cursor = op.end;
    }
    chunks.push(decode(base.subarray(cursor)));
    return chunks.join('');
  },
});

export const defaultDisplayAdapters = createDisplayAdapterRegistry([criticMarkupAdapter, viewSegmentsAdapter]);
