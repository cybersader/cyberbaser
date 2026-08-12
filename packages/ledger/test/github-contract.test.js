import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPTURE_ARTIFACT_MAX_BYTES,
  CAPTURE_HINT_FILENAME,
  CAPTURE_HINT_MAX_BYTES,
  CAPTURE_HINT_SCHEMA_VERSION,
  CAPTURE_WORKFLOW_PATH,
  LedgerGithubError,
  bindCaptureHint,
  captureArtifactName,
  captureRunName,
  parseCaptureArtifactEntries,
  parseCaptureArtifactName,
  parseCaptureHint,
  parseCaptureRunName,
  selectCaptureArtifact,
  serializeCaptureHint,
  validateCaptureArtifactBinding,
  validateCaptureHint,
  validateCaptureRunBinding,
} from '../src/index.js';
import { runGithubCli } from '../src/github/cli.js';

const CLI = join(import.meta.dir, '..', 'bin', 'cb-decision-ledger-github.js');
const temporaryDirectories = [];

function hint(overrides = {}) {
  return {
    schemaVersion: CAPTURE_HINT_SCHEMA_VERSION,
    repositoryId: '123456789',
    repository: 'example/example-wiki',
    sourceRunId: '987654321',
    sourceRunAttempt: 2,
    prNumber: 42,
    ...overrides,
  };
}

function sourceRun(overrides = {}) {
  const base = {
    id: 987654321,
    run_attempt: 2,
    name: captureRunName(42),
    path: CAPTURE_WORKFLOW_PATH,
    display_title: captureRunName(42),
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    repository: { id: 123456789, full_name: 'example/example-wiki' },
    pull_requests: [],
  };
  return {
    ...base,
    ...overrides,
    repository: { ...base.repository, ...(overrides.repository ?? {}) },
  };
}

function artifact(overrides = {}) {
  const base = {
    id: 222,
    name: captureArtifactName(hint()),
    expired: false,
    size_in_bytes: 512,
    workflow_run: { id: 987654321, repository_id: 123456789 },
  };
  return {
    ...base,
    ...overrides,
    workflow_run: { ...base.workflow_run, ...(overrides.workflow_run ?? {}) },
  };
}

function expectedRepository(overrides = {}) {
  return { repositoryId: '123456789', repository: 'example/example-wiki', ...overrides };
}

function expectGithubError(fn, code, exitCode) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerGithubError);
    expect(error.code).toBe(code);
    if (exitCode !== undefined) expect(error.exitCode).toBe(exitCode);
    return error;
  }
  throw new Error(`expected LedgerGithubError(${code})`);
}

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'cb-ledger-github-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function runCli(args) {
  const process = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Stage A capture-hint schema and canonical bytes', () => {
  test('keeps ledger and capture schemas independently fixed at version 1', () => {
    expect(CAPTURE_HINT_SCHEMA_VERSION).toBe(1);
    expect(validateCaptureHint(hint()).schemaVersion).toBe(1);
  });

  test('normalizes exact routing-only keys in mandatory order', () => {
    const validated = validateCaptureHint({
      prNumber: 42,
      sourceRunAttempt: 2,
      sourceRunId: '987654321',
      repository: 'example/example-wiki',
      repositoryId: '123456789',
      schemaVersion: 1,
    });
    expect(Object.keys(validated)).toEqual([
      'schemaVersion',
      'repositoryId',
      'repository',
      'sourceRunId',
      'sourceRunAttempt',
      'prNumber',
    ]);
  });

  test('serializes compact canonical UTF-8 with exactly one final LF', () => {
    const serialized = serializeCaptureHint(hint());
    expect(serialized).toBe(
      '{"schemaVersion":1,"repositoryId":"123456789","repository":"example/example-wiki","sourceRunId":"987654321","sourceRunAttempt":2,"prNumber":42}\n',
    );
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(CAPTURE_HINT_MAX_BYTES);
    expect(parseCaptureHint(Buffer.from(serialized))).toEqual(hint());
  });

  test.each([
    ['trustRoute', 'quick-review'],
    ['labels', ['trust:quick-review']],
    ['actor', 'maintainer'],
    ['decision', 'merged'],
    ['baseSha', '1'.repeat(40)],
    ['headSha', '2'.repeat(40)],
    ['timestamp', '2026-08-03T00:00:00Z'],
    ['checks', []],
    ['ofmVerdict', 'clean'],
    ['url', 'https://example.invalid'],
    ['ref', 'refs/heads/main'],
    ['path', '.cyberbaser/decision-ledger.jsonl'],
    ['command', 'git push'],
    ['refspec', 'HEAD:main'],
  ])('rejects authority-bearing extra field %s', (field, value) => {
    expectGithubError(() => validateCaptureHint({ ...hint(), [field]: value }), 'unknown-field');
  });

  test('rejects missing routing assertions and unsupported capture schema versions', () => {
    const missing = hint();
    delete missing.prNumber;
    expectGithubError(() => validateCaptureHint(missing), 'missing-field');
    expectGithubError(() => validateCaptureHint(hint({ schemaVersion: 2 })), 'unsupported-capture-schema', 3);
  });

  test.each([
    ['numeric repository ID', { repositoryId: 123456789 }],
    ['numeric source run ID', { sourceRunId: 987654321 }],
    ['zero repository ID', { repositoryId: '0' }],
    ['leading-zero source run ID', { sourceRunId: '0987654321' }],
    ['negative source run ID', { sourceRunId: '-1' }],
    ['overwide repository ID', { repositoryId: '18446744073709551616' }],
    ['unsafe PR number', { prNumber: Number.MAX_SAFE_INTEGER + 1 }],
    ['zero run attempt', { sourceRunAttempt: 0 }],
  ])('rejects unsafe identifier form: %s', (_, overrides) => {
    expectGithubError(() => validateCaptureHint(hint(overrides)),
      Object.keys(overrides)[0].includes('Id') ? 'invalid-id' : 'invalid-positive-integer');
  });

  test.each([
    ['owner-only', { repository: 'example' }],
    ['path suffix', { repository: 'example/repo/extra' }],
    ['URL', { repository: 'https://github.com/example/repo' }],
    ['whitespace', { repository: 'example/repo name' }],
  ])('rejects unsafe repository identity: %s', (_, overrides) => {
    expectGithubError(() => validateCaptureHint(hint(overrides)), 'invalid-repository');
  });

  test.each([
    ['BOM', `﻿${serializeCaptureHint(hint())}`, 'utf8-bom'],
    ['pretty JSON', `${JSON.stringify(hint(), null, 2)}\n`, 'noncanonical-capture-hint'],
    ['missing final LF', serializeCaptureHint(hint()).slice(0, -1), 'noncanonical-capture-hint'],
    ['extra final LF', `${serializeCaptureHint(hint())}\n`, 'noncanonical-capture-hint'],
    ['wrong key order', `${JSON.stringify({ prNumber: 42, ...hint() })}\n`, 'noncanonical-capture-hint'],
    ['malformed JSON', '{nope}\n', 'malformed-capture-json'],
  ])('fails closed on noncanonical capture bytes: %s', (_, value, code) => {
    expectGithubError(() => parseCaptureHint(value), code);
  });

  test('rejects invalid UTF-8 and over-limit bytes before parsing', () => {
    expectGithubError(() => parseCaptureHint(Uint8Array.from([0xc3, 0x28])), 'invalid-utf8');
    expectGithubError(() => parseCaptureHint(Buffer.alloc(CAPTURE_HINT_MAX_BYTES + 1, 0x20)), 'capture-hint-too-large');
  });
});

describe('trusted run and artifact metadata binding', () => {
  test('uses deterministic, round-trippable run and artifact names', () => {
    expect(captureRunName(42)).toBe('Decision Ledger Capture / PR #42');
    expect(parseCaptureRunName(captureRunName(42))).toEqual({ prNumber: 42 });
    expect(captureArtifactName(hint())).toBe('decision-ledger-capture-run-987654321-pr-42');
    expect(parseCaptureArtifactName(captureArtifactName(hint()))).toEqual({
      sourceRunId: '987654321',
      prNumber: 42,
    });
  });

  test('accepts an empty workflow_run.pull_requests array and exact matching metadata', () => {
    expect(bindCaptureHint({
      hint: hint(),
      sourceRun: sourceRun(),
      artifact: artifact(),
      expectedRepository: expectedRepository(),
    })).toEqual(hint());
  });

  test('accepts exactly one matching workflow_run pull request', () => {
    expect(validateCaptureRunBinding(
      hint(),
      sourceRun({ pull_requests: [{ number: 42 }] }),
      expectedRepository(),
    )).toEqual(hint());
  });

  test.each([
    ['run ID', sourceRun({ id: 987654322 }), 'source-run-id-mismatch'],
    ['run attempt', sourceRun({ run_attempt: 3 }), 'source-run-attempt-mismatch'],
    ['run repository ID', sourceRun({ repository: { id: 123456790 } }), 'source-run-repository-mismatch'],
    ['run repository name', sourceRun({ repository: { full_name: 'example/other' } }), 'source-run-repository-mismatch'],
    ['workflow name', sourceRun({ name: 'Other Workflow' }), 'untrusted-source-workflow'],
    ['workflow path', sourceRun({ path: '.github/workflows/other.yml' }), 'untrusted-source-workflow'],
    ['display title format', sourceRun({ name: 'Decision Ledger Capture', display_title: 'Decision Ledger Capture' }), 'invalid-run-name'],
    ['event', sourceRun({ event: 'workflow_dispatch' }), 'invalid-source-event'],
    ['conclusion', sourceRun({ conclusion: 'failure' }), 'unsuccessful-source-run'],
    ['run-name PR', sourceRun({ name: captureRunName(43), display_title: captureRunName(43) }), 'source-run-pr-mismatch'],
    ['conflicting PR', sourceRun({ pull_requests: [{ number: 43 }] }), 'source-run-pull-request-mismatch'],
    ['ambiguous PRs', sourceRun({ pull_requests: [{ number: 42 }, { number: 42 }] }), 'ambiguous-source-pull-requests'],
  ])('rejects mismatched source-run metadata: %s', (_, run, code) => {
    expectGithubError(() => validateCaptureRunBinding(hint(), run, expectedRepository()), code);
  });

  test('rejects a run from a different recorder repository even when the hint matches it', () => {
    const otherHint = hint({ repositoryId: '555', repository: 'other/repo' });
    const otherRun = sourceRun({ repository: { id: 555, full_name: 'other/repo' } });
    expectGithubError(
      () => validateCaptureRunBinding(otherHint, otherRun, expectedRepository()),
      'expected-repository-mismatch',
    );
  });

  test('rejects unsafe numeric API IDs rather than accepting rounded metadata', () => {
    expectGithubError(
      () => validateCaptureRunBinding(hint(), sourceRun({ id: Number.MAX_SAFE_INTEGER + 1 }), expectedRepository()),
      'unsafe-metadata-id',
    );
  });

  test('requires exactly one deterministic artifact for the exact run', () => {
    expect(selectCaptureArtifact([artifact()], hint())).toEqual(artifact());
    expectGithubError(() => selectCaptureArtifact([], hint()), 'missing-capture-artifact');
    expectGithubError(() => selectCaptureArtifact([artifact(), artifact({ id: 223 })], hint()), 'multiple-capture-artifacts');
    expectGithubError(() => selectCaptureArtifact([artifact({ name: 'other' })], hint()), 'artifact-name-mismatch');
  });

  test.each([
    ['artifact run', artifact({ workflow_run: { id: 987654322 } }), 'artifact-run-mismatch'],
    ['artifact repository', artifact({ workflow_run: { repository_id: 123456790 } }), 'artifact-repository-mismatch'],
    ['expired artifact', artifact({ expired: true }), 'expired-capture-artifact'],
    ['zero artifact size', artifact({ size_in_bytes: 0 }), 'invalid-artifact-size'],
    ['oversized artifact', artifact({ size_in_bytes: CAPTURE_ARTIFACT_MAX_BYTES + 1 }), 'artifact-too-large'],
    ['artifact name PR', artifact({ name: 'decision-ledger-capture-run-987654321-pr-43' }), 'artifact-name-mismatch'],
  ])('rejects mismatched artifact metadata: %s', (_, metadata, code) => {
    expectGithubError(() => validateCaptureArtifactBinding(hint(), metadata), code);
  });

  test('requires one fixed archive filename and binds its canonical content', () => {
    const bytes = Buffer.from(serializeCaptureHint(hint()));
    expect(parseCaptureArtifactEntries([{ name: CAPTURE_HINT_FILENAME, data: bytes }])).toEqual(hint());
    expectGithubError(() => parseCaptureArtifactEntries([]), 'invalid-archive-entry-count');
    expectGithubError(
      () => parseCaptureArtifactEntries([
        { name: CAPTURE_HINT_FILENAME, data: bytes },
        { name: 'extra', data: Buffer.from('x') },
      ]),
      'invalid-archive-entry-count',
    );
    expectGithubError(
      () => parseCaptureArtifactEntries([{ name: '../decision-ledger-capture.json', data: bytes }]),
      'invalid-archive-entry-name',
    );
  });

  test('detects archive content that conflicts with trusted artifact metadata', () => {
    const tampered = parseCaptureArtifactEntries([{
      name: CAPTURE_HINT_FILENAME,
      data: Buffer.from(serializeCaptureHint(hint({ prNumber: 43 }))),
    }]);
    expectGithubError(() => validateCaptureArtifactBinding(tampered, artifact()), 'artifact-name-mismatch');
  });
});

describe('capture CLI foundation', () => {
  function captureArguments(output, overrides = {}) {
    return [
      'capture',
      '--out', output,
      '--repository-id', overrides.repositoryId ?? '123456789',
      '--repository', overrides.repository ?? 'example/example-wiki',
      '--run-id', overrides.sourceRunId ?? '987654321',
      '--run-attempt', String(overrides.sourceRunAttempt ?? 2),
      '--pr-number', String(overrides.prNumber ?? 42),
    ];
  }

  test('writes only the canonical routing hint and reports the deterministic artifact name', async () => {
    const directory = await tempDirectory();
    const output = join(directory, CAPTURE_HINT_FILENAME);
    const result = await runCli(captureArguments(output));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'captured',
      artifactName: captureArtifactName(hint()),
      filename: CAPTURE_HINT_FILENAME,
      bytes: Buffer.byteLength(serializeCaptureHint(hint())),
    });
    expect(await readFile(output, 'utf8')).toBe(serializeCaptureHint(hint()));
  });

  test('requires the fixed filename and never overwrites an existing capture', async () => {
    const directory = await tempDirectory();
    const wrongName = await runCli(captureArguments(join(directory, 'other.json')));
    expect(wrongName.exitCode).toBe(2);
    expect(wrongName.stderr).toContain('invalid-output-name');

    const output = join(directory, CAPTURE_HINT_FILENAME);
    expect((await runCli(captureArguments(output))).exitCode).toBe(0);
    const duplicate = await runCli(captureArguments(output));
    expect(duplicate.exitCode).toBe(4);
    expect(duplicate.stderr).toContain('filesystem-failure');
  });

  test('rejects missing arguments, duplicate flags, unsafe IDs, and authority extras', async () => {
    const directory = await tempDirectory();
    const output = join(directory, CAPTURE_HINT_FILENAME);
    for (const args of [
      captureArguments(output).slice(0, -2),
      [...captureArguments(output), '--pr-number', '42'],
      captureArguments(output, { sourceRunId: '0987654321' }),
      [...captureArguments(output), '--trust-route', 'quick-review'],
    ]) {
      const result = await runCli(args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
    }
  });
});

describe('Stage B record CLI foundation', () => {
  function recordArguments(overrides = {}) {
    return [
      'record',
      '--event', overrides.eventPath ?? '/runner/event.json',
      '--run-id', overrides.sourceRunId ?? '987654321',
      '--run-attempt', String(overrides.sourceRunAttempt ?? 2),
      '--checkout', overrides.checkout ?? '/runner/work/vault',
      '--repository-id', overrides.repositoryId ?? '123456789',
      '--repository', overrides.repository ?? 'example/example-wiki',
      '--remote', overrides.remote ?? 'origin',
      '--remote-url', overrides.remoteUrl ?? 'https://github.com/example/example-wiki',
      '--branch', overrides.branch ?? 'main',
    ];
  }

  test('binds the exact workflow run before calling reconstruction and publication', async () => {
    const event = { workflow_run: sourceRun() };
    const calls = [];
    const result = await runGithubCli(recordArguments(), {
      environment: {
        GITHUB_TOKEN: 'test-token',
        GITHUB_API_URL: 'https://api.github.test',
      },
      fetch: async () => { throw new Error('unexpected fetch'); },
      readFile: async (path) => {
        expect(path).toBe('/runner/event.json');
        return Buffer.from(JSON.stringify(event));
      },
      createGithubApi: (options) => {
        expect(options).toMatchObject({ token: 'test-token', apiBaseUrl: 'https://api.github.test' });
        return { marker: 'api' };
      },
      createGitReader: (options) => {
        expect(options).toEqual({ checkout: '/runner/work/vault' });
        return async () => Buffer.alloc(0);
      },
      extractArtifactEntries: async () => [],
      reconstructLedgerEntry: async (options) => {
        calls.push(['reconstruct', options]);
        expect(options.expectedRepository).toEqual({
          repositoryId: '123456789',
          repository: 'example/example-wiki',
        });
        expect(options.workflowRun).toEqual(event.workflow_run);
        expect(options.remote).toBe('origin');
        return { prNumber: 42 };
      },
      publishLedgerEntry: async (options) => {
        calls.push(['publish', options]);
        expect(options).toEqual({
          checkout: '/runner/work/vault',
          entry: { prNumber: 42 },
          remote: 'origin',
          remoteUrl: 'https://github.com/example/example-wiki',
          branch: 'main',
        });
        return {
          status: 'published',
          attempts: 1,
          commit: 'a'.repeat(40),
          pushPerformed: true,
        };
      },
    });

    expect(calls.map(([name]) => name)).toEqual(['reconstruct', 'publish']);
    expect(result).toEqual({
      status: 'published',
      prNumber: 42,
      attempts: 1,
      commit: 'a'.repeat(40),
      pushPerformed: true,
    });
  });

  test('fails closed before reconstruction when the event run binding conflicts', async () => {
    let reconstructed = false;
    await expect(runGithubCli(recordArguments({ sourceRunId: '987654322' }), {
      readFile: async () => Buffer.from(JSON.stringify({ workflow_run: sourceRun() })),
      reconstructLedgerEntry: async () => {
        reconstructed = true;
      },
    })).rejects.toMatchObject({ code: 'event-run-id-mismatch' });
    expect(reconstructed).toBe(false);

    await expect(runGithubCli(recordArguments({ sourceRunAttempt: 3 }), {
      readFile: async () => Buffer.from(JSON.stringify({ workflow_run: sourceRun() })),
      reconstructLedgerEntry: async () => {
        reconstructed = true;
      },
    })).rejects.toMatchObject({ code: 'event-run-attempt-mismatch' });
    expect(reconstructed).toBe(false);
  });
});
