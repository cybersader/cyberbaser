import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomBytes, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PROVIDERS, admitApproval, b64url, checkCommit, createNonceBook, ed25519FromSeed, ed25519Provider, enrollConfirm, enrollProof,
  formatCode, intentBytes, intentDigest, intentDigestHex, macEqual, parseCode, receiptBody, recoveryKeyFromCode, sha256Hex,
  signStatement, validateIntent, verifyStatement,
} from '../src/index.js';
import { intentBytes as pureIntentBytes } from '../src/intent.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));

describe('conformance vectors', () => {
  for (const [name, entry] of Object.entries(vectors.intents)) {
    test(`canonical bytes and digest: ${name}`, () => {
      expect(Buffer.from(intentBytes(entry.intent)).toString('utf8')).toBe(entry.bytesUtf8);
      expect(intentDigestHex(entry.intent)).toBe(entry.digestHex);
    });
  }
  for (const entry of vectors.invalidIntents) {
    test(`refused: ${entry.name}`, () => { expect(() => validateIntent(entry.intent)).toThrow(); });
  }
  for (const entry of vectors.approvals) {
    test(`approval: ${entry.name}`, () => {
      const result = PROVIDERS.get(entry.key.type).verify({ digest: Buffer.from(entry.digest, 'hex'), approval: entry.approval, key: entry.key });
      expect(result.ok ? 'ok' : result.code).toBe(entry.expect);
    });
  }
  test('enrollment proof and confirmation', () => {
    const secret = Buffer.from(vectors.enrollment.secretHex, 'hex');
    expect(formatCode(secret)).toBe(vectors.enrollment.code);
    expect(parseCode(vectors.enrollment.code.toLowerCase(), 20).equals(secret)).toBe(true);
    expect(enrollProof(secret, vectors.publisher, vectors.enrollment.key)).toBe(vectors.enrollment.proof);
    expect(enrollConfirm(secret, vectors.publisher, vectors.intents.enroll.digestHex)).toBe(vectors.enrollment.confirm);
    expect(vectors.intents.enroll.intent.subject.proof).toBe(vectors.enrollment.proof);
  });
  test('recovery code derives the same public key, bound to the publisher', () => {
    expect(recoveryKeyFromCode(vectors.recovery.code, vectors.publisher).publicKey).toBe(vectors.recovery.publicKey);
    expect(recoveryKeyFromCode(vectors.recovery.code, 'b'.repeat(64)).publicKey).not.toBe(vectors.recovery.publicKey);
    expect(recoveryKeyFromCode('not a code', vectors.publisher)).toBeNull();
  });
  test('the pure entry point gives the same bytes without node:crypto', () => {
    expect(Buffer.from(pureIntentBytes(vectors.intents.publish.intent)).toString('utf8')).toBe(vectors.intents.publish.bytesUtf8);
  });
});

describe('codes and statements', () => {
  test('codes round-trip, tolerate dashes, case and look-alikes, refuse wrong length', () => {
    for (let i = 0; i < 50; i += 1) {
      const bytes = randomBytes(15);
      const code = formatCode(bytes);
      expect(parseCode(code, 15).equals(bytes)).toBe(true);
      expect(parseCode(code.replaceAll('-', ' ').toLowerCase().replaceAll('1', 'l').replaceAll('0', 'o'), 15).equals(bytes)).toBe(true);
    }
    expect(parseCode('ABCD', 15)).toBeNull();
    expect(macEqual('x', 'y')).toBe(false);
  });
  test('publisher statements verify only under the publisher key and exact body', () => {
    const seed = Buffer.alloc(32, 4);
    const publisher = ed25519FromSeed(seed).publicKey.toString('hex');
    const body = receiptBody({ intentDigest: 'e'.repeat(64), keyId: 'k', provider: 'ed25519', commit: 'f'.repeat(40),
      remote: 'https://github.com/a/b.git', branch: 'main', remoteHeadBefore: '1'.repeat(40), remoteHeadAfter: 'f'.repeat(40), at: 1 });
    const signature = signStatement(body, seed);
    expect(verifyStatement(body, signature, publisher)).toBe(true);
    expect(verifyStatement({ ...body, at: 2 }, signature, publisher)).toBe(false);
    expect(verifyStatement(body, signature, 'a'.repeat(64))).toBe(false);
  });
});

// One owner key, a nonce book, and a real Git repository standing in for the
// publisher's imported objects.
const owner = ed25519FromSeed(Buffer.alloc(32, 9));
const PUBLISHER = 'd'.repeat(64);
const ownerEntry = { type: 'ed25519', publicKey: b64url(owner.publicKey), may: ['publish', 'key-add', 'key-revoke'], revoked: false };
const approve = (intent, key = owner) => ({ type: 'ed25519', signature: b64url(sign(null, ed25519Provider.message(intentDigest(intent)), key.privateKey)) });
const AUTHOR = { name: 'Owner', email: 'owner@example.invalid', time: 1_800_000_000, tz: '+0000' };

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'signed-intent-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (args, input) => execFileSync('git', ['-C', dir, ...args], { env, input });
  run(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, 'a.md'), 'hello\n');
  writeFileSync(path.join(dir, 'b.md'), 'other\n');
  run(['add', '.']);
  run(['-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-q', '-m', 'seed']);
  const base = run(['rev-parse', 'HEAD']).toString().trim();
  return { dir, run, base, git: async (args) => run(args) };
}

function commitWith(r, edit, { message = 'Edit a.md\n', extraHeader = '', parent = r.base, author = 'Owner <owner@example.invalid> 1800000000 +0000' } = {}) {
  r.run(['reset', '-q', '--hard', r.base]);
  r.run(['clean', '-fdq']);
  edit(r.dir);
  r.run(['add', '-A']);
  const tree = r.run(['write-tree']).toString().trim();
  const body = `tree ${tree}\nparent ${parent}\nauthor ${author}\ncommitter Owner <owner@example.invalid> 1800000000 +0000\n${extraHeader}\n${message}`;
  return r.run(['hash-object', '-t', 'commit', '-w', '--stdin'], Buffer.from(body)).toString().trim();
}

const write = (name, bytes) => (dir) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), bytes);
};
const both = (...edits) => (dir) => edits.forEach((edit) => edit(dir));

function publishIntent(r, nonce, now, changes = [{ path: 'a.md', before: { mode: '100644', sha256: sha256Hex('hello\n') }, after: { mode: '100644', sha256: sha256Hex('hello world\n') } }]) {
  return {
    v: 1, kind: 'publish', publisher: PUBLISHER, keyId: 'laptop', nonce, issuedAt: now, expiresAt: now + 600_000,
    target: { remote: 'https://github.com/example/vault.git', branch: 'main' }, base: r.base,
    commit: { author: AUTHOR, committer: AUTHOR, message: 'Edit a.md\n' }, changes,
  };
}

describe('admitApproval', () => {
  const now = 1_800_000_000_000;
  test('valid once; the nonce is spent; every envelope refusal is named', () => {
    const nonces = createNonceBook({ random: randomBytes });
    const roster = new Map([['laptop', ownerEntry]]);
    const { nonce } = nonces.issue(now);
    const intent = publishIntent({ base: '1'.repeat(40) }, nonce, now);
    const approval = approve(intent);
    const base = { intent, approval, roster, publisherId: PUBLISHER, nonces, now };
    expect(admitApproval({ ...base, approval: { type: 'ed25519', signature: b64url(Buffer.alloc(64)) } }).code).toBe('bad-signature');
    expect(admitApproval({ ...base, publisherId: 'e'.repeat(64) }).code).toBe('wrong-publisher');
    expect(admitApproval({ ...base, now: now + 600_000 }).code).toBe('expired');
    expect(admitApproval({ ...base, now: now - 120_000 }).code).toBe('not-yet-valid');
    expect(admitApproval({ ...base, roster: new Map() }).code).toBe('unknown-key');
    expect(admitApproval({ ...base, roster: new Map([['laptop', { ...ownerEntry, revoked: true }]]) }).code).toBe('revoked-key');
    expect(admitApproval({ ...base, roster: new Map([['laptop', { ...ownerEntry, may: ['key-add'] }]]) }).code).toBe('key-not-allowed');
    expect(admitApproval({ ...base, approval: { ...approval, type: 'webauthn' } }).code).toBe('wrong-provider');
    expect(admitApproval({ ...base, intent: { ...intent, extra: 1 } }).code).toBe('intent-invalid');
    // None of the refusals above burned the nonce.
    expect(admitApproval(base).ok).toBe(true);
    expect(admitApproval(base).code).toBe('nonce-unknown-or-used');
  });
  test('a nonce this publisher never issued is refused after a valid signature', () => {
    const nonces = createNonceBook({ random: randomBytes });
    const intent = publishIntent({ base: '1'.repeat(40) }, b64url(Buffer.alloc(32, 3)), now);
    expect(admitApproval({ intent, approval: approve(intent), roster: new Map([['laptop', ownerEntry]]), publisherId: PUBLISHER, nonces, now }).code)
      .toBe('nonce-unknown-or-used');
  });
  test('the nonce book is bounded and expires entries', () => {
    const nonces = createNonceBook({ random: randomBytes, max: 2, ttlMs: 1000 });
    expect(nonces.issue(0)).not.toBeNull();
    expect(nonces.issue(0)).not.toBeNull();
    expect(nonces.issue(0)).toBeNull();
    expect(nonces.issue(1000)).not.toBeNull();
  });
});

describe('checkCommit from Git objects alone', () => {
  test('exact match passes; every divergence is named', async () => {
    const r = repo();
    try {
      const intent = publishIntent(r, b64url(Buffer.alloc(32, 2)), 1_800_000_000_000);
      const check = async (commit) => (await checkCommit(r.git, intent, commit)).code ?? 'ok';
      expect(await check(commitWith(r, write('a.md', 'hello world\n')))).toBe('ok');
      expect(await check(commitWith(r, write('a.md', 'hello world!\n')))).toBe('content-mismatch');
      expect(await check(commitWith(r, both(write('a.md', 'hello world\n'), write('b.md', 'sneaky\n'))))).toBe('unsigned-path-changed');
      expect(await check(commitWith(r, both(write('a.md', 'hello world\n'), write('.github/workflows/x.yml', 'on: push\n'))))).toBe('unsigned-path-changed');
      expect(await check(commitWith(r, write('a.md', 'hello world\n'), { message: 'Other\n' }))).toBe('commit-message-mismatch');
      expect(await check(commitWith(r, write('a.md', 'hello world\n'), { message: 'Edit a.md\n\n' }))).toBe('commit-message-mismatch');
      expect(await check(commitWith(r, write('a.md', 'hello world\n'), { extraHeader: 'encoding latin1\n' }))).toBe('commit-header-mismatch');
      expect(await check(commitWith(r, write('a.md', 'hello world\n'), { author: 'Mallory <m@example.invalid> 1800000000 +0000' }))).toBe('commit-header-mismatch');
      expect(await check(commitWith(r, write('a.md', 'hello world\n'), { parent: r.run(['hash-object', '-t', 'commit', '-w', '--stdin'], Buffer.from(`tree ${r.run(['write-tree']).toString().trim()}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nx\n`)).toString().trim() }))).toBe('commit-header-mismatch');
      expect(await check(commitWith(r, write('a.md', 'hello\n')))).toBe('signed-change-missing');
      expect(await check(commitWith(r, (dir) => { rmSync(path.join(dir, 'a.md')); }))).toBe('change-mismatch');
      expect(await check(commitWith(r, (dir) => { rmSync(path.join(dir, 'a.md')); symlinkSync('b.md', path.join(dir, 'a.md')); }))).toBe('mode-mismatch');
      expect(await check('0'.repeat(40))).toBe('commit-unreadable');
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  test('additions and deletions as signed', async () => {
    const r = repo();
    try {
      const intent = publishIntent(r, b64url(Buffer.alloc(32, 2)), 1_800_000_000_000, [
        { path: 'b.md', before: { mode: '100644', sha256: sha256Hex('other\n') }, after: null },
        { path: 'new/c.md', before: null, after: { mode: '100644', sha256: sha256Hex('new\n') } },
      ]);
      const ok = commitWith(r, both((dir) => rmSync(path.join(dir, 'b.md')), write('new/c.md', 'new\n')));
      expect((await checkCommit(r.git, intent, ok)).ok).toBe(true);
      const kept = commitWith(r, write('new/c.md', 'new\n'));
      expect((await checkCommit(r.git, intent, kept)).code).toBe('signed-change-missing');
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
});
