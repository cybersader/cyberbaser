import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createChangeSetProposal } from '@cyberbaser/proposal';
import { computePolicyRevision } from '../src/config.js';
import { createOwnerCommands } from '../src/core/commands.js';
import { createDeviceKeyRegistry } from '../src/core/device-keys.js';
import { loadDeviceKeyRegistry } from '../src/core/device-key-files.js';
import { createDevicePrincipalAdapter } from '../src/core/principal.js';
import { signedInputDigest, signedRequestBytes } from '../src/core/signed-request.js';
import { canonicalJson } from '../src/json.js';
import { runOwnerAlphaServer } from '../src/server.js';
import { sendSignedRequest, signedSocketAudience, SIGNED_REQUEST_MAX_BYTES, startSignedRequestSocket } from '../src/signed-request-socket.js';

const example = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
const keyCli = new URL('../bin/owner-alpha-keys.js', import.meta.url).pathname;
const refusal = { ok: false, code: 'proposal-submission-refused' };
const savedRevision = 'sha256:e740f0cf94abb24d230a56b7290a808ddad81d7836d8a5eefaa7aee3d83a2c22';

async function child(args) {
  const processResult = Bun.spawn([process.execPath, decodeURIComponent(keyCli), ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([processResult.exited, new Response(processResult.stdout).text(), new Response(processResult.stderr).text()]);
  return { code, stdout, stderr };
}

test('keys CLI writes a new private file and prints only the validated public registry entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'signed-keys-'));
  try {
    const key = path.join(root, 'agent.json');
    const generated = await child(['generate', 'Draft agent', '--agent', '--grant', 'propose', '--out', key]);
    expect(generated.code).toBe(0);
    expect(generated.stderr).toBe('');
    expect((await lstat(key)).mode & 0o7777).toBe(0o600);
    const privateData = JSON.parse(await readFile(key, 'utf8'));
    expect(generated.stdout).not.toContain(privateData.pkcs8);
    const entry = JSON.parse(generated.stdout);
    expect(entry).toMatchObject({ keyId: privateData.keyId, actor: { label: 'Draft agent', kind: 'agent' }, grants: ['propose'] });
    expect(Object.keys(entry).sort()).toEqual(['actor', 'grants', 'keyId', 'notAfter', 'notBefore', 'publicKey', 'revoked']);
    const registry = { ownerId: 'test-owner', entries: [entry] };
    expect(createDeviceKeyRegistry(registry).find(entry.keyId)).not.toBeNull();
    const file = path.join(root, 'registry.json');
    await writeFile(file, JSON.stringify(registry), { mode: 0o600 });
    expect(JSON.parse((await child(['list', file])).stdout)).toEqual([entry]);
    expect((await child(['generate', 'Other', '--owner-device', '--out', key])).code).toBe(1);
    expect(JSON.parse(await readFile(key, 'utf8'))).toEqual(privateData);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registry is optional, policy-stable, and refused before startup effects if unsafe or invalid', async () => {
  expect(computePolicyRevision(example)).toBe(savedRevision);
  expect(await loadDeviceKeyRegistry(example)).toBeNull();
  const root = await mkdtemp(path.join(os.tmpdir(), 'signed-registry-'));
  const checkout = path.join(root, 'checkout');
  const configFile = path.join(root, 'owner.json');
  const file = path.join(root, 'registry.json');
  const link = path.join(root, 'alias.json');
  const data = { ...example, repository: { ...example.repository, checkout } };
  let siteStarts = 0;
  const start = async (registryFile) => {
    const config = registryFile === undefined ? data : { ...data, deviceRegistryFile: registryFile };
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    expect(computePolicyRevision(config)).toBe(savedRevision);
    const runtime = await runOwnerAlphaServer({ configFile, projectRoot: root,
      rebuildSite: async () => { siteStarts += 1; }, loadPipeline: async () => ({ saveEdit: async () => {} }),
      startServers: () => ({ stop() {} }), recoverDecisions: async () => {}, recoverJobs: async () => [] });
    try { await runtime.recovery; } finally { await runtime.stop(true); }
  };
  try {
    await mkdir(checkout);
    const git = Bun.spawn(['git', 'init', '-q', root], { stdout: 'ignore', stderr: 'ignore' });
    expect(await git.exited).toBe(0);
    await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
    await start();
    await expect(start(file)).rejects.toMatchObject({ code: 'device-registry-invalid' });
    const entry = JSON.parse((await child(['generate', 'Agent', '--agent', '--grant', 'propose', '--out', path.join(root, 'key')])).stdout);
    const registry = { ownerId: data.owner.identity, entries: [entry] };
    await writeFile(file, JSON.stringify(registry), { mode: 0o600 });
    await start(file);
    await chmod(file, 0o644);
    await expect(start(file)).rejects.toMatchObject({ code: 'device-registry-invalid' });
    await chmod(file, 0o600);
    await symlink(file, link);
    await expect(start(link)).rejects.toMatchObject({ code: 'device-registry-invalid' });
    const inVault = path.join(checkout, 'keys.json');
    await writeFile(inVault, JSON.stringify(registry), { mode: 0o600 });
    await expect(start(inVault)).rejects.toMatchObject({ code: 'device-registry-invalid' });
    await writeFile(file, JSON.stringify({ ...registry, entries: [{ ...entry, grants: ['apply'] }] }));
    await expect(start(file)).rejects.toMatchObject({ code: 'device-registry-invalid' });
    expect(siteStarts).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function rawRequest(socketPath, wire, second = null) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }, () => {
      socket.write(wire);
      if (second !== null) void second.then((frame) => socket.write(frame));
    });
    let response = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('no reply')));
    socket.on('error', reject);
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
    socket.once('close', () => {
      try { resolve(JSON.parse(response)); } catch (error) { reject(error); }
    });
  });
}

function testSigner(socketPath) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const now = Date.now;
  const keyId = 'test-agent';
  const entry = { keyId, publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    actor: { kind: 'agent', id: 'agent', label: 'Synthetic agent' }, grants: ['propose'], notBefore: now() - 1000, notAfter: now() + 60000, revoked: false };
  const audience = signedSocketAudience(socketPath);
  const registry = createDeviceKeyRegistry({ ownerId: example.owner.identity, entries: [entry] });
  const verifier = createDevicePrincipalAdapter({ registry, audience });
  const input = createChangeSetProposal(Buffer.from('Draft text.\n'), {
    proposalId: 'request-fixture', source: { repository: example.repository.remote.url, revision: 'a'.repeat(40), path: 'note.md' },
    operations: [{ operationId: 'edit', start: 6, end: 10, expected: 'text', replacement: 'note' }],
    submission: { submittedAt: '2026-11-21T10:00:00Z', rationale: 'Test.', evidence: [], identityClaim: null },
  });
  return { verifier, issue(overrides = {}) {
    const claims = { audience, keyId, command: 'submitProposal', inputDigest: signedInputDigest(input),
      nonce: randomBytes(16).toString('base64'), issuedAt: now(), ...overrides };
    return { ...claims, input, signature: sign(null, signedRequestBytes(claims), privateKey).toString('base64') };
  } };
}

test('private signed socket accepts one verified command; all bad requests have the same reply', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'signed-wire-'));
  const socketPath = path.join(root, 'signed.sock');
  const { verifier, issue } = testSigner(socketPath);
  const config = { ...example, proposalReview: { ...example.proposalReview, enabled: true, socketPath: '/run/cyberbaser/review.sock' } };
  const receipt = { queueId: 'Q-00000000-0000-4000-8000-000000000001', acceptedAt: '2026-11-21T10:00:00Z', baseBound: true };
  const wire = (envelope) => `${canonicalJson(envelope)}\n`;
  let handoffs = 0;
  let delay = false;
  const inHandoff = Promise.withResolvers();
  const completeHandoff = Promise.withResolvers();
  const commands = createOwnerCommands({ config, devicePrincipalAdapter: verifier,
    proposalReview: { async submitSigned() { handoffs += 1; if (delay) { inHandoff.resolve(); await completeHandoff.promise; } return receipt; } } });
  let service;
  try {
    const args = { socketPath, commands, verifier };
    await chmod(root, 0o755);
    await expect(startSignedRequestSocket(args)).rejects.toMatchObject({ code: 'signed-socket-unsafe' });
    await chmod(root, 0o700);
    await mkdir(path.join(root, 'real'), { mode: 0o700 });
    await symlink(path.join(root, 'real'), path.join(root, 'alias'));
    await expect(startSignedRequestSocket({ ...args, socketPath: path.join(root, 'alias', 'signed.sock') })).rejects.toMatchObject({ code: 'signed-socket-unsafe' });
    const occupied = path.join(root, 'occupied.sock');
    await writeFile(occupied, 'keep');
    await expect(startSignedRequestSocket({ ...args, socketPath: occupied })).rejects.toMatchObject({ code: 'signed-socket-unsafe' });
    expect(await readFile(occupied, 'utf8')).toBe('keep');
    service = await startSignedRequestSocket(args);
    expect((await lstat(socketPath)).mode & 0o7777).toBe(0o600);
    const good = issue();
    expect(await sendSignedRequest(socketPath, good)).toEqual({ ok: true, receipt });
    expect(await sendSignedRequest(socketPath, good)).toEqual(refusal);
    expect(await sendSignedRequest(socketPath, issue({ audience: signedSocketAudience(path.join(root, 'other.sock')) }))).toEqual(refusal);
    expect(await sendSignedRequest(socketPath, { ...issue(), extra: true })).toEqual(refusal);
    expect(await sendSignedRequest(socketPath, issue({ command: 'listProposals' }))).toEqual(refusal);
    expect(await rawRequest(socketPath, `{"audience":"duplicate",${wire(issue()).slice(1)}`)).toEqual(refusal);
    expect(await rawRequest(socketPath, `${wire(issue())}${wire(issue())}`)).toEqual(refusal);
    expect(await rawRequest(socketPath, `${' '.repeat(SIGNED_REQUEST_MAX_BYTES)}\n`)).toEqual(refusal);
    expect(handoffs).toBe(1);
    delay = true;
    expect(await rawRequest(socketPath, wire(issue()), inHandoff.promise.then(() => wire(issue())))).toEqual(refusal);
    expect(handoffs).toBe(2); // Only the first frame was admitted; later bytes never run a command.
  } finally {
    completeHandoff.resolve();
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
