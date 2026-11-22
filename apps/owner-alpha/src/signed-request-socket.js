import { createHash } from 'node:crypto';
import { chmod, lstat, realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { executeSigned } from './core/commands.js';
import { fail } from './errors.js';
import { canonicalJson } from './json.js';
import { readFrame, validSocketPath } from './publisher/protocol.js';

export const SIGNED_REQUEST_MAX_BYTES = 512 * 1024;
export const SIGNED_REQUEST_REFUSAL = 'proposal-submission-refused';
const REFUSED = Object.freeze({ ok: false, code: SIGNED_REQUEST_REFUSAL });
const MAX_CONNECTIONS = 8;
const READ_TIMEOUT_MS = 5000;

export function signedSocketAudience(socketPath) {
  if (!validSocketPath(socketPath)) throw new TypeError('invalid signed request socket path');
  return `cyberbaser.owner.signed-unix.v1:${createHash('sha256').update(socketPath).digest('hex')}`;
}

const unsafe = () => fail('signed-socket-unsafe', 'Signed requests need an unused local Unix socket in an owner-only real directory.');

async function inspectParent(socketPath) {
  if (!validSocketPath(socketPath) || typeof process.getuid !== 'function') unsafe();
  const directory = path.dirname(socketPath);
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700
    || await realpath(directory).catch(() => null) !== directory) unsafe();
  return info;
}

export async function startSignedRequestSocket({ socketPath, commands, verifier }) {
  const parent = await inspectParent(socketPath);
  // Refuse any existing entry before binding. Some Bun releases (1.3.11, the
  // pinned container runtime) replace an existing non-socket file on listen()
  // instead of failing with EADDRINUSE, so the bind itself cannot be trusted to
  // protect what is already there. The owner-only parent limits the remaining
  // race to the same user.
  const existing = await lstat(socketPath).then(() => true, (error) => error?.code !== 'ENOENT');
  if (existing) unsafe();
  const clients = new Set();
  const tasks = new Set();
  let ready = false;
  let closing;
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    let replied = false;
    const reply = (value) => {
      if (replied || socket.destroyed) return;
      replied = true;
      socket.end(`${JSON.stringify(value)}\n`, () => socket.destroy());
    };
    if (!ready || clients.size >= MAX_CONNECTIONS || tasks.size >= MAX_CONNECTIONS) return reply(REFUSED);
    clients.add(socket);
    const stopReading = readFrame(socket, (line) => {
      clearTimeout(timer);
      // No later bytes may execute a second command. Even while the first
      // command is in flight, a pipelined second frame gets only the refusal.
      socket.once('data', () => reply(REFUSED));
      socket.resume();
      const task = (async () => {
        try {
          const envelope = JSON.parse(line);
          // Canonical wire JSON rejects duplicate members before the core sees
          // the closed envelope. This carrier exposes only proposal submission.
          if (envelope?.command !== 'submitProposal' || canonicalJson(envelope) !== line) return REFUSED;
          const receipt = await executeSigned(commands, verifier, envelope);
          return { ok: true, receipt };
        } catch { return REFUSED; }
      })();
      tasks.add(task);
      void task.then((response) => {
        tasks.delete(task);
        if (!socket.destroyed) reply(response);
      });
    }, () => {
      clearTimeout(timer);
      reply(REFUSED);
    }, { maxBytes: SIGNED_REQUEST_MAX_BYTES });
    const timer = setTimeout(() => { stopReading(); reply(REFUSED); }, READ_TIMEOUT_MS);
    socket.once('close', () => { clearTimeout(timer); clients.delete(socket); });
  });
  server.on('error', () => {}); // Do not log raw paths or request details.
  try {
    // Never remove another listener or guess whether an occupied path is stale.
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: socketPath, backlog: MAX_CONNECTIONS }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const current = await inspectParent(socketPath);
    if (parent.dev !== current.dev || parent.ino !== current.ino) unsafe();
    await chmod(socketPath, 0o600);
    const socket = await lstat(socketPath);
    if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o7777) !== 0o600) unsafe();
    ready = true;
  } catch {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    unsafe();
  }
  return Object.freeze({ close() {
    closing ??= (async () => {
      ready = false;
      const idle = new Promise((resolve) => server.close(resolve));
      for (const socket of clients) socket.destroy();
      await Promise.all([idle, ...tasks]);
    })();
    return closing;
  } });
}

export async function sendSignedRequest(socketPath, envelope) {
  try {
    await inspectParent(socketPath);
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600) return REFUSED;
  } catch { return REFUSED; }
  const frame = `${canonicalJson(envelope)}\n`;
  if (Buffer.byteLength(frame) > SIGNED_REQUEST_MAX_BYTES) return REFUSED;
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath }, () => socket.write(frame));
    const finish = (response = REFUSED) => { socket.destroy(); resolve(response); };
    socket.setTimeout(15000, () => finish());
    socket.on('error', () => finish());
    socket.on('close', () => finish());
    readFrame(socket, (line) => {
      try { finish(JSON.parse(line)); } catch { finish(); }
    }, () => finish());
  });
}
