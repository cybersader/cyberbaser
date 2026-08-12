import { fail } from './errors.js';

const CREDENTIAL_KEY = /(?:password|passwd|secret|token|credential|authorization|cookie|privatekey|clientsecret|apikey|accesstoken|refreshtoken)$/i;
const CREDENTIAL_VALUE = /(?:[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@|\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{12,}\b|\bgithub_pat_[A-Za-z0-9_]{12,}\b|\bsk-[A-Za-z0-9_-]{16,}\b)/i;

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertNoCredentialMaterial(value, location = '$') {
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE.test(value)) {
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
