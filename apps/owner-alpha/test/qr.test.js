import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import jsQR from 'jsqr';
import { qrByteCapacity, qrMatrix, qrPath, qrSvg } from '../src/qr.js';

// The encoder is checked by an independent rasterizer (ImageMagick renders
// the SVG) and an independent decoder (jsQR, dev-only). Neither shares code
// with src/qr.js.
const SCALE = 6;

function decodeSvg(svg) {
  const size = Number(svg.match(/viewBox="0 0 (\d+) /u)[1]) * SCALE;
  // librsvg's base density is 96 per inch, so 96 * SCALE gives SCALE pixels per module.
  const raster = spawnSync('magick', ['-density', String(96 * SCALE), 'svg:-', '-depth', '8', 'rgba:-'],
    { input: svg, maxBuffer: 64 * 1024 * 1024 });
  if (raster.status !== 0) throw new Error(`magick failed: ${raster.stderr}`);
  const pixels = new Uint8ClampedArray(raster.stdout);
  expect(pixels.length).toBe(size * size * 4);
  return jsQR(pixels, size, size, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

const fakeCode = (ticketLength) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const ticket = Array.from(randomBytes(ticketLength), (b) => alphabet[b % 32]).join('');
  return `cb1.${ticket}.${randomBytes(16).toString('hex')}.${randomBytes(32).toString('base64url')}`;
};
const link = (code) => `obsidian://cyberbaser-pair?code=${encodeURIComponent(code)}`;

describe('QR encoder', () => {
  test('capacity table matches the standard for byte mode, level M', () => {
    expect([1, 2, 5, 10, 13, 20, 27, 40].map(qrByteCapacity)).toEqual([14, 26, 84, 213, 331, 666, 1125, 2331]);
  });

  test('version 1 known-size and path syntax', () => {
    const matrix = qrMatrix('hello');
    expect(matrix.version).toBe(1);
    expect(matrix.size).toBe(21);
    expect(qrPath(matrix)).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/u);
  });

  test('text that does not fit is refused', () => {
    expect(() => qrMatrix('x'.repeat(2332))).toThrow(RangeError);
  });

  const cases = [
    ['short text', 'hello'],
    ['version-boundary text', 'a'.repeat(14)],
    ['one over the boundary', 'a'.repeat(15)],
    ['UTF-8 text', 'Pairing: café ✓'],
    ['typical relay pairing link', link(fakeCode(180))],
    ['long loopback pairing link', link(fakeCode(420))],
    ['longest code the parser accepts', link(fakeCode(1800)).slice(0, 2000)],
  ];
  for (const [name, text] of cases) {
    test(`round trip through an independent decoder: ${name}`, () => {
      const svg = qrSvg(text);
      expect(decodeSvg(svg)).toBe(text);
    }, 30_000);
  }

  test('several random pairing links across versions 7 and up decode', () => {
    for (const length of [60, 140, 260, 600]) {
      const text = link(fakeCode(length));
      const matrix = qrMatrix(text);
      expect(matrix.version).toBeGreaterThanOrEqual(7);
      expect(decodeSvg(qrSvg(text))).toBe(text);
    }
  }, 60_000);

  test('every mask produces a decodable symbol', () => {
    const text = link(fakeCode(200));
    for (let mask = 0; mask < 8; mask += 1) {
      const matrix = qrMatrix(text, { mask });
      expect(matrix.mask).toBe(mask);
      const dimension = matrix.size + 8;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">`
        + `<rect width="${dimension}" height="${dimension}" fill="#fff"/><path fill="#000" d="${qrPath(matrix)}"/></svg>`;
      expect(decodeSvg(svg)).toBe(text);
    }
  }, 60_000);
});
