#!/usr/bin/env bun
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createDeviceKeyRegistry } from '../src/core/device-keys.js';
import { readEnrollment } from '../src/core/device-key-files.js';

export async function generateKey({ label, kind, grants, file }) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = `key-${randomUUID()}`;
  const notBefore = Date.now();
  const entry = {
    keyId, publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    actor: { kind, id: keyId, label }, grants, notBefore, notAfter: notBefore + 365 * 86400_000, revoked: false,
  };
  createDeviceKeyRegistry({ ownerId: 'local-owner', entries: [entry] });
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify({ keyId, pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') })}\n`);
  } finally { await handle.close(); }
  return entry;
}

async function main([command, label, ...args]) {
  if (command === 'list' && label && args.length === 0) {
    return (await readEnrollment(label)).input.entries;
  }
  if (command !== 'generate' || !label) throw new Error('usage');
  let kind; let file; const grants = [];
  while (args.length) {
    const option = args.shift();
    if (!kind && ['--agent', '--owner-device'].includes(option)) kind = option.slice(2);
    else if (!file && option === '--out' && args[0] && !args[0].startsWith('--')) file = args.shift();
    else if (option === '--grant' && args[0] === 'propose' && grants.length === 0) grants.push(args.shift());
    else throw new Error('usage');
  }
  if (!kind || !file) throw new Error('usage');
  return generateKey({ label, kind, grants, file });
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch {
    console.error('Key operation refused. Use generate <label> --agent|--owner-device [--grant propose] --out <new-private-file>, or list <private-registry-file>.');
    process.exitCode = 1;
  }
}
