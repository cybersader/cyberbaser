// Signed publish on the publisher side: the owner-key list, enrollment,
// device changes, recovery, and the approval gate's every refusal.
// In-process, synthetic keys and repositories only.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { formatCode, verifyStatement } from '../../../packages/signed-intent/src/index.js';
import { OwnerAlphaError } from '../src/errors.js';
import { createApprovalGate } from '../src/publisher/approval-gate.js';
import { loopbackPeerUid, ownerRequest, startEnrollPage } from '../src/publisher/owner-control.js';
import { OWNER_FILES, createOwnerKeys, issueEnrollmentCode, resetOwners } from '../src/publisher/owner-keys.js';
import { startOwnerServices } from '../src/publisher/owner-services.js';
import { changeKeys, createDevice, enroll, recover, signPublish, verifyReceipt } from './signed-device.js';

const roots = [];
const closers = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const REMOTE = 'https://github.com/example/vault.git';

function gitRepo(root) {
  const dir = path.join(root, 'repo');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (args, input) => execFileSync('git', ['-C', dir, ...args], { env, input });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env });
  execFileSync('mkdir', ['-p', path.join(dir, 'notes')]);
  execFileSync('sh', ['-c', `printf 'old\\n' > '${dir}/notes/a.md'; printf 'keep\\n' > '${dir}/notes/b.md'`]);
  run(['add', '.']);
  run(['-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-q', '-m', 'seed']);
  const base = run(['rev-parse', 'HEAD']).toString().trim();
  execFileSync('sh', ['-c', `printf 'new\\n' > '${dir}/notes/a.md'`]);
  run(['add', '.']);
  run(['-c', 'user.name=Owner', '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', 'Edit notes/a.md']);
  const commit = run(['rev-parse', 'HEAD']).toString().trim();
  return { dir, base, commit, git: async (args) => run(args) };
}

async function setup({ mode = 'enforce' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oa-signed-'));
  roots.push(root);
  const ipc = path.join(root, 'ipc');
  await mkdir(ipc, { mode: 0o700 });
  await chmod(ipc, 0o700);
  const socketPath = path.join(ipc, 'publisher.sock');
  const lines = [];
  const services = await startOwnerServices({ owners: { directory: path.join(root, 'owners'), mode }, socketPath, uid: process.getuid(),
    log: (line) => lines.push(line) });
  closers.push(() => services.close());
  const { code, uri } = await services.ownerKeys.enrollmentDisplay();
  return { root, socketPath, services, lines, code, uri, repo: gitRepo(root) };
}

async function refusedWith(promise, code) {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

describe('first device', () => {
  test('the publisher keeps the one-time code out of its logs and the device enrolls with it once', async () => {
    const fx = await setup();
    expect(fx.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/u);
    expect(fx.uri).toContain(`publisher=${fx.services.ownerKeys.publisher}&`);
    expect(fx.lines.join("\n")).not.toContain(fx.code);
    expect(fx.lines.join("\n")).not.toContain(fx.uri);
    const status = await ownerRequest({ socketPath: fx.socketPath, op: 'status' });
    expect(status).toMatchObject({ devices: 0, enrollmentOpen: true });
    expect(JSON.stringify(status)).not.toContain(fx.code);
    const phone = createDevice();
    const result = await enroll(phone, { socketPath: fx.socketPath, code: fx.code, uri: fx.uri });
    expect(result.keyId).toBe('phone');
    expect(phone.publisher).toBe(fx.services.ownerKeys.publisher);
    // The window is closed: the same code cannot enroll a second key.
    await refusedWith(enroll(createDevice({ keyId: 'other' }), { socketPath: fx.socketPath, code: fx.code }), 'owner-enrollment-closed');
    // The list is signed by the publisher.
    const list = await ownerRequest({ socketPath: fx.socketPath, op: 'keys' });
    expect(verifyStatement(list.body, list.signature, phone.publisher)).toBe(true);
    expect(list.body.keys.map((key) => key.keyId)).toEqual(['phone']);
    // State files are the publisher's own, owner-only.
    for (const name of [OWNER_FILES.key, OWNER_FILES.owners]) expect((await stat(path.join(fx.root, 'owners', name))).mode & 0o777).toBe(0o600);
  });

  test('a node-substituted code is refused, and the code is not burned by it', async () => {
    const fx = await setup();
    const forged = formatCode(randomBytes(20));
    await refusedWith(enroll(createDevice({ keyId: 'node-key' }), { socketPath: fx.socketPath, code: forged }), 'owner-enrollment-refused');
    expect(fx.lines.some((line) => line.includes('wrong setup code'))).toBe(true);
    await enroll(createDevice(), { socketPath: fx.socketPath, code: fx.code });
  });

  test('a device rejects an answer from something that does not hold its code', async () => {
    const fx = await setup();
    // The node shows its own code: enrolling with it fails at the publisher,
    // so the device never pins anything.
    const phone = createDevice();
    await refusedWith(enroll(phone, { socketPath: fx.socketPath, code: formatCode(Buffer.alloc(20, 1)) }), 'owner-enrollment-refused');
    expect(phone.publisher).toBeNull();
    // A scanned code naming another publisher key is refused by the device itself.
    await expect(enroll(phone, { socketPath: fx.socketPath, code: fx.code, uri: `obsidian://cyberbaser-enrol?publisher=${'b'.repeat(64)}&code=x` }))
      .rejects.toThrow('publisher key differs');
  });

  test('administrator commands: a fresh code and a one-time recovery code; reset removes every device', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oa-signed-admin-'));
    roots.push(root);
    const directory = path.join(root, 'owners');
    const issued = await issueEnrollmentCode({ directory });
    expect(issued.recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/u);
    const again = await issueEnrollmentCode({ directory });
    expect(again.recoveryCode).toBeNull();
    expect(again.code).not.toBe(issued.code);
    const stored = await readFile(path.join(directory, OWNER_FILES.owners), 'utf8');
    expect(stored).not.toContain(issued.recoveryCode);
    const ownerKeys = await createOwnerKeys({ directory });
    const reset = await resetOwners({ directory });
    expect(reset.recoveryCode).not.toBeNull();
    expect((await ownerKeys.status()).recovery).toBe(true);
  });
});

describe('device list changes need an owner signature', () => {
  test('add, revoke, last key kept, unknown signer refused', async () => {
    const fx = await setup();
    const phone = createDevice();
    await enroll(phone, { socketPath: fx.socketPath, code: fx.code });
    const laptop = createDevice({ keyId: 'laptop', label: 'Work laptop' });
    const stranger = createDevice({ keyId: 'stranger' });
    await refusedWith(changeKeys(stranger, { socketPath: fx.socketPath, kind: 'key-add', subject: { key: laptop.key } }), 'owner-key-refused');
    await changeKeys(phone, { socketPath: fx.socketPath, kind: 'key-add', subject: { key: laptop.key } });
    await refusedWith(changeKeys(laptop, { socketPath: fx.socketPath, kind: 'key-add', subject: { key: laptop.key } }), 'owner-key-refused');
    await changeKeys(laptop, { socketPath: fx.socketPath, kind: 'key-revoke', subject: { keyId: 'phone' } });
    await refusedWith(changeKeys(phone, { socketPath: fx.socketPath, kind: 'key-revoke', subject: { keyId: 'laptop' } }), 'owner-key-refused');
    await refusedWith(changeKeys(laptop, { socketPath: fx.socketPath, kind: 'key-revoke', subject: { keyId: 'laptop' } }), 'owner-key-refused');
  });

  test('the recovery code replaces every device, once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oa-signed-rec-'));
    roots.push(root);
    const directory = path.join(root, 'owners');
    const { code, recoveryCode } = await issueEnrollmentCode({ directory });
    const ipc = path.join(root, 'ipc');
    await mkdir(ipc, { mode: 0o700 });
    const socketPath = path.join(ipc, 'publisher.sock');
    const services = await startOwnerServices({ owners: { directory }, socketPath, uid: process.getuid(), log: () => {} });
    closers.push(() => services.close());
    const phone = createDevice();
    await enroll(phone, { socketPath, code });
    const fresh = createDevice({ keyId: 'new-phone' });
    await refusedWith(recover(formatCode(randomBytes(15)), fresh, { socketPath }), 'owner-key-refused');
    await recover(recoveryCode, fresh, { socketPath });
    const list = await ownerRequest({ socketPath, op: 'keys' });
    expect(list.body.keys.filter((key) => key.revokedAt === null).map((key) => key.keyId)).toEqual(['new-phone']);
    expect(list.body.recovery).toBe(false);
    await refusedWith(recover(recoveryCode, createDevice({ keyId: 'again' }), { socketPath }), 'owner-key-refused');
  });
});

describe('the approval gate before a push', () => {
  async function enrolled(mode = 'enforce') {
    const fx = await setup({ mode });
    const phone = createDevice();
    await enroll(phone, { socketPath: fx.socketPath, code: fx.code });
    const sign = (options = {}) => signPublish(phone, { socketPath: fx.socketPath, repository: fx.repo.dir, commit: fx.repo.commit,
      remote: REMOTE, branch: 'main', ...options });
    const authorize = async (record, target = { remote: REMOTE, branch: 'main' }) => {
      const authorization = await fx.services.gate.authorize(record, target);
      await authorization.verifyCommit(fx.repo.git, fx.repo.commit);
      return authorization;
    };
    return { ...fx, phone, sign, authorize };
  }

  test('a valid approval passes once and yields a receipt the device can verify', async () => {
    const fx = await enrolled();
    const record = await fx.sign();
    const authorization = await fx.authorize(record);
    const receipt = authorization.receipt({ status: 'pushed', commit: fx.repo.commit, remoteRef: fx.repo.commit });
    expect(verifyReceipt(fx.phone, receipt)).toBe(true);
    expect(receipt.body).toMatchObject({ kind: 'pushed', keyId: 'phone', commit: fx.repo.commit, remoteHeadBefore: fx.repo.base });
    await refusedWith(fx.authorize(record), 'owner-approval-expired');
  });

  test('every refusal fails closed with a plain reason', async () => {
    const fx = await enrolled();
    await refusedWith(fx.authorize(null), 'owner-approval-missing');
    const expired = await fx.sign({ mutate: (intent) => ({ ...intent, issuedAt: intent.issuedAt - 20 * 60_000, expiresAt: intent.issuedAt - 6 * 60_000 }) });
    await refusedWith(fx.authorize(expired), 'owner-approval-expired');
    const unissued = await fx.sign({ mutate: (intent) => ({ ...intent, nonce: Buffer.alloc(32, 7).toString('base64url') }) });
    await refusedWith(fx.authorize(unissued), 'owner-approval-expired');
    const stranger = createDevice({ keyId: 'phone' });
    stranger.publisher = fx.phone.publisher;
    await refusedWith(fx.authorize(await signPublish(stranger, { socketPath: fx.socketPath, repository: fx.repo.dir, commit: fx.repo.commit, remote: REMOTE, branch: 'main' })), 'owner-approval-invalid');
    const unknown = createDevice({ keyId: 'node-agent' });
    await refusedWith(fx.authorize(await signPublish(unknown, { socketPath: fx.socketPath, repository: fx.repo.dir, commit: fx.repo.commit, remote: REMOTE, branch: 'main' })), 'owner-approval-invalid');
    const otherPublisher = await fx.sign({ mutate: (intent) => ({ ...intent, publisher: 'e'.repeat(64) }) });
    await refusedWith(fx.authorize(otherPublisher), 'owner-approval-invalid');
    const message = 'owner-approval-mismatch';
    await refusedWith(fx.authorize(await fx.sign(), { remote: 'https://github.com/example/other.git', branch: 'main' }), message);
    await refusedWith(fx.authorize(await fx.sign(), { remote: REMOTE, branch: 'release' }), message);
    for (const mutate of [
      (intent) => ({ ...intent, base: '1'.repeat(40) }),
      (intent) => ({ ...intent, commit: { ...intent.commit, message: 'Something else\n' } }),
      (intent) => ({ ...intent, commit: { ...intent.commit, author: { ...intent.commit.author, name: 'Mallory' } } }),
      (intent) => ({ ...intent, changes: [{ ...intent.changes[0], after: { mode: '100644', sha256: 'f'.repeat(64) } }] }),
      (intent) => ({ ...intent, changes: [{ ...intent.changes[0], path: 'notes/b.md' }] }),
    ]) {
      const error = await refusedWith(fx.authorize(await fx.sign({ mutate })), message);
      expect(error.message).toContain('does not match what your device approved');
    }
  });

  test('a revoked device can no longer publish', async () => {
    const fx = await enrolled();
    const laptop = createDevice({ keyId: 'laptop' });
    await changeKeys(fx.phone, { socketPath: fx.socketPath, kind: 'key-add', subject: { key: laptop.key } });
    await changeKeys(laptop, { socketPath: fx.socketPath, kind: 'key-revoke', subject: { keyId: 'phone' } });
    await refusedWith(fx.authorize(await fx.sign()), 'owner-approval-invalid');
  });

  test('report mode logs every problem and lets the push go ahead', async () => {
    const fx = await enrolled('report');
    const authorization = await fx.authorize(null);
    expect(authorization.receipt({ status: 'pushed', commit: fx.repo.commit, remoteRef: fx.repo.commit })).toBeNull();
    await fx.authorize(await fx.sign({ mutate: (intent) => ({ ...intent, commit: { ...intent.commit, message: 'x\n' } }) }));
    expect(fx.lines.filter((line) => line.startsWith('signed publish (report only)'))).toEqual([
      'signed publish (report only): approval: owner-approval-missing (missing)',
      'signed publish (report only): commit: commit-message-mismatch',
    ]);
  });

  test('a key list the node writes anywhere is never read', async () => {
    const fx = await enrolled();
    const forged = createDevice({ keyId: 'phone' });
    // The node can write its own config and job store; the publisher reads
    // owner keys only from its own directory, given at start.
    await writeFile(path.join(fx.root, 'owner-alpha.json'), JSON.stringify({ ownerKeys: [forged.key], owners: { keys: [forged.key] } }));
    await writeFile(path.join(fx.root, 'owners.json'), JSON.stringify({ v: 1, publisher: fx.phone.publisher, keys: [{ ...forged.key, may: ['publish'], revokedAt: null }], recovery: null, history: [] }));
    forged.publisher = fx.phone.publisher;
    const record = await signPublish(forged, { socketPath: fx.socketPath, repository: fx.repo.dir, commit: fx.repo.commit, remote: REMOTE, branch: 'main' });
    await refusedWith(fx.authorize(record), 'owner-approval-invalid');
  });

  test('the gate needs a key list', () => {
    expect(() => createApprovalGate({ ownerKeys: null })).toThrow();
    expect(() => createApprovalGate({ ownerKeys: { admitPublish() {} }, mode: 'off' })).toThrow();
  });
});

describe('the first-device page', () => {
  function get(port, { pathName = '/enroll', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: pathName, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
      });
      request.on('error', reject);
      request.end();
    });
  }
  async function page(authorizedUids) {
    const fx = await setup();
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = await startEnrollPage({ ownerKeys: fx.services.ownerKeys, port, authorizedUids });
    closers.push(() => server.close());
    return { ...fx, port };
  }

  test('shows the code to a browser, never to a script or the node account', async () => {
    const fx = await page([process.getuid()]);
    const shown = await get(fx.port);
    expect(shown.status).toBe(200);
    expect(shown.body).toContain(fx.code);
    expect(shown.headers['access-control-allow-origin']).toBeUndefined();
    expect((await get(fx.port, { headers: { Origin: 'http://127.0.0.1:4317' } })).status).toBe(403);
    expect((await get(fx.port, { headers: { 'Sec-Fetch-Mode': 'cors' } })).status).toBe(403);
    expect((await get(fx.port, { headers: { Host: 'attacker.example' } })).status).toBe(421);
    expect((await get(fx.port, { pathName: '/enroll?x=1' })).status).toBe(404);
    expect((await get(fx.port, { pathName: '/enroll.svg' })).body).toStartWith('<svg');
    // After enrollment the page shows no code.
    await enroll(createDevice(), { socketPath: fx.socketPath, code: fx.code });
    const after = await get(fx.port);
    expect(after.status).toBe(410);
    expect(after.body).not.toContain(fx.code);
  });

  test('an otherwise valid connection from any unlisted account is refused', async () => {
    const fx = await page([process.getuid() + 1]);
    const refused = await get(fx.port);
    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain(fx.code);
  });

  const tuple = { clientAddress: '127.0.0.1', clientPort: 0x9c40, serverAddress: '127.0.0.1', serverPort: 0x10e1 };
  const kernelRow = (local, remote, state, uid) => `   0: ${local} ${remote} ${state} 0000:0000 00:0000 0000 ${uid} 0 1\n`;
  const v4 = (uid, state = '01') => kernelRow('0100007F:9C40', '0100007F:10E1', state, uid);
  const mapped = (uid) => kernelRow('0000000000000000FFFF00000100007F:9C40', '0000000000000000FFFF00000100007F:10E1', '01', uid);
  const native = (uid) => kernelRow('00000000000000000000000001000000:9C40', '00000000000000000000000001000000:10E1', '01', uid);
  const procfs = (tcp, tcp6 = '', overflow = '65534') => async (file) => file.endsWith('overflowuid') ? overflow :
    `sl local_address rem_address st queues tr retransmits uid\n${file.endsWith('tcp6') ? tcp6 : tcp}`;

  test('peer lookup ignores TIME_WAIT and same-port decoys and returns the actual UID', async () => {
    const decoy = kernelRow('0300007F:9C40', '0200007F:10E1', '06', 0);
    const other = kernelRow('0300007F:9C40', '0200007F:10E1', '01', 501);
    const read = procfs(decoy + v4(0, '06') + other + v4(977));
    expect(await loopbackPeerUid({ ...tuple, read })).toBe(977);
    expect(await loopbackPeerUid({ ...tuple, clientAddress: '127.0.0.2', read })).toBeNull();
    expect(await loopbackPeerUid({ ...tuple, read: procfs(decoy + other) })).toBeNull();
  });

  test('peer lookup supports IPv6 and mapped IPv4 and refuses ambiguous or unknown UIDs', async () => {
    expect(await loopbackPeerUid({ ...tuple, clientAddress: '::1', serverAddress: '0::1', read: procfs('', native(977)) })).toBe(977);
    expect(await loopbackPeerUid({ ...tuple, clientAddress: '::ffff:127.0.0.1', read: procfs('', mapped(977)) })).toBe(977);
    for (const rows of [[v4(977) + v4(977)], [v4(977), mapped(501)], [v4(65534)], [v4(4294967295)], [v4('bad')], [v4(501), '', '501']]) {
      expect(await loopbackPeerUid({ ...tuple, read: procfs(...rows) })).toBeNull();
    }
    expect(await loopbackPeerUid({ ...tuple, read: async () => { throw new Error('unavailable'); } })).toBeNull();
  });
});
