import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LedgerError,
  buildLedgerEntry,
  calculateLedgerStats,
  dedupeLedgerEntry,
  normalizeCheckRuns,
  parseLedgerText,
  serializeLedgerEntry,
  validateLedgerEntry,
} from '../src/index.js';

const SHA_A = '1111111111111111111111111111111111111111';
const SHA_B = '2222222222222222222222222222222222222222';
const SHA_C = '3333333333333333333333333333333333333333';
const CLI = join(import.meta.dir, '..', 'bin', 'cb-decision-ledger.js');
const temporaryDirectories = [];

function entry(overrides = {}) {
  const base = {
    schemaVersion: 1,
    prNumber: 17,
    author: 'example-user',
    authorType: 'agent',
    trustRoute: 'quick-review',
    ofmVerdict: 'clean',
    checks: [
      { name: 'classify', appSlug: 'github-actions', status: 'completed', conclusion: 'success' },
      { name: 'validate', appSlug: 'github-actions', status: 'completed', conclusion: 'success' },
    ],
    maintainerDecision: 'merged',
    mergeCommitSha: SHA_C,
    baseSha: SHA_A,
    headSha: SHA_B,
    timestamps: {
      openedAt: '2026-08-01T10:00:00Z',
      closedAt: '2026-08-01T12:00:00Z',
      recordedAt: '2026-08-01T12:00:15Z',
    },
  };
  return {
    ...base,
    ...overrides,
    timestamps: { ...base.timestamps, ...(overrides.timestamps ?? {}) },
  };
}

function closedEvent(overrides = {}) {
  const pullRequest = {
    number: 17,
    user: { login: 'Example-Agent', type: 'User' },
    labels: [{ name: 'trust:quick-review' }],
    merged: true,
    merged_by: { login: 'maintainer' },
    merge_commit_sha: SHA_C,
    base: { sha: SHA_A },
    head: { sha: SHA_B },
    created_at: '2026-08-01T10:00:00.555Z',
    closed_at: '2026-08-01T12:00:00.999Z',
    ...overrides.pull_request,
  };
  return {
    pull_request: pullRequest,
    sender: { login: 'maintainer' },
    repository: { full_name: 'owner/repo' },
    ...overrides,
    ...(overrides.pull_request ? { pull_request: pullRequest } : {}),
  };
}

function builderInput(overrides = {}) {
  return {
    event: closedEvent(),
    agents: ['example-agent'],
    ofmVerdict: 'clean',
    checkRuns: [],
    recordedAt: '2026-08-01T12:00:15.321Z',
    decisionActorPermission: 'maintain',
    excludedChecks: [],
    ...overrides,
  };
}

function expectLedgerError(fn, code, exitCode) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect(error.code).toBe(code);
    if (exitCode !== undefined) expect(error.exitCode).toBe(exitCode);
    return error;
  }
  throw new Error(`expected LedgerError(${code})`);
}

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'cb-ledger-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function runCli(args, stdin = '') {
  const process = Bun.spawn(['bun', CLI, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  process.stdin.write(stdin);
  process.stdin.end();
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

describe('version 1 schema validation', () => {
  test('accepts the complete version 1 schema and returns canonical key order', () => {
    const validated = validateLedgerEntry(entry());
    expect(Object.keys(validated)).toEqual([
      'schemaVersion', 'prNumber', 'author', 'authorType', 'trustRoute', 'ofmVerdict', 'checks',
      'maintainerDecision', 'mergeCommitSha', 'baseSha', 'headSha', 'timestamps',
    ]);
    expect(Object.keys(validated.checks[0])).toEqual(['name', 'appSlug', 'status', 'conclusion']);
    expect(Object.keys(validated.timestamps)).toEqual(['openedAt', 'closedAt', 'recordedAt']);
  });

  test.each(['auto-merge', 'quick-review', 'full-review', 'reject', null])(
    'accepts trustRoute %p',
    (trustRoute) => expect(validateLedgerEntry(entry({ trustRoute })).trustRoute).toBe(trustRoute),
  );

  test.each(['clean', 'suspect', 'damage', 'not-applicable'])(
    'accepts OFM verdict %s',
    (ofmVerdict) => expect(validateLedgerEntry(entry({ ofmVerdict })).ofmVerdict).toBe(ofmVerdict),
  );

  test.each(['agent', 'human'])(
    'accepts a present author with authorType %s',
    (authorType) => expect(validateLedgerEntry(entry({ authorType })).authorType).toBe(authorType),
  );

  test('accepts a null anonymous author and a closed-unmerged decision', () => {
    const validated = validateLedgerEntry(entry({
      author: null,
      authorType: 'anonymous',
      maintainerDecision: 'closed-unmerged',
      mergeCommitSha: null,
    }));
    expect(validated.author).toBeNull();
    expect(validated.mergeCommitSha).toBeNull();
  });

  test('accepts incomplete and completed check states with their required conclusion shape', () => {
    const checks = [
      { name: 'a', appSlug: 'app', status: 'queued', conclusion: null },
      { name: 'b', appSlug: 'app', status: 'in_progress', conclusion: null },
      { name: 'c', appSlug: 'app', status: 'waiting', conclusion: null },
      { name: 'd', appSlug: 'app', status: 'requested', conclusion: null },
      { name: 'e', appSlug: 'app', status: 'pending', conclusion: null },
      { name: 'f', appSlug: 'app', status: 'completed', conclusion: 'cancelled' },
    ];
    expect(validateLedgerEntry(entry({ checks })).checks).toEqual(checks);
  });

  test.each([
    ['unknown-field', { extra: true }, 'unknown-field'],
    ['missing-field', (() => { const value = entry(); delete value.author; return value; })(), 'missing-field'],
    ['unsupported-schema', entry({ schemaVersion: 2 }), 'unsupported-schema'],
    ['invalid-pr-number', entry({ prNumber: 0 }), 'invalid-pr-number'],
    ['invalid-author-enum', entry({ authorType: 'robot' }), 'invalid-enum'],
    ['invalid-author-relationship', entry({ author: null, authorType: 'agent' }), 'invalid-author-relationship'],
    ['invalid-trust-route', entry({ trustRoute: 'manual' }), 'invalid-enum'],
    ['invalid-ofm', entry({ ofmVerdict: 'unknown' }), 'invalid-enum'],
    ['invalid-decision', entry({ maintainerDecision: 'approved' }), 'invalid-enum'],
    ['invalid-sha', entry({ headSha: 'ABC' }), 'invalid-sha'],
    ['same-base-head', entry({ headSha: SHA_A }), 'invalid-sha-relationship'],
    ['merged-without-sha', entry({ mergeCommitSha: null }), 'invalid-merge-relationship'],
    ['closed-with-sha', entry({ maintainerDecision: 'closed-unmerged' }), 'invalid-merge-relationship'],
    ['timestamp-order', entry({ timestamps: { recordedAt: '2026-08-01T11:59:59Z' } }), 'invalid-timestamp-relationship'],
    ['invalid-date', entry({ timestamps: { openedAt: '2026-02-30T10:00:00Z' } }), 'invalid-timestamp'],
  ])('rejects %s', (_, value, code) => {
    expectLedgerError(() => validateLedgerEntry(value), code, code === 'unsupported-schema' ? 3 : 2);
  });

  test('rejects unknown nested fields, duplicate checks, unsorted checks, and invalid conclusions', () => {
    expectLedgerError(() => validateLedgerEntry(entry({ checks: [
      { name: 'a', appSlug: 'app', status: 'completed', conclusion: 'success', extra: true },
    ] })), 'unknown-field');
    expectLedgerError(() => validateLedgerEntry(entry({ checks: [
      { name: 'a', appSlug: 'app', status: 'completed', conclusion: 'success' },
      { name: 'a', appSlug: 'app', status: 'completed', conclusion: 'failure' },
    ] })), 'duplicate-check');
    expectLedgerError(() => validateLedgerEntry(entry({ checks: [
      { name: 'b', appSlug: 'app', status: 'completed', conclusion: 'success' },
      { name: 'a', appSlug: 'app', status: 'completed', conclusion: 'success' },
    ] })), 'unsorted-checks');
    expectLedgerError(() => validateLedgerEntry(entry({ checks: [
      { name: 'a', appSlug: 'app', status: 'completed', conclusion: null },
    ] })), 'invalid-check-conclusion');
    expectLedgerError(() => validateLedgerEntry(entry({ checks: [
      { name: 'a', appSlug: 'app', status: 'queued', conclusion: 'success' },
    ] })), 'invalid-check-conclusion');
  });

  test('rejects unpaired Unicode surrogates', () => {
    expectLedgerError(() => validateLedgerEntry(entry({ author: '\ud800' })), 'invalid-unicode');
  });
});

describe('canonical JSONL serialization and parsing', () => {
  test('serializes the exact mandatory order, compact form, UTF-8 text, and final LF', () => {
    const line = serializeLedgerEntry(entry());
    expect(line).toBe(
      `{"schemaVersion":1,"prNumber":17,"author":"example-user","authorType":"agent","trustRoute":"quick-review","ofmVerdict":"clean","checks":[{"name":"classify","appSlug":"github-actions","status":"completed","conclusion":"success"},{"name":"validate","appSlug":"github-actions","status":"completed","conclusion":"success"}],"maintainerDecision":"merged","mergeCommitSha":"${SHA_C}","baseSha":"${SHA_A}","headSha":"${SHA_B}","timestamps":{"openedAt":"2026-08-01T10:00:00Z","closedAt":"2026-08-01T12:00:00Z","recordedAt":"2026-08-01T12:00:15Z"}}\n`,
    );
    expect(line.endsWith('\n')).toBe(true);
    expect(line.includes('\r')).toBe(false);
  });

  test('round-trips multiple canonical entries without changing bytes', () => {
    const text = serializeLedgerEntry(entry()) + serializeLedgerEntry(entry({
      prNumber: 18,
      trustRoute: null,
      maintainerDecision: 'closed-unmerged',
      mergeCommitSha: null,
    }));
    const parsed = parseLedgerText(text);
    expect(parsed).toHaveLength(2);
    expect(parsed.map(serializeLedgerEntry).join('')).toBe(text);
  });

  test('treats an empty file as a valid empty ledger', () => {
    expect(parseLedgerText('')).toEqual([]);
  });

  test.each([
    ['BOM', `﻿${serializeLedgerEntry(entry())}`, 'utf8-bom'],
    ['partial final line', serializeLedgerEntry(entry()).slice(0, -1), 'partial-final-line'],
    ['blank interior line', `${serializeLedgerEntry(entry())}\n`, 'blank-line'],
    ['malformed JSON', '{nope}\n', 'malformed-json'],
    ['pretty JSON', `${JSON.stringify(entry(), null, 2)}\n`, 'malformed-json'],
    ['wrong key order', `${JSON.stringify({ prNumber: 17, ...entry() })}\n`, 'noncanonical-line'],
    ['CRLF', serializeLedgerEntry(entry()).replace('\n', '\r\n'), 'noncanonical-line-ending'],
  ])('fails closed on %s', (_, text, code) => {
    const error = expectLedgerError(() => parseLedgerText(text), code);
    if (code !== 'partial-final-line') expect(error.details.line).toBe(code === 'blank-line' ? 2 : 1);
  });

  test('rejects duplicate PR numbers as contradictory history', () => {
    const text = serializeLedgerEntry(entry()) + serializeLedgerEntry(entry({
      timestamps: { closedAt: '2026-08-02T12:00:00Z', recordedAt: '2026-08-02T12:00:15Z' },
    }));
    const error = expectLedgerError(() => parseLedgerText(text), 'duplicate-pr-number', 3);
    expect(error.details).toMatchObject({ line: 2, firstLine: 1, prNumber: 17 });
  });

  test('reports the historical line number for schema failures', () => {
    const line = serializeLedgerEntry(entry()).replace('"authorType":"agent"', '"authorType":"robot"');
    const error = expectLedgerError(() => parseLedgerText(line), 'invalid-enum');
    expect(error.details.line).toBe(1);
  });
});

describe('event-shaped entry derivation', () => {
  test('derives agent identity, route, decision, timestamps, and canonical checks', () => {
    const built = buildLedgerEntry(builderInput({
      checkRuns: [
        { id: 1, name: 'zeta', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure' },
        { id: 3, name: 'alpha', app: { slug: 'other-app' }, status: 'in_progress', conclusion: null },
        { id: 2, name: 'zeta', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' },
        { id: 4, name: 'decision-ledger', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' },
      ],
      excludedChecks: [{ appSlug: 'github-actions', name: 'decision-ledger' }],
    }));
    expect(built).toMatchObject({
      prNumber: 17,
      author: 'Example-Agent',
      authorType: 'agent',
      trustRoute: 'quick-review',
      maintainerDecision: 'merged',
      mergeCommitSha: SHA_C,
      timestamps: {
        openedAt: '2026-08-01T10:00:00Z',
        closedAt: '2026-08-01T12:00:00Z',
        recordedAt: '2026-08-01T12:00:15Z',
      },
    });
    expect(built.checks).toEqual([
      { name: 'zeta', appSlug: 'github-actions', status: 'completed', conclusion: 'success' },
      { name: 'alpha', appSlug: 'other-app', status: 'in_progress', conclusion: null },
    ]);
  });

  test('classifies bots as agents without policy registration', () => {
    for (const user of [
      { login: 'service', type: 'Bot' },
      { login: 'dependabot[bot]', type: 'User' },
    ]) {
      const built = buildLedgerEntry(builderInput({
        event: closedEvent({ pull_request: { user } }),
        agents: [],
      }));
      expect(built.authorType).toBe('agent');
    }
  });

  test('classifies missing authors as anonymous and ordinary authors as human', () => {
    const anonymous = buildLedgerEntry(builderInput({
      event: closedEvent({ pull_request: { user: { login: null, type: 'User' } } }),
      agents: [],
    }));
    expect(anonymous).toMatchObject({ author: null, authorType: 'anonymous' });

    const human = buildLedgerEntry(builderInput({ agents: [] }));
    expect(human.authorType).toBe('human');
  });

  test('records no trust label as unclassified', () => {
    const built = buildLedgerEntry(builderInput({
      event: closedEvent({ pull_request: { labels: [] } }),
    }));
    expect(built.trustRoute).toBeNull();
  });

  test('rejects unknown or contradictory trust labels', () => {
    expectLedgerError(() => buildLedgerEntry(builderInput({
      event: closedEvent({ pull_request: { labels: [{ name: 'trust:maybe' }] } }),
    })), 'unknown-trust-label');
    expectLedgerError(() => buildLedgerEntry(builderInput({
      event: closedEvent({ pull_request: { labels: [
        { name: 'trust:auto-merge' }, { name: 'trust:reject' },
      ] } }),
    })), 'contradictory-trust-labels');
  });

  test('derives an unmerged maintainer close from the event sender', () => {
    const built = buildLedgerEntry(builderInput({
      event: closedEvent({
        pull_request: { merged: false, merged_by: null, merge_commit_sha: null },
        sender: { login: 'closing-maintainer' },
      }),
      decisionActorPermission: 'admin',
    }));
    expect(built).toMatchObject({ maintainerDecision: 'closed-unmerged', mergeCommitSha: null });
  });

  test('rejects contributors, absent decision actors, and merged events without merge SHAs', () => {
    expectLedgerError(() => buildLedgerEntry(builderInput({ decisionActorPermission: 'write' })), 'decision-actor-not-maintainer');
    expectLedgerError(() => buildLedgerEntry(builderInput({
      event: closedEvent({ pull_request: { merged_by: null } }),
    })), 'invalid-string');
    expectLedgerError(() => buildLedgerEntry(builderInput({
      event: closedEvent({ pull_request: { merge_commit_sha: null } }),
    })), 'invalid-merge-relationship');
  });

  test('rejects unknown builder fields', () => {
    expectLedgerError(() => buildLedgerEntry({ ...builderInput(), extra: true }), 'unknown-field');
  });

  test('normalizes latest check runs independently and sorts by app and name', () => {
    const checks = normalizeCheckRuns([
      { id: 10, name: 'b', appSlug: 'z', status: 'completed', conclusion: 'failure' },
      { id: 9, name: 'a', appSlug: 'a', status: 'completed', conclusion: 'success' },
      { id: 11, name: 'b', appSlug: 'z', status: 'completed', conclusion: 'cancelled' },
    ]);
    expect(checks).toEqual([
      { name: 'a', appSlug: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', appSlug: 'z', status: 'completed', conclusion: 'cancelled' },
    ]);
  });
});

describe('deduplication', () => {
  test('selects the next line for a new PR', () => {
    expect(dedupeLedgerEntry([entry()], entry({ prNumber: 18 }))).toMatchObject({
      status: 'append',
      line: 2,
      entry: { prNumber: 18 },
    });
  });

  test('returns already-recorded for the same closure and preserves the first observation', () => {
    const first = entry();
    const result = dedupeLedgerEntry([first], entry({ ofmVerdict: 'damage' }));
    expect(result).toMatchObject({ status: 'already-recorded', line: 1 });
    expect(result.entry.ofmVerdict).toBe('clean');
  });

  test('returns already-recorded-reclosed for a reopened and reclosed PR', () => {
    const result = dedupeLedgerEntry([entry()], entry({
      timestamps: { closedAt: '2026-08-02T12:00:00Z', recordedAt: '2026-08-02T12:00:15Z' },
    }));
    expect(result).toMatchObject({ status: 'already-recorded-reclosed', line: 1 });
  });
});

describe('statistics', () => {
  test('reports per-route decisions, outcome agreement, and excludes review-depth routes', () => {
    const entries = [
      entry({ prNumber: 1, trustRoute: 'auto-merge', maintainerDecision: 'merged', mergeCommitSha: SHA_C }),
      entry({ prNumber: 2, trustRoute: 'auto-merge', maintainerDecision: 'closed-unmerged', mergeCommitSha: null }),
      entry({ prNumber: 3, trustRoute: 'reject', maintainerDecision: 'closed-unmerged', mergeCommitSha: null }),
      entry({ prNumber: 4, trustRoute: 'reject', maintainerDecision: 'merged', mergeCommitSha: SHA_C }),
      entry({ prNumber: 5, trustRoute: 'quick-review' }),
      entry({ prNumber: 6, trustRoute: 'full-review', maintainerDecision: 'closed-unmerged', mergeCommitSha: null }),
      entry({ prNumber: 7, trustRoute: null }),
    ];
    const stats = calculateLedgerStats(entries, { target: 20 });
    expect(stats.routes).toEqual({
      'auto-merge': { total: 2, merged: 1, 'closed-unmerged': 1 },
      'quick-review': { total: 1, merged: 1, 'closed-unmerged': 0 },
      'full-review': { total: 1, merged: 0, 'closed-unmerged': 1 },
      reject: { total: 2, merged: 1, 'closed-unmerged': 1 },
      unclassified: { total: 1, merged: 1, 'closed-unmerged': 0 },
    });
    expect(stats.agreement).toEqual({
      agreeing: 2,
      outcomeBearing: 4,
      agreementRate: 0.5,
      autoMergeDisagreements: 1,
    });
    expect(stats.progress).toEqual({
      target: 20,
      observed: 6,
      remaining: 14,
      thresholdMet: false,
      autoMergeDisagreements: 1,
      zeroAutoMergeDisagreements: false,
      preconditionMet: false,
    });
  });

  test('returns null agreement when there are no outcome-bearing routes', () => {
    const stats = calculateLedgerStats([
      entry({ trustRoute: 'quick-review' }),
      entry({ prNumber: 18, trustRoute: null }),
    ]);
    expect(stats.agreement).toMatchObject({ agreeing: 0, outcomeBearing: 0, agreementRate: null });
    expect(stats.progress.observed).toBe(1);
  });

  test('holds the threshold below 20 and meets it exactly at 20 with no auto-merge disagreements', () => {
    const nineteen = Array.from({ length: 19 }, (_, index) => entry({
      prNumber: index + 1,
      trustRoute: index % 2 === 0 ? 'auto-merge' : 'quick-review',
    }));
    expect(calculateLedgerStats(nineteen).progress).toMatchObject({
      observed: 19,
      remaining: 1,
      thresholdMet: false,
      preconditionMet: false,
    });
    const twenty = [...nineteen, entry({ prNumber: 20, trustRoute: 'reject', maintainerDecision: 'closed-unmerged', mergeCommitSha: null })];
    expect(calculateLedgerStats(twenty).progress).toEqual({
      target: 20,
      observed: 20,
      remaining: 0,
      thresholdMet: true,
      autoMergeDisagreements: 0,
      zeroAutoMergeDisagreements: true,
      preconditionMet: true,
    });
  });

  test('does not meet the precondition at 20 when an auto-merge route was closed unmerged', () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry({
      prNumber: index + 1,
      trustRoute: 'auto-merge',
      maintainerDecision: index === 0 ? 'closed-unmerged' : 'merged',
      mergeCommitSha: index === 0 ? null : SHA_C,
    }));
    expect(calculateLedgerStats(entries).progress).toMatchObject({
      observed: 20,
      thresholdMet: true,
      autoMergeDisagreements: 1,
      zeroAutoMergeDisagreements: false,
      preconditionMet: false,
    });
  });
});

describe('CLI', () => {
  test('appends atomically, validates, calculates stats, and performs idempotent no-ops', async () => {
    const directory = await tempDirectory();
    const file = join(directory, 'decision-ledger.jsonl');
    const candidate = entry();

    const appended = await runCli(['append', '--file', file], JSON.stringify(candidate));
    expect(appended).toEqual({
      exitCode: 0,
      stdout: '{"status":"appended","prNumber":17,"line":1}\n',
      stderr: '',
    });
    expect(await readFile(file, 'utf8')).toBe(serializeLedgerEntry(candidate));

    const validate = await runCli(['validate', '--file', file]);
    expect(validate).toEqual({
      exitCode: 0,
      stdout: '{"valid":true,"entries":1,"schemaVersions":[1]}\n',
      stderr: '',
    });

    const stats = await runCli(['stats', '--file', file, '--target', '1']);
    expect(stats.exitCode).toBe(0);
    expect(JSON.parse(stats.stdout).progress).toMatchObject({ target: 1, observed: 1, preconditionMet: true });

    const same = await runCli(['append', '--file', file], JSON.stringify({ ...candidate, ofmVerdict: 'damage' }));
    expect(JSON.parse(same.stdout)).toEqual({ status: 'already-recorded', prNumber: 17, line: 1 });
    expect(await readFile(file, 'utf8')).toBe(serializeLedgerEntry(candidate));

    const reclosed = await runCli(['append', '--file', file], JSON.stringify(entry({
      timestamps: { closedAt: '2026-08-02T12:00:00Z', recordedAt: '2026-08-02T12:00:15Z' },
    })));
    expect(JSON.parse(reclosed.stdout)).toEqual({ status: 'already-recorded-reclosed', prNumber: 17, line: 1 });
    expect(await readFile(file, 'utf8')).toBe(serializeLedgerEntry(candidate));
  });

  test('derive+append builds from event-shaped stdin and uses the current time when omitted', async () => {
    const directory = await tempDirectory();
    const file = join(directory, 'decision-ledger.jsonl');
    const input = builderInput();
    delete input.recordedAt;
    const before = Date.now();
    const result = await runCli(['derive+append', '--file', file], JSON.stringify(input));
    const after = Date.now();
    expect(result.exitCode).toBe(0);
    const [built] = parseLedgerText(await readFile(file, 'utf8'));
    const recorded = Date.parse(built.timestamps.recordedAt);
    expect(recorded).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(recorded).toBeLessThanOrEqual(Math.floor(after / 1000) * 1000);
  });

  test('fails closed on malformed history and leaves its bytes unchanged', async () => {
    const directory = await tempDirectory();
    const file = join(directory, 'decision-ledger.jsonl');
    const malformed = '{bad}\n';
    await writeFile(file, malformed);
    const result = await runCli(['append', '--file', file], JSON.stringify(entry()));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('malformed-json');
    expect(result.stderr).toContain('line=1');
    expect(await readFile(file, 'utf8')).toBe(malformed);
  });

  test.each([
    ['', 'empty-stdin'],
    ['{} {}', 'invalid-stdin-json'],
    ['null', 'invalid-stdin-json'],
  ])('rejects invalid stdin %p without creating a ledger', async (stdin, code) => {
    const directory = await tempDirectory();
    const file = join(directory, 'decision-ledger.jsonl');
    const result = await runCli(['append', '--file', file], stdin);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(code);
    expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  test('uses exit 3 for an unsupported candidate schema', async () => {
    const directory = await tempDirectory();
    const file = join(directory, 'decision-ledger.jsonl');
    const result = await runCli(['append', '--file', file], JSON.stringify(entry({ schemaVersion: 2 })));
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('unsupported-schema');
  });

  test('uses exit 4 for filesystem failures', async () => {
    const directory = await tempDirectory();
    const file = join(directory, 'missing', 'decision-ledger.jsonl');
    const result = await runCli(['append', '--file', file], JSON.stringify(entry()));
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('filesystem-failure');
  });
});
