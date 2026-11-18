import { isIP } from 'node:net';

// Canonical numeric identities prevent alternate IPv6 spellings (including
// IPv4-mapped socket peers) from bypassing sender and network buckets.
export function parseIp(value) {
  if (typeof value !== 'string' || value.includes('%')) return null;
  const family = isIP(value);
  if (family === 4) {
    const numeric = value.split('.').reduce((sum, octet) => (sum << 8n) + BigInt(octet), 0n);
    return { family, bits: 32, numeric, address: value };
  }
  if (family !== 6) return null;
  let expanded = value.toLowerCase();
  if (expanded.includes('.')) {
    const colon = expanded.lastIndexOf(':');
    const ipv4 = parseIp(expanded.slice(colon + 1));
    expanded = `${expanded.slice(0, colon)}:${(ipv4.numeric >> 16n).toString(16)}:${(ipv4.numeric & 65535n).toString(16)}`;
  }
  const halves = expanded.split('::');
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1].split(':');
  const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const numeric = words.reduce((sum, word) => (sum << 16n) + BigInt(`0x${word}`), 0n);
  if (numeric >> 32n === 65535n) {
    const low = numeric & 0xffffffffn;
    return parseIp([24n, 16n, 8n, 0n].map((shift) => Number((low >> shift) & 255n)).join('.'));
  }
  return { family, bits: 128, numeric, address: words.map((word) => Number.parseInt(word, 16).toString(16)).join(':') };
}

export function parseCidr(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 2 || !/^(?:0|[1-9][0-9]{0,2})$/u.test(parts[1])) return null;
  const ip = parseIp(parts[0]);
  const prefix = Number(parts[1]);
  if (ip === null) return null;
  const family = isIP(parts[0]);
  const bits = family === 4 ? 32 : 128;
  if (prefix > bits) return null;
  const numeric = family === 6 && ip.family === 4 ? (65535n << 32n) | ip.numeric : ip.numeric;
  const shift = BigInt(bits - prefix);
  return { family, shift, network: numeric >> shift };
}

export function networkIdentity(ip) {
  if (ip === null) return 'unknown';
  return `${ip.family}:${ip.numeric >> BigInt(ip.family === 4 ? 8 : 64)}`;
}
