#!/usr/bin/env bun

import net from 'node:net';
import { loadOwnerAlphaConfig } from '../../apps/owner-alpha/src/config.js';

const CONFIG_FILE = '/run/owner-alpha/owner-alpha.local.json';
const DEFAULT_SOCKET = '/run/owner-alpha-credentials/helper.sock';
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const SOCKET_TIMEOUT_MS = 2_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

async function readBounded(input, maximum) {
  const chunks = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maximum) throw new Error('credential message too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function parseFields(bytes, { response = false } = {}) {
  const text = UTF8.decode(bytes);
  if (!text.endsWith('\n')) throw new Error('credential message must end with newline');
  const fields = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('invalid credential field');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[a-z][a-z0-9-]*(?:\[\])?$/u.test(key) || fields.has(key)) {
      throw new Error('invalid credential field');
    }
    if (value.length === 0 || value.length > 4096 || /[\0\r\n]/u.test(value)) {
      throw new Error('invalid credential value');
    }
    fields.set(key, value);
  }
  if (response) {
    if (fields.size !== 2 || !fields.has('username') || !fields.has('password')) {
      throw new Error('credential broker returned an invalid response');
    }
  }
  return fields;
}

function assertRequestMatches(fields, config) {
  const remote = new URL(config.repository.remote.url);
  const expectedPath = remote.pathname.slice(1);
  if (fields.get('protocol') !== 'https'
    || fields.get('host') !== remote.hostname
    || fields.get('path') !== expectedPath) {
    throw new Error('credential request does not match owner-alpha policy');
  }
  for (const key of fields.keys()) {
    if (!['protocol', 'host', 'path'].includes(key)) {
      throw new Error('credential request contains unsupported fields');
    }
  }
}

function exchange(socketPath, requestBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const socket = net.createConnection({ path: socketPath });
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.once('connect', () => socket.write(requestBytes));
    socket.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error('credential response too large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once('timeout', () => socket.destroy(new Error('credential broker timeout')));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks, total)));
  });
}

export async function runCredentialHelper({
  operation,
  input = process.stdin,
  output = process.stdout,
  configFile = CONFIG_FILE,
  socketPath = process.env.OWNER_ALPHA_CREDENTIAL_SOCKET ?? DEFAULT_SOCKET,
  enforceSocketContract = false,
} = {}) {
  if (!['get', 'store', 'erase'].includes(operation)) throw new Error('unsupported credential operation');
  const requestBytes = await readBounded(input, MAX_REQUEST_BYTES);
  if (operation !== 'get') return;
  if (enforceSocketContract && socketPath !== DEFAULT_SOCKET) throw new Error('unexpected credential socket path');
  const config = await loadOwnerAlphaConfig(configFile);
  const fields = parseFields(requestBytes);
  assertRequestMatches(fields, config);
  const responseBytes = await exchange(socketPath, requestBytes);
  parseFields(responseBytes, { response: true });
  output.write(responseBytes);
  if (!responseBytes.toString('utf8').endsWith('\n\n')) output.write('\n');
}

if (import.meta.main) {
  try {
    await runCredentialHelper({ operation: process.argv[2], enforceSocketContract: true });
  } catch {
    process.stderr.write('owner-alpha credential helper failed\n');
    process.exit(1);
  }
}
