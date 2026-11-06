import { fail } from './errors.js';

const CREDENTIAL_KEY = /(?:password|passwd|secret|token|credential|authorization|cookie|privatekey|clientsecret|apikey|accesstoken|refreshtoken)$/i;
const CREDENTIAL_VALUE = /(?:\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{12,}\b|\bgithub_pat_[A-Za-z0-9_]{12,}\b|\bsk-[A-Za-z0-9_-]{16,}\b)/i;
const SCHEME_CHARACTER = /[a-z0-9+.-]/i;
const ASCII_LETTER = /[a-z]/i;
const USERINFO_END = /[/@\s]/;

function hasUrlCredentialMaterial(value) {
  for (let separator = value.indexOf('://'); separator !== -1; separator = value.indexOf('://', separator + 3)) {
    // The old unanchored pattern may start at any ASCII letter within this run.
    let hasSchemeLetter = false;
    for (let index = separator - 1; index >= 0 && SCHEME_CHARACTER.test(value[index]); index -= 1) {
      hasSchemeLetter ||= ASCII_LETTER.test(value[index]);
    }
    if (!hasSchemeLetter) continue;

    const start = separator + 3;
    let end = start;
    let colon = -1;
    for (; end < value.length && !USERINFO_END.test(value[end]); end += 1) {
      if (value[end] === ':' && end > start && colon === -1) colon = end;
    }
    // Both sides of the separator colon must contain at least one character.
    if (value[end] === '@' && colon !== -1 && colon < end - 1) return true;
    // Slashes in each :// delimit the spans, so neither loop rescans a long run
    // for multiple separators. Together with indexOf, total URL work is O(n).
  }
  return false;
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertNoCredentialMaterial(value, location = '$') {
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE.test(value) || hasUrlCredentialMaterial(value)) {
      fail('credentials-forbidden', `credential-like material is forbidden at ${location}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialMaterial(entry, `${location}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^A-Za-z0-9]/g, '');
    if (CREDENTIAL_KEY.test(normalized)) {
      fail('credentials-forbidden', `credential fields are forbidden at ${location}.${key}`);
    }
    assertNoCredentialMaterial(entry, `${location}.${key}`);
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid-json-value', 'canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  fail('invalid-json-value', 'canonical JSON accepts only JSON-compatible values');
}

export function artifactJson(value) {
  assertNoCredentialMaterial(value);
  return `${canonicalJson(value)}\n`;
}

export function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }
  return value;
}
