// The publisher's own list of owner keys: the only thing that decides whether
// a push or a key change was approved by the owner.
//
// It lives in one directory of the publisher's account (installed:
// /var/lib/cyberbaser-publisher/owners, mode 0700, InaccessiblePaths for the
// node). Its location is a publisher start argument, never a config field, and
// nothing in it is ever read from the node's config, job store or sockets:
// the node can only hand the publisher signed requests, which are checked
// against this list.
//
//   publisher-key.json  the publisher's own Ed25519 seed (its public half is
//                       the "publisher" field of every intent; signs receipts)
//   owners.json         the owner keys, the recovery key (public half only)
//                       and a short history of changes
//   enrollment.json     the one-time first-device code, only while no owner
//                       key exists; removed by the first enrollment
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  ENROLL_CODE_BYTES, RECOVERY_CODE_BYTES, RECOVERY_KEY_ID, admitApproval, b64url, createNonceBook, ed25519FromSeed, enrollConfirm,
  enrollProof, formatCode, fromB64url, keyFingerprint, macEqual, recoveryKeyFromCode, signStatement, validOwnerKey,
} from '../../../../packages/signed-intent/src/index.js';
import { OwnerAlphaError, fail } from '../errors.js';

export const OWNER_FILES = Object.freeze({ key: 'publisher-key.json', owners: 'owners.json', enrollment: 'enrollment.json' });
export const ENROLLMENT_LIFETIME_MS = 60 * 60_000;
export const OWNER_GRANTS = Object.freeze(['publish', 'key-add', 'key-revoke']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_HISTORY = 500;
const MAX_KEYS = 32;

// Plain reasons a receipt or screen can show. Codes are stable.
export const APPROVAL_PROBLEMS = Object.freeze({
  'owner-approval-missing': 'Waiting for your approval on a device that can publish.',
  'owner-approval-expired': 'The approval expired or was already used. Approve again on your device.',
  'owner-approval-invalid': 'The approval was not signed by a device on the publisher\'s list, so nothing was published.',
  'owner-approval-mismatch': 'The change does not match what your device approved, so nothing was published.',
  'owner-enrollment-closed': 'A device is already set up, or the setup code expired. Run "cyberbaser publisher enroll-code" as the administrator for a new one.',
  'owner-enrollment-refused': 'That setup code is not the one the publisher showed.',
  'owner-key-refused': 'That device change was not approved by a device on the list.',
  'owner-busy': 'Too many approvals are waiting. Try again in a few minutes.',
});
const EXPIRED = new Set(['expired', 'not-yet-valid', 'nonce-unknown-or-used']);

function unsafe() {
  fail('publisher-unsafe-owner-state', 'the publisher owner-key state must be its own private directory');
}

function validDirectory(directory) {
  return typeof directory === 'string' && path.isAbsolute(directory) && path.normalize(directory) === directory
    && path.dirname(directory) !== '/' && !/[\p{Cc}]/u.test(directory);
}

async function ensureDirectory(directory, uid) {
  if (!validDirectory(directory)) unsafe();
  const parent = await lstat(path.dirname(directory)).catch(() => null);
  if (parent === null || !parent.isDirectory() || ![0, uid].includes(parent.uid) || (parent.mode & 0o022) !== 0) unsafe();
  let entry = await lstat(directory).catch(() => null);
  if (entry === null) {
    await mkdir(directory, { mode: 0o700 });
    entry = await lstat(directory);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || (entry.mode & 0o777) !== 0o700) unsafe();
}

async function readPrivate(file, uid) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    unsafe();
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== uid || (metadata.mode & 0o077) !== 0
      || metadata.size > MAX_FILE_BYTES) unsafe();
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    return unsafe();
  } finally {
    await handle.close();
  }
}

async function writePrivate(file, value) {
  const temporary = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

function emptyOwners(publisher) {
  return { v: 1, publisher, keys: [], recovery: null, history: [] };
}

function validOwners(value, publisher) {
  return value && value.v === 1 && value.publisher === publisher && Array.isArray(value.keys) && value.keys.length <= MAX_KEYS * 4
    && Array.isArray(value.history) && (value.recovery === null || typeof value.recovery?.publicKey === 'string');
}

/** The publisher's key and current owner list, created on first use. */
export async function openOwnerState({ directory, uid = process.getuid(), random = randomBytes }) {
  await ensureDirectory(directory, uid);
  const keyFile = path.join(directory, OWNER_FILES.key);
  let stored = await readPrivate(keyFile, uid);
  if (stored === null) {
    // Create once: a second process racing here keeps the first key.
    const temporary = `${keyFile}.tmp-${randomBytes(6).toString('hex')}`;
    await writePrivate(temporary, { v: 1, seed: b64url(random(32)) });
    try { await link(temporary, keyFile); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    finally { await rm(temporary, { force: true }); }
    stored = await readPrivate(keyFile, uid);
  }
  const seed = fromB64url(stored?.seed, 32);
  if (stored?.v !== 1 || seed === null) unsafe();
  const publisher = ed25519FromSeed(seed).publicKey.toString('hex');
  const ownersFile = path.join(directory, OWNER_FILES.owners);
  const enrollmentFile = path.join(directory, OWNER_FILES.enrollment);
  return Object.freeze({
    directory,
    publisher,
    seed,
    async owners() {
      const value = await readPrivate(ownersFile, uid);
      if (value === null) return emptyOwners(publisher);
      if (!validOwners(value, publisher)) unsafe();
      return value;
    },
    async saveOwners(value) {
      value.history = value.history.slice(-MAX_HISTORY);
      await writePrivate(ownersFile, value);
    },
    async enrollment() {
      const value = await readPrivate(enrollmentFile, uid);
      if (value === null) return null;
      const secret = fromB64url(value.secret, ENROLL_CODE_BYTES);
      if (value.v !== 1 || secret === null || !Number.isSafeInteger(value.expiresAt)) unsafe();
      return { secret, expiresAt: value.expiresAt, createdAt: value.createdAt };
    },
    async saveEnrollment(value) {
      if (value === null) await rm(enrollmentFile, { force: true });
      else await writePrivate(enrollmentFile, { v: 1, secret: b64url(value.secret), createdAt: value.createdAt, expiresAt: value.expiresAt });
    },
  });
}

const activeKeys = (owners) => owners.keys.filter((key) => key.revokedAt === null);

export function enrollmentUri(publisher, secret) {
  // The Obsidian plugin's link handler; any device can also take the code typed.
  return `obsidian://cyberbaser-enrol?publisher=${publisher}&code=${formatCode(secret)}`;
}

/**
 * Administrator commands (run as the publisher account, or by the installer
 * through it). issueEnrollmentCode opens a fresh first-device window when no
 * owner key exists, and creates a recovery code when there is none: the code
 * is returned once and only its derived public key is stored.
 */
export async function issueEnrollmentCode({ directory, uid = process.getuid(), now = Date.now(), random = randomBytes, recovery = true }) {
  const state = await openOwnerState({ directory, uid, random });
  const owners = await state.owners();
  if (activeKeys(owners).length > 0) return { publisher: state.publisher, enrolled: true };
  const secret = random(ENROLL_CODE_BYTES);
  await state.saveEnrollment({ secret, createdAt: now, expiresAt: now + ENROLLMENT_LIFETIME_MS });
  let recoveryCode = null;
  if (recovery && owners.recovery === null) {
    recoveryCode = formatCode(random(RECOVERY_CODE_BYTES));
    owners.recovery = { publicKey: recoveryKeyFromCode(recoveryCode, state.publisher).publicKey, createdAt: now };
    owners.history.push({ at: now, kind: 'recovery-created', by: 'administrator' });
    await state.saveOwners(owners);
  }
  return { publisher: state.publisher, enrolled: false, code: formatCode(secret), uri: enrollmentUri(state.publisher, secret),
    expiresAt: now + ENROLLMENT_LIFETIME_MS, recoveryCode };
}

/** Console reset: every owner key and the recovery key are removed; a fresh code and recovery code are issued. */
export async function resetOwners({ directory, uid = process.getuid(), now = Date.now(), random = randomBytes }) {
  const state = await openOwnerState({ directory, uid, random });
  const owners = await state.owners();
  for (const key of activeKeys(owners)) key.revokedAt = now;
  owners.recovery = null;
  owners.history.push({ at: now, kind: 'reset-owners', by: 'administrator' });
  await state.saveOwners(owners);
  return issueEnrollmentCode({ directory, uid, now, random });
}

function storedKey(key, { now, by }) {
  return { ...key, may: [...OWNER_GRANTS], ...(key.type === 'webauthn' ? { counter: 0 } : {}), addedAt: now, addedBy: by, revokedAt: null };
}

function roster(owners) {
  return new Map(owners.keys.map((key) => [key.keyId, { ...key, revoked: key.revokedAt !== null }]));
}

function serial() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

function refused(code, reason) {
  return new OwnerAlphaError(code, APPROVAL_PROBLEMS[code], { reason });
}

/**
 * The running publisher's view. All state is re-read from disk for every
 * operation (the administrator commands may change it); operations run one at
 * a time. log(line) receives plain lines with no secret in them.
 */
export async function createOwnerKeys({ directory, uid = process.getuid(), now = Date.now, random = randomBytes, log = () => {} }) {
  const state = await openOwnerState({ directory, uid, random });
  const nonces = createNonceBook({ random });
  const exclusive = serial();
  const publisher = state.publisher;

  async function admit(record, kind, { signerKey = null, owners }) {
    if (!record || typeof record !== 'object' || record.intent?.kind !== kind) throw refused(kind === 'publish' ? 'owner-approval-invalid' : 'owner-key-refused', 'intent-invalid');
    const result = admitApproval({ intent: record.intent, approval: record.approval, roster: roster(owners), publisherId: publisher,
      nonces, now: now(), signerKey });
    return result;
  }

  return Object.freeze({
    publisher,
    challenge: () => exclusive(async () => {
      const issued = nonces.issue(now());
      if (issued === null) throw refused('owner-busy', 'too-many-pending');
      return { publisher, ...issued };
    }),
    status: () => exclusive(async () => {
      const owners = await state.owners();
      const enrollment = await state.enrollment();
      return { publisher, devices: activeKeys(owners).length, recovery: owners.recovery !== null,
        enrollmentOpen: activeKeys(owners).length === 0 && enrollment !== null && enrollment.expiresAt > now() };
    }),
    // Only for the publisher's own display channels (its log, its loopback page).
    enrollmentDisplay: () => exclusive(async () => {
      const owners = await state.owners();
      const enrollment = await state.enrollment();
      if (activeKeys(owners).length > 0 || enrollment === null || enrollment.expiresAt <= now()) return null;
      return { publisher, code: formatCode(enrollment.secret), uri: enrollmentUri(publisher, enrollment.secret), expiresAt: enrollment.expiresAt };
    }),
    // At start: open a window when nobody can approve yet and none is open.
    ensureEnrollment: () => exclusive(async () => {
      const owners = await state.owners();
      if (activeKeys(owners).length > 0) return null;
      const current = await state.enrollment();
      if (current !== null && current.expiresAt > now()) return { created: false, expiresAt: current.expiresAt };
      const secret = random(ENROLL_CODE_BYTES);
      const at = now();
      await state.saveEnrollment({ secret, createdAt: at, expiresAt: at + ENROLLMENT_LIFETIME_MS });
      return { created: true, code: formatCode(secret), uri: enrollmentUri(publisher, secret), expiresAt: at + ENROLLMENT_LIFETIME_MS };
    }),
    enroll: (record) => exclusive(async () => {
      const owners = await state.owners();
      const enrollment = await state.enrollment();
      if (activeKeys(owners).length > 0 || enrollment === null || enrollment.expiresAt <= now()) throw refused('owner-enrollment-closed', 'closed');
      const key = record?.intent?.subject?.key;
      if (!validOwnerKey(key) || owners.keys.some((entry) => entry.keyId === key.keyId)) throw refused('owner-enrollment-refused', 'key');
      const result = await admit(record, 'enroll', { owners, signerKey: { ...key, may: ['enroll'], counter: 0, revoked: false } });
      if (!result.ok) throw refused('owner-enrollment-refused', result.code);
      if (!macEqual(result.intent.subject.proof, enrollProof(enrollment.secret, publisher, key))) {
        log('An enrollment with a wrong setup code was refused. If you did not just set up a device, someone else tried to.');
        throw refused('owner-enrollment-refused', 'wrong-code');
      }
      const at = now();
      owners.keys.push(storedKey(key, { now: at, by: 'enrollment-code' }));
      owners.history.push({ at, kind: 'enroll', by: key.keyId, key: key.keyId, digest: result.digest });
      await state.saveOwners(owners);
      await state.saveEnrollment(null);
      log(`First device can now publish: "${key.label}" (${keyFingerprint(key)}).`);
      return { keyId: key.keyId, fingerprint: keyFingerprint(key), confirm: enrollConfirm(enrollment.secret, publisher, result.digest) };
    }),
    change: (record) => exclusive(async () => {
      const owners = await state.owners();
      const kind = record?.intent?.kind;
      if (!['key-add', 'key-revoke', 'recovery-reset'].includes(kind)) throw refused('owner-key-refused', 'kind');
      let signerKey = null;
      if (kind === 'recovery-reset') {
        if (owners.recovery === null) throw refused('owner-key-refused', 'no-recovery-key');
        signerKey = { type: 'ed25519', publicKey: owners.recovery.publicKey, may: ['recovery-reset'], revoked: false };
      }
      const result = await admit(record, kind, { owners, signerKey });
      if (!result.ok) throw refused('owner-key-refused', result.code);
      const { subject } = result.intent;
      const at = now();
      if (kind === 'key-add' || kind === 'recovery-reset') {
        if (owners.keys.some((entry) => entry.keyId === subject.key.keyId) || activeKeys(owners).length >= MAX_KEYS) {
          throw refused('owner-key-refused', 'key-exists');
        }
      }
      if (kind === 'key-add') {
        owners.keys.push(storedKey(subject.key, { now: at, by: result.keyId }));
        log(`Device added: "${subject.key.label}" (${keyFingerprint(subject.key)}), approved by ${result.keyId}.`);
      } else if (kind === 'key-revoke') {
        const target = owners.keys.find((entry) => entry.keyId === subject.keyId && entry.revokedAt === null);
        if (!target) throw refused('owner-key-refused', 'unknown-key');
        if (activeKeys(owners).length === 1) throw refused('owner-key-refused', 'last-key');
        target.revokedAt = at;
        log(`Device removed: "${target.label}", by ${result.keyId}.`);
      } else {
        for (const key of activeKeys(owners)) key.revokedAt = at;
        owners.keys.push(storedKey(subject.key, { now: at, by: RECOVERY_KEY_ID }));
        owners.recovery = subject.recoveryKey === null ? null : { publicKey: subject.recoveryKey, createdAt: at };
        await state.saveEnrollment(null);
        log(`Recovery code used: every device was removed and "${subject.key.label}" (${keyFingerprint(subject.key)}) can publish.`);
      }
      owners.history.push({ at, kind, by: result.keyId, key: kind === 'key-revoke' ? subject.keyId : subject.key.keyId, digest: result.digest });
      await state.saveOwners(owners);
      return { kind, keyId: kind === 'key-revoke' ? subject.keyId : subject.key.keyId };
    }),
    /** The list every device shows under "Devices that can publish", signed by the publisher. */
    list: () => exclusive(async () => {
      const owners = await state.owners();
      const body = { v: 1, kind: 'owner-keys', publisher, at: now(), recovery: owners.recovery !== null,
        keys: owners.keys.map(({ keyId, type, label, addedAt, addedBy, revokedAt }) => ({ keyId, type, label, addedAt, addedBy, revokedAt })) };
      return { body, signature: signStatement(body, state.seed) };
    }),
    /**
     * Admit a publish approval for this publisher's own target, consuming its
     * nonce. Throws owner-approval-* errors; returns the admitted intent.
     */
    admitPublish: (record, { remote, branch }) => exclusive(async () => {
      if (record === null || record === undefined) throw refused('owner-approval-missing', 'missing');
      const owners = await state.owners();
      const result = await admit(record, 'publish', { owners });
      if (!result.ok) throw refused(EXPIRED.has(result.code) ? 'owner-approval-expired' : 'owner-approval-invalid', result.code);
      if (result.intent.target.remote !== remote || result.intent.target.branch !== branch) throw refused('owner-approval-mismatch', 'target');
      const at = now();
      if (result.counter !== undefined) {
        const key = owners.keys.find((entry) => entry.keyId === result.keyId);
        if (key) key.counter = result.counter;
      }
      owners.history.push({ at, kind: 'publish', by: result.keyId, digest: result.digest });
      await state.saveOwners(owners);
      return result;
    }),
    signStatement: (body) => signStatement(body, state.seed),
  });
}
