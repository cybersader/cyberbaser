import { createHash } from 'node:crypto';

export const FIXED_NOW = '2026-08-12T12:00:00Z';
export const FIXED_QUEUE_IDS = Object.freeze([
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
]);
export const BASE_BYTES = Buffer.from(`---
title: Iroh fixture
---

# Iroh fixture

A controlled local carrier should correct teh exact typo without rewriting untouched bytes.
`, 'utf8');

function canonicalize(value, at, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${at} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError(`${at} contains unsupported JSON value ${typeof value}`);
  if (seen.has(value)) throw new TypeError(`${at} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry, index) => canonicalize(entry, `${at}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${at} must contain only plain JSON objects`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) throw new TypeError(`${at}.${key} is undefined`);
    result[key] = canonicalize(entry, `${at}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

export function stableStringify(value) {
  return `${JSON.stringify(canonicalize(value, '$', new WeakSet()), null, 2)}\n`;
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest();
}

export function sha256Digest(value) {
  return `sha-256=:${sha256Bytes(value).toString('base64')}:`;
}

export function proposalContentKey(value) {
  return sha256Bytes(value).toString('base64url');
}

export function fixedIdFactory(values = FIXED_QUEUE_IDS) {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error('fixed queue identifiers exhausted');
    return values[index++];
  };
}

const RUNTIME_KEY_RE = /^(?:tempPath|temporaryPath|boundPort|relayUrl|duration|elapsed|pid|socketAddress|remoteAddress|localAddress|workDir|connectionId)$/u;
const RUNTIME_VALUE_RE = /(?:\/tmp\/|cb-iroh-|127\.0\.0\.1:\d+|localhost:\d+)/u;

export function runtimeLeakPaths(value, at = '$', found = []) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return found;
  if (typeof value === 'string') {
    if (RUNTIME_VALUE_RE.test(value)) found.push(at);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => runtimeLeakPaths(entry, `${at}[${index}]`, found));
    return found;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (RUNTIME_KEY_RE.test(key)) found.push(`${at}.${key}`);
    runtimeLeakPaths(entry, `${at}.${key}`, found);
  }
  return found;
}
