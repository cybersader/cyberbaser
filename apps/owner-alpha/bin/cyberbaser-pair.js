#!/usr/bin/env bun
// Pair this agent with an owner node: `cyberbaser-pair <code> [--state <new-file>]`.
// Generates the agent's own Ed25519 device key and Iroh identity, proves it
// holds the pairing code without sending it, prints the four words the owner
// must see on their screen, and waits for the owner's Confirm. Only then is the
// saved state written (owner-only, create-once).
import { generateKeyPairSync, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecretKey } from '@number0/iroh';
import { isKeyId, plainData } from '../src/core/device-keys.js';
import { pairingMac, pairingTranscript, pairingWords, parsePairingCode, PAIRING_REFUSAL } from '../src/core/pairing.js';
import { connectToNode, exchange, PAIR_ALPN } from '../src/iroh-carrier.js';

export function defaultStateFile() {
  const base = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config');
  return path.join(base, 'cyberbaser', 'agent.json');
}

async function writeState(file, state) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

export async function pairAgent({ code, stateFile, onWords = () => {} }) {
  const parsed = parsePairingCode(code);
  if (!parsed) throw new Error('invalid-pairing-code');
  // Refuse before connecting if the state file already exists.
  await open(stateFile, constants.O_RDONLY).then((handle) => handle.close().then(() => { throw new Error('state-file-exists'); }),
    (error) => { if (error?.code !== 'ENOENT') throw error; });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const devicePublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const irohSecret = Buffer.from(SecretKey.generate().toBytes());
  let session;
  try {
    session = await connectToNode({ secretKey: irohSecret, ticket: parsed.ticket, alpn: PAIR_ALPN });
    const transcript = pairingTranscript({ nodeId: session.nodeId, clientEndpointId: session.clientEndpointId,
      enrollmentId: parsed.enrollmentId, devicePublicKey });
    const words = pairingWords(transcript);
    const reply = await exchange(session.connection, { enrollmentId: parsed.enrollmentId, devicePublicKey,
      mac: pairingMac(parsed.secret, transcript), signature: sign(null, transcript, privateKey).toString('base64') });
    parsed.secret.fill(0);
    if (reply?.ok !== true) throw new Error(PAIRING_REFUSAL);
    onWords(words);
    const outcome = plainData(await exchange(session.connection, { type: 'await' }, 7 * 60_000), ['ok', 'keyId', 'audience']);
    if (outcome?.ok !== true || !isKeyId(outcome.keyId)) throw new Error(PAIRING_REFUSAL);
    await writeState(stateFile, { keyId: outcome.keyId, pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      iroh: { secretKey: irohSecret.toString('base64'), ticket: parsed.ticket } });
    return { keyId: outcome.keyId, words };
  } finally {
    irohSecret.fill(0);
    if (session) {
      try { session.connection.close(0n, []); } catch { /* closed */ }
      await session.endpoint.close().catch(() => {});
    }
  }
}

async function main(args) {
  let code = null; let stateFile = defaultStateFile();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--state' && args[i + 1] && path.isAbsolute(args[i + 1])) stateFile = args[++i];
    else if (code === null && !args[i].startsWith('--')) code = args[i];
    else throw new Error('usage');
  }
  if (code === null) throw new Error('usage');
  const { keyId } = await pairAgent({ code, stateFile, onWords: (words) => {
    console.log(`Check that your owner screen shows: ${words.join(' ')}`);
    console.log('Waiting for Confirm on the owner screen...');
  } });
  console.log(`Paired as ${keyId}. Saved to ${stateFile}.`);
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); process.exit(0); }
  catch (error) {
    console.error(error?.message === 'usage' ? 'Usage: cyberbaser-pair <code> [--state <absolute new file>]'
      : ['invalid-pairing-code', 'state-file-exists'].includes(error?.message) ? error.message : PAIRING_REFUSAL);
    process.exit(1);
  }
}
