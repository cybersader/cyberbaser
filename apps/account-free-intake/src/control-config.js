import path from 'node:path';

export class IntakeConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IntakeConfigError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new IntakeConfigError(code, message);
}

export function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactObject(value, keys, label) {
  if (!isRecord(value)) fail('invalid-config', `${label} must be an object`);
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) fail('invalid-config', `${label} contains unknown field ${unknown}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('invalid-config', `${label} is missing field ${missing}`);
  return value;
}

export function exactInteger(value, expected, label) {
  if (value !== expected) fail('invalid-config', `${label} must be ${expected}`);
  return value;
}

export function normalizedAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail('invalid-config', `${label} must be one normalized absolute path`);
  }
  if (value === path.parse(value).root || value.includes('\0')) {
    fail('invalid-config', `${label} must not be a filesystem root or contain NUL`);
  }
  return value;
}

