// Real image files built in the test, byte by byte: a 1x1 PNG with a zlib
// IDAT and correct CRCs, an 8x8 baseline JPEG (one block, DC only), Exif
// blocks with and without a GPS directory, and XMP packets. Small WebP and GIF
// files are fixed constants made once with Pillow.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16be = (v) => [v >>> 8, v & 255];
const u32be = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u32le = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const text = (value) => [...Buffer.from(value, 'latin1')];

export function pngChunk(type, data) {
  const body = [...text(type), ...data];
  return [...u32be(data.length), ...body, ...u32be(crc32(Uint8Array.from(body)))];
}

/** A 1x1 RGB PNG; `extra` chunks go after IHDR. */
export function png({ extra = [], rgb = [200, 30, 30], trailing = [] } = {}) {
  const ihdr = [...u32be(1), ...u32be(1), 8, 2, 0, 0, 0];
  const idat = [...deflateSync(Buffer.from([0, ...rgb]))];
  return Uint8Array.from([0x89, ...text('PNG\r\n\x1a\n'), ...pngChunk('IHDR', ihdr), ...extra.flat(),
    ...pngChunk('IDAT', idat), ...pngChunk('IEND', []), ...trailing]);
}

/**
 * A big- or little-endian TIFF block: IFD0 with Orientation = 6, plus a GPS
 * directory (N 47 36 0 / W 122 19 0) when gps is true.
 */
export function exifTiff({ gps = true, littleEndian = false } = {}) {
  const w16 = (v) => (littleEndian ? [v & 255, v >>> 8] : u16be(v));
  const w32 = (v) => (littleEndian ? u32le(v) : u32be(v));
  const entry = (tag, type, count, value) => [...w16(tag), ...w16(type), ...w32(count), ...value];
  const ifd0Count = gps ? 2 : 1;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const gpsAt = 8 + ifd0Size;
  const gpsCount = 4;
  const gpsDataAt = gpsAt + 2 + gpsCount * 12 + 4;
  const rationals = (values) => values.flatMap(([n, d]) => [...w32(n), ...w32(d)]);
  const ifd0 = [...w16(ifd0Count), ...entry(0x0112, 3, 1, [...w16(6), 0, 0]),
    ...(gps ? entry(0x8825, 4, 1, w32(gpsAt)) : []), ...w32(0)];
  const gpsIfd = gps ? [...w16(gpsCount),
    ...entry(0x0001, 2, 2, [...text('N'), 0, 0, 0]),
    ...entry(0x0002, 5, 3, w32(gpsDataAt)),
    ...entry(0x0003, 2, 2, [...text('W'), 0, 0, 0]),
    ...entry(0x0004, 5, 3, w32(gpsDataAt + 24)),
    ...w32(0),
    ...rationals([[47, 1], [36, 1], [0, 1]]), ...rationals([[122, 1], [19, 1], [0, 1]])] : [];
  return Uint8Array.from([...(littleEndian ? text('II') : text('MM')), ...w16(42), ...w32(8), ...ifd0, ...gpsIfd]);
}

export const xmpPacket = (withLocation) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" ${withLocation ? 'exif:GPSLatitude="47,36.0N" exif:GPSLongitude="122,19.0W"' : 'exif:ColorSpace="1"'}/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

const segment = (marker, data) => [0xff, marker, ...u16be(data.length + 2), ...data];

/** An 8x8 grey baseline JPEG; Exif and XMP segments go after SOI. */
export function jpeg({ exif = null, xmp = null, trailing = [] } = {}) {
  const dqt = segment(0xdb, [0x00, ...new Array(64).fill(1)]);
  const sof = segment(0xc0, [8, ...u16be(8), ...u16be(8), 1, 1, 0x11, 0]);
  const table = (klass) => segment(0xc4, [klass, 1, ...new Array(15).fill(0), 0x00]);
  const sos = segment(0xda, [1, 1, 0x00, 0, 63, 0]);
  return Uint8Array.from([0xff, 0xd8,
    ...(exif ? segment(0xe1, [...text('Exif\0\0'), ...exif]) : []),
    ...(xmp === null ? [] : segment(0xe1, [...text('http://ns.adobe.com/xap/1.0/\0'), ...text(xmp)])),
    ...dqt, ...sof, ...table(0x00), ...table(0x10), ...sos, 0x3f, 0xff, 0xd9, ...trailing]);
}

/** 1x1 lossless WebP from Pillow 12.3 (simple format, no VP8X). */
export const WEBP = Uint8Array.from(Buffer.from('524946461e000000574542505650384c110000002f0000000007508f22d7a3ff8188e87f0000', 'hex'));
/** 1x1 GIF87a from Pillow 12.3. */
export const GIF = Uint8Array.from(Buffer.from('47494638376101000100810000c81e1e0000000000000000002c000000000100010000080400010404003b', 'hex'));

/** The WebP above in the extended format, with an EXIF chunk (and VP8X flag) appended. */
export function webpWithExif(tiffBytes) {
  const image = WEBP.subarray(12);
  const vp8x = [...text('VP8X'), ...u32le(10), 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const exif = [...text('EXIF'), ...u32le(tiffBytes.length), ...tiffBytes, ...(tiffBytes.length % 2 ? [0] : [])];
  const body = [...text('WEBP'), ...vp8x, ...image, ...exif];
  return Uint8Array.from([...text('RIFF'), ...u32le(body.length), ...body]);
}

export const SVG = Uint8Array.from(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n'));
