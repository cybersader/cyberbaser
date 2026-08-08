import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  LedgerError,
  buildLedgerEntry,
  calculateLedgerStats,
  dedupeLedgerEntry,
  parseLedgerText,
  serializeLedgerEntry,
} from './ledger.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function usage() {
  throw new LedgerError(
    'invalid-arguments',
    'usage: cb-decision-ledger <append|derive+append|validate|stats> --file <path> [--target <positive-integer>]',
  );
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!new Set(['append', 'derive+append', 'validate', 'stats']).has(command)) usage();
  let file = null;
  let target = 20;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--file') {
      file = rest[index + 1];
      index += 1;
      if (!file) usage();
    } else if (argument === '--target' && command === 'stats') {
      const raw = rest[index + 1];
      index += 1;
      target = Number(raw);
      if (!Number.isSafeInteger(target) || target <= 0) usage();
    } else {
      usage();
    }
  }
  if (!file) usage();
  return { command, file, target };
}

async function readLedger(path, { allowMissing = false } = {}) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      return { bytes: Buffer.alloc(0), text: '', entries: [], mode: 0o644, stat: null };
    }
    error.isFilesystemError = true;
    throw error;
  }
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new LedgerError('invalid-utf8', 'ledger must be valid UTF-8');
  }
  let fileStat;
  try {
    fileStat = await stat(path, { bigint: true });
  } catch (error) {
    error.isFilesystemError = true;
    throw error;
  }
  return {
    bytes,
    text,
    entries: parseLedgerText(text),
    mode: Number(fileStat.mode & 0o777n),
    stat: fileStat,
  };
}

async function readStdinObject() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new LedgerError('empty-stdin', 'stdin must contain exactly one JSON object');
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new LedgerError('invalid-utf8', 'stdin must be valid UTF-8');
  }
  if (text.trim() === '') throw new LedgerError('empty-stdin', 'stdin must contain exactly one JSON object');
  if (text.startsWith('﻿')) throw new LedgerError('utf8-bom', 'stdin must not begin with a UTF-8 BOM');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new LedgerError('invalid-stdin-json', `stdin must contain exactly one JSON value: ${error.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LedgerError('invalid-stdin-json', 'stdin JSON value must be an object');
  }
  return value;
}

function unchangedSinceRead(current, original) {
  if (original === null) return current === null;
  return current !== null
    && current.dev === original.dev
    && current.ino === original.ino
    && current.size === original.size
    && current.mtimeNs === original.mtimeNs;
}

async function currentStat(path) {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    error.isFilesystemError = true;
    throw error;
  }
}

async function atomicAppend(path, originalBytes, line, mode, originalStat) {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    await handle.writeFile(Buffer.concat([originalBytes, Buffer.from(line, 'utf8')]));
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, mode);

    const now = await currentStat(path);
    if (!unchangedSinceRead(now, originalStat)) {
      throw new LedgerError('concurrent-modification', 'ledger changed while the append was being prepared', {}, 4);
    }
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (!(error instanceof LedgerError)) error.isFilesystemError = true;
    throw error;
  }
}

export async function appendLedgerEntryFile(file, candidate) {
  const existing = await readLedger(file, { allowMissing: true });
  const decision = dedupeLedgerEntry(existing.entries, candidate);
  if (decision.status !== 'append') {
    return { status: decision.status, prNumber: decision.entry.prNumber, line: decision.line };
  }
  const line = serializeLedgerEntry(decision.entry);
  await atomicAppend(file, existing.bytes, line, existing.mode, existing.stat);
  return { status: 'appended', prNumber: decision.entry.prNumber, line: decision.line };
}

async function appendCommand(file, builder) {
  const input = await readStdinObject();
  return appendLedgerEntryFile(file, builder(input));
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, file, target } = parseArguments(argv);
  if (command === 'append') return appendCommand(file, (value) => value);
  if (command === 'derive+append') return appendCommand(file, (value) => buildLedgerEntry(value));
  const { entries } = await readLedger(file);
  if (command === 'validate') {
    return { valid: true, entries: entries.length, schemaVersions: [...new Set(entries.map((entry) => entry.schemaVersion))] };
  }
  return calculateLedgerStats(entries, { target });
}

function diagnostic(error) {
  if (error instanceof LedgerError) {
    const line = error.details?.line ? ` line=${error.details.line}` : '';
    return `cb-decision-ledger: ${error.code}${line}: ${error.message}`;
  }
  return `cb-decision-ledger: filesystem-failure: ${error?.message ?? String(error)}`;
}

export async function main() {
  try {
    const result = await runCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${diagnostic(error)}\n`);
    if (error instanceof LedgerError) process.exitCode = error.exitCode;
    else process.exitCode = 4;
  }
}
