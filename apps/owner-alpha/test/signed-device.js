// A stand-in owner device for tests: what the Obsidian plugin will do, with a
// plain Ed25519 key. It talks to the publisher only through the owner control
// socket (as the node would relay it) and checks the publisher's answers.
import { randomBytes, sign } from 'node:crypto';
import {
  b64url, ed25519FromSeed, ed25519Provider, enrollConfirm, enrollProof, intentDigest, intentDigestHex, macEqual, parseCode,
  recoveryKeyFromCode, verifyStatement,
} from '../../../packages/signed-intent/src/index.js';
import { ownerRequest } from '../src/publisher/owner-control.js';
import { describePublish, gitIn, publishIntent } from '../src/signed-publish.js';

export function createDevice({ keyId = 'phone', label = 'Phone', seed = randomBytes(32) } = {}) {
  const pair = ed25519FromSeed(seed);
  const key = { keyId, type: 'ed25519', publicKey: b64url(pair.publicKey), label };
  const approve = (intent) => ({ type: 'ed25519', signature: b64url(sign(null, ed25519Provider.message(intentDigest(intent)), pair.privateKey)) });
  return { key, keyId, approve, seed, publisher: null };
}

function envelope(challenge, kind, keyId) {
  return { v: 1, kind, publisher: challenge.publisher, keyId, nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt };
}

/** Enroll with the code the publisher showed. Pins the publisher key only after it proves it holds the code. */
export async function enroll(device, { socketPath, code, uri = null }) {
  const secret = parseCode(code, 20);
  const challenge = await ownerRequest({ socketPath, op: 'challenge' });
  if (uri !== null && !uri.includes(`publisher=${challenge.publisher}&`)) throw new Error('publisher key differs from the scanned code');
  const intent = { ...envelope(challenge, 'enroll', device.keyId),
    subject: { key: device.key, proof: enrollProof(secret, challenge.publisher, device.key) } };
  const result = await ownerRequest({ socketPath, op: 'enroll', record: { intent, approval: device.approve(intent) } });
  if (!macEqual(result.confirm, enrollConfirm(secret, challenge.publisher, intentDigestHex(intent)))) {
    throw new Error('the answer did not come from the publisher that showed the code');
  }
  device.publisher = challenge.publisher;
  return result;
}

export async function changeKeys(device, { socketPath, kind, subject }) {
  const challenge = await ownerRequest({ socketPath, op: 'challenge' });
  const intent = { ...envelope(challenge, kind, device.keyId), subject };
  return ownerRequest({ socketPath, op: 'change', record: { intent, approval: device.approve(intent) } });
}

export async function recover(code, newDevice, { socketPath, recoveryKey = null }) {
  const challenge = await ownerRequest({ socketPath, op: 'challenge' });
  const recovery = recoveryKeyFromCode(code, challenge.publisher);
  const intent = { ...envelope(challenge, 'recovery-reset', 'recovery'), subject: { key: newDevice.key, recoveryKey } };
  const approval = { type: 'ed25519', signature: b64url(sign(null, ed25519Provider.message(intentDigest(intent)), recovery.privateKey)) };
  return ownerRequest({ socketPath, op: 'change', record: { intent, approval } });
}

/**
 * Sign a publish for one commit. A real device hashes the bytes it shows the
 * owner; this stand-in reads them from the given repository. mutate(intent)
 * lets a test sign something other than the commit.
 */
export async function signPublish(device, { socketPath, repository, commit, remote, branch, mutate = (intent) => intent }) {
  const description = await describePublish({ git: gitIn(repository), commit, remote, branch });
  const challenge = await ownerRequest({ socketPath, op: 'challenge' });
  if (device.publisher !== null && challenge.publisher !== device.publisher) throw new Error('a different publisher answered');
  const intent = mutate(publishIntent({ challenge, keyId: device.keyId, description }));
  return { intent, approval: device.approve(intent) };
}

export function verifyReceipt(device, receipt) {
  return device.publisher !== null && verifyStatement(receipt.body, receipt.signature, device.publisher);
}
