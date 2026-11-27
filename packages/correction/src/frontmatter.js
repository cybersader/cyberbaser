// A note boundary is byte syntax, not YAML syntax. Only `block` has property
// values. `fence-like` preserves the old guard's protection without enrolling
// more inputs in publication. Ranges are half-open; the BOM precedes the range.
const DASH = 45;
const DOT = 46;
const CR = 13;
const LF = 10;
const SPACE = 32;
const TAB = 9;
const encoder = new TextEncoder();

function scan(length, at, nextLf, bomSize) {
  const leadingBom = bomSize !== 0;
  const none = { kind: 'none', leadingBom };
  const triple = (start, marker) => at(start) === marker && at(start + 1) === marker && at(start + 2) === marker;
  const skipPadding = (start) => {
    while (at(start) === SPACE || at(start) === TAB) start += 1;
    return start;
  };
  if (!triple(bomSize, DASH)) return none;
  const paddingEnd = skipPadding(bomSize + 3);
  const lf = at(paddingEnd) === CR ? paddingEnd + 1 : paddingEnd;
  if (at(lf) !== LF) return none;

  const bodyStart = lf + 1;
  let block = null;
  let legacyEnd = null;
  for (let start = bodyStart; start < length;) {
    const newline = nextLf(start);
    const lineEnd = newline === -1 ? length : newline;
    const end = newline === -1 ? lineEnd : lineEnd + 1;
    const trailingCr = at(lineEnd - 1) === CR;
    // The selector allows CR only as part of a newline, not before EOF.
    const contentEnd = trailingCr && newline !== -1 ? lineEnd - 1 : lineEnd;
    const dash = triple(start, DASH);
    if (legacyEnd === null && (dash || triple(start, DOT)) && start + 3 === contentEnd) legacyEnd = end;
    // The old review line scanner also accepted a dash fence ending in a lone CR at EOF.
    if (legacyEnd === null && dash && trailingCr && newline === -1 && start + 4 === lineEnd) legacyEnd = end;
    // The old selector requires a newline *after* the opening line's newline,
    // even for empty YAML; an adjacent pair of fences is not a matched block.
    if (block === null && start > bodyStart && dash && skipPadding(start + 3) === contentEnd) {
      const bodyEnd = at(start - 2) === CR ? start - 2 : start - 1;
      block = { kind: 'block', range: { start: bomSize, end }, yaml: { start: bodyStart, end: bodyEnd }, leadingBom };
    }
    if (block && (legacyEnd !== null || paddingEnd !== bomSize + 3)) break;
    start = end;
  }

  if (block) return { ...block, protectionEnd: Math.max(block.range.end, legacyEnd ?? 0), legacyEnd };
  return {
    kind: 'fence-like', range: { start: bomSize, end: legacyEnd ?? length }, leadingBom,
    reason: legacyEnd === null ? 'unclosed' : 'legacy-close',
  };
}

/** Inspect UTF-8 note bytes without decoding or parsing them. */
export function findFrontmatter(bytes) {
  const bomSize = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return scan(bytes.length, (index) => bytes[index], (start) => bytes.indexOf(LF, start), bomSize);
}

/** Inspect a string and add its exact YAML text and UTF-16 display range. */
export function findFrontmatterInText(text) {
  const result = scan(text.length, (index) => text.charCodeAt(index), (start) => text.indexOf('\n', start), text.charCodeAt(0) === 0xfeff ? 1 : 0);
  if (result.kind === 'none') return result;
  const byteOffset = (index) => encoder.encode(text.slice(0, index)).length;
  const byteRange = ({ start, end }) => ({ start: byteOffset(start), end: byteOffset(end) });
  const { range: textRange } = result;
  const range = byteRange(textRange);
  if (result.kind === 'fence-like') return { ...result, range, textRange };
  const { yaml, protectionEnd, legacyEnd } = result;
  const endOffset = (end) => end === textRange.end ? range.end : byteOffset(end);
  return {
    ...result, range, textRange, yaml: byteRange(yaml), yamlText: text.slice(yaml.start, yaml.end),
    protectionEnd: endOffset(protectionEnd), legacyEnd: legacyEnd === null ? null : endOffset(legacyEnd),
    legacyTextEnd: legacyEnd,
  };
}
