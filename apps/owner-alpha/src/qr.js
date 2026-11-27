// A small QR code encoder for the pairing link: byte mode, error correction
// level M, versions 1 to 40, all eight masks scored. No dependency. It follows
// ISO/IEC 18004 and the structure of Project Nayuki's reference encoder; the
// tests decode its output with an independent decoder.

const ECC_CODEWORDS_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const ERROR_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_BITS_M = 0; // L=1, M=0, Q=3, H=2

export const QR_MAX_VERSION = 40;

const bit = (value, index) => ((value >>> index) & 1) !== 0;

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version) {
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK_M[version] * ERROR_BLOCKS_M[version];
}

// Byte-mode capacity in bytes at level M.
export function qrByteCapacity(version) {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let position = version * 4 + 17 - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

function withErrorCorrection(data, version) {
  const blocks = ERROR_BLOCKS_M[version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK_M[version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLength);
  const all = [];
  for (let i = 0, k = 0; i < blocks; i += 1) {
    const dat = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0); // placeholder, skipped while interleaving
    all.push([...dat, ...ecc]);
  }
  const result = [];
  for (let i = 0; i < all[0].length; i += 1) {
    all.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const finder = (line) => {
    // 1:1:3:1:1 dark-light pattern with four light modules on one side.
    let count = 0;
    const padded = [0, 0, 0, 0, ...line.map(Number), 0, 0, 0, 0];
    for (let i = 0; i + 11 <= padded.length; i += 1) {
      const s = padded.slice(i, i + 11).join('');
      if (s === '10111010000' || s === '00001011101') count += 1;
    }
    return count;
  };
  const lines = [];
  for (let y = 0; y < size; y += 1) lines.push(modules[y]);
  for (let x = 0; x < size; x += 1) lines.push(modules.map((row) => row[x]));
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= line.length; i += 1) {
      if (i < line.length && line[i] === line[i - 1]) { run += 1; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    score += finder(line) * 40;
  }
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; reserved[y][x] = true; };

  for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx; const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((ay, i) => positions.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));

  const drawFormat = (maskId) => {
    const data = (FORMAT_BITS_M << 3) | maskId;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserve the format areas before placing data

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      set(a, b, bit(bits, i)); set(b, a, bit(bits, i));
    }
  }

  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y][x] && index < codewords.length * 8) {
          modules[y][x] = bit(codewords[index >>> 3], 7 - (index & 7));
          index += 1;
        }
      }
    }
  }
  const test = MASKS[mask];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (!reserved[y][x] && test(x, y)) modules[y][x] = !modules[y][x];
  }
  drawFormat(mask);
  return modules;
}

// The module grid for `text` (UTF-8), true = dark. Picks the smallest version
// that fits and the mask with the lowest penalty (or `mask`, for tests).
export function qrMatrix(text, { minVersion = 1, mask: forcedMask = null } = {}) {
  if (typeof text !== 'string') throw new TypeError('QR text must be a string');
  const bytes = [...new TextEncoder().encode(text)];
  let version = Math.max(1, minVersion);
  while (version <= QR_MAX_VERSION && qrByteCapacity(version) < bytes.length) version += 1;
  if (version > QR_MAX_VERSION) throw new RangeError('text is too long for a QR code');
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(Number.parseInt(bits.slice(i, i + 8).join(''), 2));
  const codewords = withErrorCorrection(data, version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    if (forcedMask !== null && mask !== forcedMask) continue;
    const modules = buildMatrix(version, codewords, mask);
    const score = penalty(modules);
    if (best === null || score < best.score) best = { modules, score, mask };
  }
  return Object.freeze({ version, mask: best.mask, size: best.modules.length, modules: best.modules });
}

// SVG path data for the dark modules, offset by a four-module quiet zone.
// Only `M`, `h`, `v`, digits and `z`, so a page can check it before use.
export function qrPath(matrix, border = 4) {
  const parts = [];
  matrix.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end += 1;
      parts.push(`M${x + border} ${y + border}h${end - x + 1}v1h-${end - x + 1}z`);
      x = end;
    }
  });
  return parts.join('');
}

export function qrSvg(text, { border = 4, title = 'QR code' } = {}) {
  const matrix = qrMatrix(text);
  const dimension = matrix.size + border * 2;
  const escaped = title.replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges" role="img" aria-label="${escaped}">`
    + `<rect width="${dimension}" height="${dimension}" fill="#fff"/><path fill="#000" d="${qrPath(matrix, border)}"/></svg>`;
}
