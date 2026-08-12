import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  CAPTURE_HINT_FILENAME,
  CAPTURE_HINT_MAX_BYTES,
  CAPTURE_HINT_SCHEMA_VERSION,
  LedgerGithubError,
  captureArtifactName,
  serializeCaptureHint,
  validateCaptureHint,
} from './contract.js';
import { createGithubApi } from './api.js';
import { createGitReader } from './git.js';
import { publishLedgerEntry } from './publish.js';
import { reconstructLedgerEntry } from './reconstruct.js';

const execFileAsync = promisify(execFile);
const EVENT_MAX_BYTES = 4 * 1024 * 1024;
const ZIP_LIST_MAX_BYTES = 64 * 1024;

function usage() {
  throw new LedgerGithubError(
    'invalid-arguments',
    `usage:
  cb-decision-ledger-github capture --out <${CAPTURE_HINT_FILENAME}> --repository-id <id> --repository <owner/repo> --run-id <id> --run-attempt <positive-integer> --pr-number <positive-integer>
  cb-decision-ledger-github record --event <event.json> --run-id <id> --run-attempt <positive-integer> --checkout <absolute-path> --repository-id <id> --repository <owner/repo> --remote <name> --remote-url <url> --branch <default-branch>`,
  );
}

function positiveIntegerArgument(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) usage();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) usage();
  return parsed;
}

function decimalIdArgument(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) usage();
  if (BigInt(value) > 18_446_744_073_709_551_615n) usage();
  return value;
}

function flagValues(rest, allowed) {
  const values = new Map();
  if (rest.length % 2 !== 0) usage();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(flag) || value === undefined || values.has(flag)) usage();
    values.set(flag, value);
  }
  if (values.size !== allowed.size) usage();
  return values;
}

function captureArguments(rest) {
  const allowed = new Set([
    '--out',
    '--repository-id',
    '--repository',
    '--run-id',
    '--run-attempt',
    '--pr-number',
  ]);
  const values = flagValues(rest, allowed);
  const output = values.get('--out');
  if (basename(output) !== CAPTURE_HINT_FILENAME) {
    throw new LedgerGithubError('invalid-output-name', `capture output must be named ${CAPTURE_HINT_FILENAME}`);
  }
  return {
    command: 'capture',
    output,
    hint: {
      schemaVersion: CAPTURE_HINT_SCHEMA_VERSION,
      repositoryId: decimalIdArgument(values.get('--repository-id')),
      repository: values.get('--repository'),
      sourceRunId: decimalIdArgument(values.get('--run-id')),
      sourceRunAttempt: positiveIntegerArgument(values.get('--run-attempt')),
      prNumber: positiveIntegerArgument(values.get('--pr-number')),
    },
  };
}

function nonEmptyArgument(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) usage();
  return value;
}

function recordArguments(rest) {
  const allowed = new Set([
    '--event',
    '--run-id',
    '--run-attempt',
    '--checkout',
    '--repository-id',
    '--repository',
    '--remote',
    '--remote-url',
    '--branch',
  ]);
  const values = flagValues(rest, allowed);
  return {
    command: 'record',
    eventPath: nonEmptyArgument(values.get('--event')),
    sourceRunId: decimalIdArgument(values.get('--run-id')),
    sourceRunAttempt: positiveIntegerArgument(values.get('--run-attempt')),
    checkout: nonEmptyArgument(values.get('--checkout')),
    repositoryId: decimalIdArgument(values.get('--repository-id')),
    repository: nonEmptyArgument(values.get('--repository')),
    remote: nonEmptyArgument(values.get('--remote')),
    remoteUrl: nonEmptyArgument(values.get('--remote-url')),
    branch: nonEmptyArgument(values.get('--branch')),
  };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command === 'capture') return captureArguments(rest);
  if (command === 'record') return recordArguments(rest);
  return usage();
}

function metadataId(value, label) {
  if (typeof value === 'string') return decimalIdArgument(value);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LedgerGithubError('unsafe-event-id', `${label} must be a positive safe integer or canonical decimal string`);
  }
  return String(value);
}

function requireWorkflowRunEvent(value, expectedRunId, expectedRunAttempt) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LedgerGithubError('invalid-event', 'workflow event must be an object');
  }
  const workflowRun = value.workflow_run;
  if (workflowRun === null || typeof workflowRun !== 'object' || Array.isArray(workflowRun)) {
    throw new LedgerGithubError('invalid-event', 'workflow event must contain workflow_run');
  }
  if (metadataId(workflowRun.id, 'workflow_run.id') !== expectedRunId) {
    throw new LedgerGithubError('event-run-id-mismatch', 'workflow_run.id does not match --run-id');
  }
  if (workflowRun.run_attempt !== expectedRunAttempt) {
    throw new LedgerGithubError('event-run-attempt-mismatch', 'workflow_run.run_attempt does not match --run-attempt');
  }
  return workflowRun;
}

async function parseEvent(path, read) {
  let bytes;
  try {
    bytes = Buffer.from(await read(path));
  } catch (error) {
    error.isFilesystemError = true;
    throw error;
  }
  if (bytes.length === 0 || bytes.length > EVENT_MAX_BYTES) {
    throw new LedgerGithubError('invalid-event-size', `workflow event must be between 1 and ${EVENT_MAX_BYTES} bytes`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new LedgerGithubError('invalid-event-utf8', 'workflow event must be valid UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LedgerGithubError('invalid-event-json', `workflow event is not valid JSON: ${error.message}`);
  }
}

async function extractArtifactEntries(archive) {
  const directory = await mkdtemp(join(tmpdir(), 'cb-ledger-artifact-'));
  const archivePath = join(directory, 'artifact.zip');
  try {
    await writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 });
    const listed = await execFileAsync('unzip', ['-Z1', archivePath], {
      encoding: 'utf8',
      maxBuffer: ZIP_LIST_MAX_BYTES,
      windowsHide: true,
    });
    if (listed.stdout !== `${CAPTURE_HINT_FILENAME}\n`) {
      throw new LedgerGithubError(
        'invalid-archive-entry-list',
        `artifact archive must contain exactly ${CAPTURE_HINT_FILENAME}`,
      );
    }
    const extracted = await execFileAsync('unzip', ['-p', archivePath, CAPTURE_HINT_FILENAME], {
      encoding: 'buffer',
      maxBuffer: CAPTURE_HINT_MAX_BYTES + 1,
      windowsHide: true,
    });
    return [{ name: CAPTURE_HINT_FILENAME, data: Buffer.from(extracted.stdout) }];
  } catch (error) {
    if (error instanceof LedgerGithubError) throw error;
    throw new LedgerGithubError('artifact-extraction-failed', 'capture artifact is not a valid bounded ZIP archive');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function dependencies(overrides = {}) {
  return {
    createGithubApi,
    createGitReader,
    environment: process.env,
    extractArtifactEntries,
    fetch: globalThis.fetch,
    publishLedgerEntry,
    readFile,
    reconstructLedgerEntry,
    writeFile,
    ...overrides,
  };
}

async function runCapture(args, deps) {
  const hint = validateCaptureHint(args.hint);
  const serialized = serializeCaptureHint(hint);
  try {
    await deps.writeFile(args.output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    error.isFilesystemError = true;
    throw error;
  }
  return {
    status: 'captured',
    artifactName: captureArtifactName(hint),
    filename: CAPTURE_HINT_FILENAME,
    bytes: Buffer.byteLength(serialized, 'utf8'),
  };
}

async function runRecord(args, deps) {
  const event = await parseEvent(args.eventPath, deps.readFile);
  const workflowRun = requireWorkflowRunEvent(event, args.sourceRunId, args.sourceRunAttempt);
  const api = deps.createGithubApi({
    fetch: deps.fetch,
    token: deps.environment.GITHUB_TOKEN,
    apiBaseUrl: deps.environment.GITHUB_API_URL,
  });
  const git = deps.createGitReader({ checkout: args.checkout });
  const entry = await deps.reconstructLedgerEntry({
    api,
    expectedRepository: {
      repositoryId: args.repositoryId,
      repository: args.repository,
    },
    workflowRun,
    extractArtifactEntries: deps.extractArtifactEntries,
    git,
    remote: args.remote,
  });
  const publication = await deps.publishLedgerEntry({
    checkout: args.checkout,
    entry,
    remote: args.remote,
    remoteUrl: args.remoteUrl,
    branch: args.branch,
  });
  return {
    status: publication.status,
    prNumber: entry.prNumber,
    attempts: publication.attempts,
    commit: publication.commit,
    pushPerformed: publication.pushPerformed,
  };
}

export async function runGithubCli(argv = process.argv.slice(2), overrides = {}) {
  const args = parseArguments(argv);
  const deps = dependencies(overrides);
  if (args.command === 'capture') return runCapture(args, deps);
  return runRecord(args, deps);
}

function diagnostic(error) {
  if (error instanceof LedgerGithubError) {
    return `cb-decision-ledger-github: ${error.code}: ${error.message}`;
  }
  return `cb-decision-ledger-github: ${error?.isFilesystemError ? 'filesystem-failure' : 'runtime-failure'}: ${error?.message ?? String(error)}`;
}

export async function main() {
  try {
    const result = await runGithubCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${diagnostic(error)}\n`);
    if (error instanceof LedgerGithubError) process.exitCode = error.exitCode;
    else process.exitCode = 4;
  }
}
