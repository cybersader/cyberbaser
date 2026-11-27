// Pure checks for the images a page bundle carries (design: new notes and
// images through the gate, 2026-11-24).
//
// Environment-neutral: Uint8Array in, plain values out. No Node APIs, no
// decoding libraries, no I/O, so the Obsidian plugin (desktop and mobile), the
// owner node and the publisher all run the same code.
//
// What it decides:
//   - the image type from its magic bytes, and whether it matches the name;
//   - that the whole file is one well-formed image structure with nothing
//     after it (a polyglot or a trailing payload is refused);
//   - whether the file still records where it was taken (Exif GPS, or XMP
//     location properties);
//   - for the writing device only: the same bytes with the location removed.
//     The core never rewrites bytes; the device signs what it cleaned.
import { extractRefs } from '../../publish/src/links.js';

export const ASSET_LIMITS = Object.freeze({
  maxAssets: 4,
  maxAssetBytes: 5 * 1024 * 1024,
  maxBundleBytes: 12 * 1024 * 1024,
});

export const IMAGE_TYPES = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });
const EXTENSIONS = Object.freeze({ png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif' });

export const MEDIA_CODES = Object.freeze(['asset-type-refused', 'asset-type-mismatch', 'asset-too-large', 'image-has-location']);

export class MediaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

const refuse = (code, message) => { throw new MediaError(code, message); };

/** The image type a path's extension names, or null (SVG and everything else). */
export function extensionType(path) {
  if (typeof path !== 'string') return null;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

const ascii = (bytes, start, end) => {
  let text = '';
  for (let i = start; i < Math.min(end, bytes.length); i += 1) text += String.fromCharCode(bytes[i]);
  return text;
};

/** 'png' | 'jpeg' | 'webp' | 'gif' | 'svg' | null, from the bytes alone. */
export function sniffImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return 'gif';
  const head = ascii(bytes, 0, 1024).replace(/^\xef\xbb\xbf/u, '').trimStart().toLowerCase();
  if ((head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--') || head.startsWith('<!doctype svg'))
    && head.includes('<svg')) return 'svg';
  return null;
}

// ---------------------------------------------------------------------------
// TIFF (Exif) structure: just enough to find and remove the GPS directory.

const TYPE_SIZES = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 });
const GPS_POINTER = 0x8825;
const MAX_IFD_ENTRIES = 1024;

function tiff(t) {
  if (t.length < 8) return null;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  const u16 = (o) => (o < 0 || o + 2 > t.length ? -1 : le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o) => {
    if (o < 0 || o + 4 > t.length) return -1;
    return le ? t[o] + t[o + 1] * 0x100 + t[o + 2] * 0x10000 + t[o + 3] * 0x1000000
      : t[o] * 0x1000000 + t[o + 1] * 0x10000 + t[o + 2] * 0x100 + t[o + 3];
  };
  const w16 = (o, v) => { if (le) { t[o] = v & 255; t[o + 1] = v >>> 8; } else { t[o] = v >>> 8; t[o + 1] = v & 255; } };
  if (u16(2) !== 42) return null;
  return { t, u16, u32, w16, ifd0: u32(4) };
}

function readIfd(r, offset) {
  if (offset < 8) return null;
  const count = r.u16(offset);
  if (count < 0 || count > MAX_IFD_ENTRIES || offset + 2 + count * 12 + 4 > r.t.length) return null;
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    const at = offset + 2 + n * 12;
    const tag = r.u16(at);
    const type = r.u16(at + 2);
    const items = r.u32(at + 4);
    const size = (TYPE_SIZES[type] ?? 1) * items;
    const dataAt = size <= 4 ? at + 8 : r.u32(at + 8);
    entries.push({ at, tag, type, items, size, dataAt, inline: size <= 4 });
  }
  return { offset, count, entries, next: r.u32(offset + 2 + count * 12) };
}

/** The IFD0 and IFD1 directories of a TIFF buffer, or null when unreadable. */
function topIfds(r) {
  const first = readIfd(r, r.ifd0);
  if (first === null) return null;
  const list = [first];
  if (first.next !== 0) {
    const second = readIfd(r, first.next);
    if (second === null || second.offset === first.offset) return null;
    list.push(second);
  }
  return list;
}

/** true / false, or null when the Exif block cannot be read (treated as location). */
function tiffHasGps(bytes) {
  const r = tiff(bytes);
  if (r === null) return null;
  const ifds = topIfds(r);
  if (ifds === null) return null;
  return ifds.some((ifd) => ifd.entries.some((entry) => entry.tag === GPS_POINTER));
}

/** A copy of the TIFF with the GPS directory zeroed and its pointer removed; null when unreadable. */
function tiffWithoutGps(bytes) {
  const t = bytes.slice();
  const r = tiff(t);
  if (r === null) return null;
  const ifds = topIfds(r);
  if (ifds === null) return null;
  for (const ifd of ifds) {
    const index = ifd.entries.findIndex((entry) => entry.tag === GPS_POINTER);
    if (index < 0) continue;
    const gps = readIfd(r, r.u32(ifd.entries[index].at + 8));
    if (gps !== null) {
      for (const entry of gps.entries) {
        if (!entry.inline && entry.dataAt >= 8 && entry.dataAt + entry.size <= t.length) t.fill(0, entry.dataAt, entry.dataAt + entry.size);
      }
      t.fill(0, gps.offset, gps.offset + 2 + gps.count * 12 + 4);
    }
    // Remove the pointer entry: later entries and the next-IFD offset move up
    // twelve bytes; the freed tail is zeroed. Everything is offset-addressed.
    const at = ifd.entries[index].at;
    const tail = ifd.offset + 2 + ifd.count * 12 + 4;
    t.copyWithin(at, at + 12, tail);
    t.fill(0, tail - 12, tail);
    r.w16(ifd.offset, ifd.count - 1);
  }
  return t;
}

const LOCATION_TEXT = /GPS(?:Latitude|Longitude|Altitude|Coordinates)|Location(?:Created|Shown)/u;
const textHasLocation = (bytes, start, end) => LOCATION_TEXT.test(ascii(bytes, start, end));

// ---------------------------------------------------------------------------
// Structure walkers. Each returns { blocks, end } or null when malformed.
// A block is { kind, start, end, ... } for metadata that may carry a
// location; `end` is where the image structure ends.

const EXIF_HEADER = 'Exif\0\0';
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXTENSION_HEADER = 'http://ns.adobe.com/xmp/extension/\0';

function walkJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const blocks = [];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i += 1;
    if (i >= b.length) return null;
    const marker = b[i];
    const start = i - 1;
    i += 1;
    if (marker === 0xd9) return { blocks, end: i };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8 || marker === 0x00) return null;
    if (i + 2 > b.length) return null;
    const length = (b[i] << 8) | b[i + 1];
    if (length < 2 || i + length > b.length) return null;
    const dataStart = i + 2;
    const end = i + length;
    if (marker === 0xe1) {
      if (ascii(b, dataStart, dataStart + 6) === EXIF_HEADER) blocks.push({ kind: 'exif', start, end, tiffStart: dataStart + 6 });
      else if (ascii(b, dataStart, dataStart + XMP_HEADER.length) === XMP_HEADER) blocks.push({ kind: 'xmp', start, end });
      else if (ascii(b, dataStart, dataStart + XMP_EXTENSION_HEADER.length) === XMP_EXTENSION_HEADER) {
        blocks.push({ kind: 'xmp-extension', start, end });
      }
    }
    i = end;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not stuffing or a restart.
      while (i < b.length) {
        if (b[i] !== 0xff) { i += 1; continue; }
        const next = b[i + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { i += 2; continue; }
        if (next === 0xff) { i += 1; continue; }
        break;
      }
    }
  }
  return null;
}

const be32 = (b, o) => b[o] * 0x1000000 + b[o + 1] * 0x10000 + b[o + 2] * 0x100 + b[o + 3];
const le32 = (b, o) => b[o] + b[o + 1] * 0x100 + b[o + 2] * 0x10000 + b[o + 3] * 0x1000000;
const PNG_TEXT = new Set(['tEXt', 'zTXt', 'iTXt']);
const PNG_METADATA_KEYWORDS = new Set(['XML:com.adobe.xmp', 'Raw profile type exif', 'Raw profile type APP1', 'Raw profile type xmp']);

function walkPng(b) {
  if (b.length < 8 || ascii(b, 0, 8) !== '\x89PNG\r\n\x1a\n') return null;
  const blocks = [];
  let i = 8;
  let first = true;
  while (i + 12 <= b.length) {
    const length = be32(b, i);
    const type = ascii(b, i + 4, i + 8);
    const end = i + 12 + length;
    if (!/^[A-Za-z]{4}$/u.test(type) || end > b.length || (first && type !== 'IHDR')) return null;
    first = false;
    const dataStart = i + 8;
    if (type === 'eXIf') blocks.push({ kind: 'exif', start: i, end, tiffStart: dataStart, tiffEnd: end - 4 });
    if (PNG_TEXT.has(type)) {
      const zero = b.indexOf(0, dataStart);
      const keyword = zero < 0 || zero >= end - 4 ? '' : ascii(b, dataStart, zero);
      if (PNG_METADATA_KEYWORDS.has(keyword)) {
        // Only uncompressed XMP can be read here; anything else may hold a location.
        const readable = keyword === 'XML:com.adobe.xmp' && (type === 'tEXt' || (type === 'iTXt' && b[zero + 1] === 0));
        blocks.push({ kind: readable ? 'xmp' : 'opaque-metadata', start: i, end });
      }
    }
    i = end;
    if (type === 'IEND') return { blocks, end: i };
  }
  return null;
}

function walkWebp(b) {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 12) !== 'WEBP') return null;
  const riffEnd = 8 + le32(b, 4);
  if (riffEnd > b.length || riffEnd < 12) return null;
  const blocks = [];
  let vp8x = null;
  let image = false;
  let i = 12;
  while (i < riffEnd) {
    if (i + 8 > riffEnd) return null;
    const type = ascii(b, i, i + 4);
    const size = le32(b, i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > riffEnd) return null;
    if (type === 'VP8X') vp8x = i + 8;
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ANIM') image = true;
    if (type === 'EXIF') {
      const dataStart = i + 8;
      const offset = ascii(b, dataStart, dataStart + 6) === EXIF_HEADER ? 6 : 0;
      blocks.push({ kind: 'exif', start: i, end, tiffStart: dataStart + offset, tiffEnd: dataStart + size });
    }
    if (type === 'XMP ') blocks.push({ kind: 'xmp', start: i, end });
    i = end;
  }
  return image ? { blocks, end: riffEnd, vp8x } : null;
}

function subBlocks(b, i) {
  for (;;) {
    if (i >= b.length) return -1;
    const n = b[i];
    i += 1 + n;
    if (n === 0) return i;
  }
}

function walkGif(b) {
  if (b.length < 13 || !['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6))) return null;
  const blocks = [];
  let i = 13 + (b[10] & 0x80 ? 3 * 2 ** ((b[10] & 7) + 1) : 0);
  while (i >= 0 && i < b.length) {
    const introducer = b[i];
    if (introducer === 0x3b) return { blocks, end: i + 1 };
    if (introducer === 0x2c) {
      if (i + 10 > b.length) return null;
      const packed = b[i + 9];
      i = subBlocks(b, i + 10 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1);
    } else if (introducer === 0x21) {
      const start = i;
      const label = b[i + 1];
      const end = subBlocks(b, i + 2);
      if (end < 0) return null;
      if (label === 0xff && ascii(b, i + 3, i + 14) === 'XMP DataXMP') blocks.push({ kind: 'xmp', start, end });
      i = end;
    } else return null;
  }
  return null;
}

const WALKERS = Object.freeze({ jpeg: walkJpeg, png: walkPng, webp: walkWebp, gif: walkGif });

function blockHasLocation(b, block) {
  if (block.kind === 'exif') return tiffHasGps(b.subarray(block.tiffStart, block.tiffEnd ?? block.end)) !== false;
  if (block.kind === 'opaque-metadata') return true;
  return textHasLocation(b, block.start, block.end);
}

/** true when the image records where it was taken, or cannot be shown not to. */
export function hasLocation(bytes) {
  const walked = WALKERS[sniffImage(bytes)]?.(bytes) ?? null;
  return walked === null || walked.blocks.some((block) => blockHasLocation(bytes, block));
}

/**
 * The node's and the publisher's check for one image in a bundle.
 * { ok: true, type, mediaType } or { ok: false, code }.
 */
export function checkAsset(path, bytes) {
  if (!(bytes instanceof Uint8Array)) return { ok: false, code: 'asset-type-refused' };
  if (bytes.length > ASSET_LIMITS.maxAssetBytes) return { ok: false, code: 'asset-too-large' };
  const named = extensionType(path);
  const sniffed = sniffImage(bytes);
  if (named === null || sniffed === null || sniffed === 'svg') return { ok: false, code: 'asset-type-refused' };
  if (named !== sniffed) return { ok: false, code: 'asset-type-mismatch' };
  const walked = WALKERS[sniffed](bytes);
  // Malformed, or anything after the image ends (a polyglot or appended payload).
  if (walked === null || walked.end !== bytes.length) return { ok: false, code: 'asset-type-refused' };
  if (walked.blocks.some((block) => blockHasLocation(bytes, block))) return { ok: false, code: 'image-has-location' };
  return { ok: true, type: sniffed, mediaType: IMAGE_TYPES[sniffed] };
}

// ---------------------------------------------------------------------------
// The writing device's cleaner. Removes location metadata and anything after
// the image ends; leaves every other byte as it was (orientation, colour
// profile and pixels are untouched). Throws MediaError when it cannot.

function cut(bytes, ranges, end) {
  const keep = [];
  let cursor = 0;
  for (const [start, stop] of [...ranges].sort((a, b) => a[0] - b[0])) {
    keep.push(bytes.subarray(cursor, start));
    cursor = stop;
  }
  keep.push(bytes.subarray(cursor, end));
  const out = new Uint8Array(keep.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of keep) { out.set(part, at); at += part.length; }
  return out;
}

function stripJpeg(bytes, walked) {
  const out = bytes.slice(0, walked.end);
  const drop = [];
  // An XMP packet may continue across extension segments: one location taints all.
  const xmpLocation = walked.blocks.some((block) => block.kind !== 'exif' && textHasLocation(bytes, block.start, block.end));
  for (const block of walked.blocks) {
    if (block.kind === 'exif') {
      const has = tiffHasGps(bytes.subarray(block.tiffStart, block.end));
      if (has === false) continue;
      const cleaned = has === null ? null : tiffWithoutGps(bytes.subarray(block.tiffStart, block.end));
      if (cleaned === null) drop.push([block.start, block.end]);
      else out.set(cleaned, block.tiffStart);
    } else if (xmpLocation) drop.push([block.start, block.end]);
  }
  return cut(out, drop, out.length);
}

function stripPng(bytes, walked) {
  return cut(bytes, walked.blocks.filter((block) => blockHasLocation(bytes, block)).map((block) => [block.start, block.end]), walked.end);
}

function stripWebp(bytes, walked) {
  const dropped = walked.blocks.filter((block) => blockHasLocation(bytes, block));
  const out = cut(bytes, dropped.map((block) => [block.start, block.end]), walked.end);
  const size = out.length - 8;
  out[4] = size & 255; out[5] = (size >>> 8) & 255; out[6] = (size >>> 16) & 255; out[7] = (size >>> 24) & 255;
  if (walked.vp8x !== null) {
    // VP8X comes before every metadata chunk, so its offset is unchanged.
    if (dropped.some((block) => block.kind === 'exif')) out[walked.vp8x] &= ~0x08;
    if (dropped.some((block) => block.kind === 'xmp')) out[walked.vp8x] &= ~0x04;
  }
  return out;
}

function stripGif(bytes, walked) {
  return cut(bytes, walked.blocks.filter((block) => blockHasLocation(bytes, block)).map((block) => [block.start, block.end]), walked.end);
}

const STRIPPERS = Object.freeze({ jpeg: stripJpeg, png: stripPng, webp: stripWebp, gif: stripGif });

/** { bytes, type, changed }: the same image without its location or trailing data. */
export function stripLocation(bytes) {
  if (!(bytes instanceof Uint8Array)) refuse('asset-type-refused', 'not image bytes');
  const type = sniffImage(bytes);
  if (type === null || type === 'svg') refuse('asset-type-refused', 'only PNG, JPEG, WebP and GIF images can be sent');
  const walked = WALKERS[type](bytes);
  if (walked === null) refuse('asset-type-refused', 'the image file is damaged');
  const cleaned = STRIPPERS[type](bytes, walked);
  const again = WALKERS[type](cleaned);
  if (again === null || again.end !== cleaned.length) refuse('asset-type-refused', 'the image could not be cleaned');
  if (again.blocks.some((block) => blockHasLocation(cleaned, block))) refuse('image-has-location', 'the location could not be removed');
  const changed = cleaned.length !== bytes.length || cleaned.some((value, index) => value !== bytes[index]);
  return { bytes: changed ? cleaned : bytes, type, changed };
}

// ---------------------------------------------------------------------------
// Image embeds in Markdown.

const REMOTE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;
const IMAGE_ATTRIBUTE = /<(?:img|source|video|audio|image|input)\b[^>]*?\s(?:srcset|poster|href|xlink:href)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/giu;

/** Every image the text embeds: [{ target, kind, raw, index }]. Code is ignored. */
export function imageEmbeds(markdown) {
  const refs = extractRefs(typeof markdown === 'string' ? markdown : '');
  return [
    ...refs.embeds.map((ref) => ({ target: ref.target, kind: 'wiki-embed', raw: ref.raw, index: ref.index })),
    ...refs.mdImages.map((ref) => ({ target: ref.target, kind: 'md-image', raw: ref.raw, index: ref.index })),
    ...refs.htmlSrcs.map((ref) => ({ target: ref.target, kind: 'html-src', raw: ref.raw, index: ref.index })),
  ].sort((a, b) => a.index - b.index);
}

/** Embeds that would load from elsewhere: http(s):, protocol-relative, data:, or any other scheme. */
export function remoteImageEmbeds(markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  const found = imageEmbeds(text).filter((embed) => REMOTE.test(embed.target));
  for (const match of text.matchAll(IMAGE_ATTRIBUTE)) {
    const value = match[1] ?? match[2] ?? '';
    if (value.split(',').some((part) => REMOTE.test(part.trim()))) {
      found.push({ target: value, kind: 'html-attribute', raw: match[0], index: match.index });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}
