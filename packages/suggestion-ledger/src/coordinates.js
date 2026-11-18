const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function assertText(text) {
  if (typeof text !== 'string') throw new TypeError('Text must be a string');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Unpaired UTF-16 surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError('Unpaired UTF-16 surrogate');
  }
  return text;
}

export const encode = (text) => encoder.encode(assertText(text));
export const decode = (bytes) => decoder.decode(bytes);
export const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
export function concatBytes(chunks) {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}

/** Scalar boundaries only. Columns are one-based UTF-16 code units; CRLF stays two units. */
export function createCoordinateAdapter(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected UTF-8 Uint8Array');
  const text = decode(bytes);
  let scalarCount = 0;
  for (const scalar of text) scalarCount++;
  // Two packed boundary arrays avoid allocating two Map entries per source scalar.
  const utf16Boundaries = new Uint32Array(scalarCount + 1);
  const byteBoundaries = new Uint32Array(scalarCount + 1);
  let utf16 = 0, byte = 0, boundary = 0;
  for (const scalar of text) {
    const codePoint = scalar.codePointAt(0);
    utf16 += scalar.length;
    byte += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    utf16Boundaries[++boundary] = utf16;
    byteBoundaries[boundary] = byte;
  }
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') i++;
      lineStarts.push(i + 1);
    } else if (text[i] === '\n') lineStarts.push(i + 1);
  }
  const requireOffset = (boundaries, translated, value, unit) => {
    let lo = 0, hi = boundaries.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (boundaries[mid] < value) lo = mid + 1; else hi = mid;
    }
    if (!Number.isSafeInteger(value) || boundaries[lo] !== value) {
      throw new RangeError(`${unit} offset is outside the document or inside a code point`);
    }
    return translated[lo];
  };
  const byteToUtf16 = (offset) => requireOffset(byteBoundaries, utf16Boundaries, offset, 'UTF-8');
  const utf16ToByte = (index) => requireOffset(utf16Boundaries, byteBoundaries, index, 'UTF-16');
  const positionAt = (offset) => {
    const index = byteToUtf16(offset);
    let lo = 0, hi = lineStarts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (lineStarts[mid] <= index) lo = mid; else hi = mid;
    }
    return Object.freeze({ line: lo + 1, column: index - lineStarts[lo] + 1 });
  };
  const byteAt = ({ line, column }) => {
    if (!Number.isSafeInteger(line) || line < 1 || line > lineStarts.length ||
        !Number.isSafeInteger(column) || column < 1) throw new RangeError('Invalid line/column');
    const index = lineStarts[line - 1] + column - 1;
    if (index > text.length || (line < lineStarts.length && index >= lineStarts[line])) {
      throw new RangeError('Column extends beyond this line');
    }
    return utf16ToByte(index);
  };
  return Object.freeze({ byteLength: byte, utf16Length: utf16, lineCount: lineStarts.length,
    utf16ToByte, byteToUtf16, positionAt, byteAt });
}
