import { describe, expect, test } from 'bun:test';
import {
  CAPTURE_HINT_FILENAME,
  CAPTURE_HINT_SCHEMA_VERSION,
  CAPTURE_WORKFLOW_PATH,
  LedgerError,
  LedgerGithubError,
  captureArtifactName,
  captureRunName,
  reconstructClosedUnmergedActor,
  reconstructLedgerEntry,
  reconstructLedgerInput,
  serializeCaptureHint,
} from '../src/index.js';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const MERGE_SHA = '3'.repeat(40);
const RUN_SHA = '4'.repeat(40);
const ARCHIVE_BYTES = Buffer.from('zipbytes');

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
    head_sha: RUN_SHA,
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
    size_in_bytes: ARCHIVE_BYTES.length,
    workflow_run: { id: 987654321, repository_id: 123456789 },
  };
  return {
    ...base,
    ...overrides,
    workflow_run: { ...base.workflow_run, ...(overrides.workflow_run ?? {}) },
  };
}

function pullRequest(overrides = {}) {
  const base = {
    number: 42,
    state: 'closed',
    merged: true,
    user: { login: 'helper-bot', type: 'User' },
    created_at: '2026-08-03T10:00:00Z',
    closed_at: '2026-08-03T11:00:00Z',
    merged_at: '2026-08-03T11:00:00Z',
    merged_by: { login: 'maintainer' },
    merge_commit_sha: MERGE_SHA,
    base: {
      sha: BASE_SHA,
      ref: 'main',
      repo: { id: 123456789, full_name: 'example/example-wiki' },
    },
    head: {
      sha: HEAD_SHA,
      ref: 'change',
      repo: { id: 555, full_name: 'contributor/fork' },
    },
    labels: [{ name: 'trust:reject' }],
  };
  return {
    ...base,
    ...overrides,
    user: overrides.user === null ? null : { ...base.user, ...(overrides.user ?? {}) },
    merged_by: overrides.merged_by === null ? null : { ...base.merged_by, ...(overrides.merged_by ?? {}) },
    base: {
      ...base.base,
      ...(overrides.base ?? {}),
      repo: { ...base.base.repo, ...(overrides.base?.repo ?? {}) },
    },
    head: {
      ...base.head,
      ...(overrides.head ?? {}),
      repo: { ...base.head.repo, ...(overrides.head?.repo ?? {}) },
    },
  };
}

function apiFixture(overrides = {}) {
  const calls = [];
  const values = {
    sourceRun: sourceRun(),
    artifacts: [artifact()],
    pullRequest: pullRequest(),
    labels: [{ id: 1, name: 'trust:quick-review' }],
    checkRuns: [
      {
        id: 10,
        name: 'ofm-check',
        app: { slug: 'github-actions' },
        status: 'completed',
        conclusion: 'failure',
      },
      {
        id: 11,
        name: 'ofm-check',
        app: { slug: 'github-actions' },
        status: 'completed',
        conclusion: 'success',
      },
    ],
    timeline: [{ event: 'closed', created_at: '2026-08-03T11:00:00.500Z', actor: { login: 'maintainer' } }],
    permission: { permission: 'write', role_name: 'maintain', user: { login: 'maintainer' } },
    archive: ARCHIVE_BYTES,
    ...overrides,
  };
  return {
    calls,
    values,
    api: {
      async getJson(endpoint) {
        calls.push(['getJson', endpoint]);
        if (endpoint.endsWith('/actions/runs/987654321')) return values.sourceRun;
        if (endpoint.endsWith('/pulls/42')) return values.pullRequest;
        if (endpoint.includes('/collaborators/')) return values.permission;
        throw new Error(`unexpected getJson ${endpoint}`);
      },
      async getBytes(endpoint, options) {
        calls.push(['getBytes', endpoint, options]);
        return values.archive;
      },
      async paginate(endpoint, options) {
        calls.push(['paginate', endpoint, options]);
        if (endpoint.endsWith('/actions/runs/987654321/artifacts')) return values.artifacts;
        if (endpoint.endsWith('/issues/42/labels')) return values.labels;
        if (endpoint.includes('/commits/') && endpoint.endsWith('/check-runs')) return values.checkRuns;
        if (endpoint.endsWith('/issues/42/timeline')) return values.timeline;
        throw new Error(`unexpected paginate ${endpoint}`);
      },
    },
  };
}

function fakeGit({ policy = 'agents:\n  - helper-bot\n', before, after } = {}) {
  const baseText = before ?? '# Note\n\nKeep [[Target]].\n';
  const headText = after ?? '# Note\n\nKeep [[Target]]!\n';
  return async (args) => {
    const [command, ...rest] = args;
    if (command === 'fetch') return Buffer.alloc(0);
    if (command === 'rev-parse') {
      const ref = rest.at(-1);
      if (ref.includes('/base')) return Buffer.from(`${BASE_SHA}\n`);
      if (ref.includes('/head')) return Buffer.from(`${HEAD_SHA}\n`);
      if (ref.includes('/merge')) return Buffer.from(`${MERGE_SHA}\n`);
    }
    if (command === 'cat-file' && rest[0] === '-t') {
      const object = rest[1];
      if ([BASE_SHA, HEAD_SHA, MERGE_SHA].includes(object)) return Buffer.from('commit\n');
      if (object.includes(':')) return Buffer.from('blob\n');
    }
    if (command === 'cat-file' && rest[0] === '-p') {
      const object = rest[1];
      if (object === `${BASE_SHA}:.cyberbaser/trust.yml`) return Buffer.from(policy);
      if (object === `${BASE_SHA}:docs/note.md`) return Buffer.from(baseText);
      if (object === `${HEAD_SHA}:docs/note.md`) return Buffer.from(headText);
    }
    if (command === 'diff') return Buffer.from(`M\0docs/note.md\0`);
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function extractor(value = hint()) {
  return async () => [{ name: CAPTURE_HINT_FILENAME, data: Buffer.from(serializeCaptureHint(value)) }];
}

function options(fixture, overrides = {}) {
  return {
    api: fixture.api,
    expectedRepository: { repositoryId: '123456789', repository: 'example/example-wiki' },
    workflowRun: overrides.workflowRun ?? sourceRun(),
    extractArtifactEntries: overrides.extractArtifactEntries ?? extractor(),
    git: overrides.git ?? fakeGit(),
    recordedAt: '2026-08-03T12:00:00Z',
    ...overrides,
  };
}

async function expectAsyncError(promise, code, ErrorType = LedgerGithubError) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorType);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ${ErrorType.name}(${code})`);
}

describe('trusted workflow-run and artifact reconstruction', () => {
  test('accepts empty workflow_run.pull_requests and returns canonical schema-v1 entry', async () => {
    const fixture = apiFixture();
    const entry = await reconstructLedgerEntry(options(fixture));
    expect(entry).toEqual({
      schemaVersion: 1,
      prNumber: 42,
      author: 'helper-bot',
      authorType: 'agent',
      trustRoute: 'quick-review',
      ofmVerdict: 'clean',
      checks: [{
        name: 'ofm-check',
        appSlug: 'github-actions',
        status: 'completed',
        conclusion: 'success',
      }],
      maintainerDecision: 'merged',
      mergeCommitSha: MERGE_SHA,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      timestamps: {
        openedAt: '2026-08-03T10:00:00Z',
        closedAt: '2026-08-03T11:00:00Z',
        recordedAt: '2026-08-03T12:00:00Z',
      },
    });
    expect(fixture.calls).toContainEqual([
      'getBytes',
      '/repos/example/example-wiki/actions/artifacts/222/zip',
      { maxBytes: 16384, redirect: 'follow' },
    ]);
    expect(fixture.calls.some(([, endpoint]) => endpoint.endsWith(`/commits/${RUN_SHA}/pulls`))).toBe(false);
    expect(fixture.calls).toContainEqual([
      'paginate',
      `/repos/example/example-wiki/commits/${HEAD_SHA}/check-runs`,
      { itemsKey: 'check_runs', totalKey: 'total_count' },
    ]);
    expect(fixture.calls.some(([, endpoint]) => endpoint.endsWith('/timeline'))).toBe(false);
  });

  test('accepts exactly one matching pull request in both event and refetched run', async () => {
    const matching = sourceRun({ pull_requests: [{ number: 42 }] });
    const fixture = apiFixture({ sourceRun: matching });
    expect((await reconstructLedgerEntry(options(fixture, { workflowRun: matching }))).prNumber).toBe(42);
    expect(fixture.calls.some(([, endpoint]) => endpoint.endsWith(`/commits/${RUN_SHA}/pulls`))).toBe(false);
  });

  test.each([
    ['event conflict', sourceRun({ pull_requests: [{ number: 43 }] }), sourceRun(), 'source-run-pull-request-mismatch'],
    ['refetched conflict', sourceRun(), sourceRun({ pull_requests: [{ number: 43 }] }), 'source-run-pull-request-mismatch'],
    ['event ambiguity', sourceRun({ pull_requests: [{ number: 42 }, { number: 42 }] }), sourceRun(), 'ambiguous-source-pull-requests'],
  ])('fails closed on conflicting workflow_run.pull_requests: %s', async (_, workflowRun, fetched, code) => {
    const fixture = apiFixture({ sourceRun: fetched });
    await expectAsyncError(reconstructLedgerEntry(options(fixture, { workflowRun })), code);
    expect(fixture.calls.some(([method]) => method === 'getBytes')).toBe(false);
  });

  test('fails closed when event and refetched source-run head SHAs differ', async () => {
    const fixture = apiFixture({ sourceRun: sourceRun({ head_sha: '5'.repeat(40) }) });
    await expectAsyncError(
      reconstructLedgerEntry(options(fixture, { workflowRun: sourceRun() })),
      'source-run-head-sha-mismatch',
    );
    expect(fixture.calls.some(([method, endpoint]) => (
      method === 'paginate' && endpoint.endsWith('/issues/42/labels')
    ))).toBe(false);
  });

  test.each([
    ['workflow path', { path: '.github/workflows/other.yml' }, 'untrusted-source-workflow'],
    ['workflow attempt', { run_attempt: 3 }, 'source-run-attempt-mismatch'],
    ['workflow conclusion', { conclusion: 'failure' }, 'unsuccessful-source-run'],
    ['workflow repository', { repository: { full_name: 'example/other' } }, 'source-run-repository-mismatch'],
  ])('verifies exact refetched source-run %s before artifact download', async (_, runOverrides, code) => {
    const fixture = apiFixture({ sourceRun: sourceRun(runOverrides) });
    await expectAsyncError(reconstructLedgerEntry(options(fixture)), code);
    expect(fixture.calls.some(([method]) => method === 'getBytes')).toBe(false);
  });

  test('requires one artifact and exact metadata/content size and routing agreement', async () => {
    for (const [fixture, overrideOptions, code] of [
      [apiFixture({ artifacts: [] }), {}, 'missing-capture-artifact'],
      [apiFixture({ artifacts: [artifact(), artifact({ id: 223 })] }), {}, 'multiple-capture-artifacts'],
      [apiFixture({ archive: Buffer.from('short') }), {}, 'artifact-size-mismatch'],
      [apiFixture(), { extractArtifactEntries: extractor(hint({ prNumber: 43 })) }, 'artifact-name-mismatch'],
    ]) {
      await expectAsyncError(reconstructLedgerEntry(options(fixture, overrideOptions)), code);
    }
  });
});

describe('authoritative PR governance reconstruction', () => {
  test('uses paginated issue labels instead of mutable labels embedded in the PR response', async () => {
    const fixture = apiFixture({
      pullRequest: pullRequest({ labels: [{ name: 'trust:reject' }] }),
      labels: [{ name: 'trust:auto-merge' }],
    });
    expect((await reconstructLedgerEntry(options(fixture))).trustRoute).toBe('auto-merge');
  });

  test.each(['waiting', 'requested', 'pending'])(
    'records legal incomplete GitHub check-run status %s',
    async (status) => {
      const fixture = apiFixture({
        checkRuns: [{
          id: 12,
          name: 'protected-deploy',
          app: { slug: 'github-actions' },
          status,
          conclusion: null,
        }],
      });
      expect((await reconstructLedgerEntry(options(fixture))).checks).toEqual([{
        name: 'protected-deploy',
        appSlug: 'github-actions',
        status,
        conclusion: null,
      }]);
    },
  );

  test('rejects PR number/repository mismatch and contradictory authoritative labels', async () => {
    const cases = [
      [apiFixture({ pullRequest: pullRequest({ number: 43 }) }), 'pull-request-number-mismatch', LedgerGithubError],
      [apiFixture({ pullRequest: pullRequest({ base: { repo: { id: 999 } } }) }), 'pull-request-repository-mismatch', LedgerGithubError],
      [apiFixture({ labels: [{ name: 'trust:auto-merge' }, { name: 'trust:reject' }] }), 'contradictory-trust-labels', LedgerError],
    ];
    for (const [fixture, code, ErrorType] of cases) {
      await expectAsyncError(reconstructLedgerEntry(options(fixture)), code, ErrorType);
    }
  });

  test('uses merged_by and verifies its current collaborator permission', async () => {
    const fixture = apiFixture({
      timeline: [{ event: 'closed', created_at: '2026-08-03T11:00:00Z', actor: { login: 'wrong' } }],
      permission: { permission: 'admin', role_name: 'admin', user: { login: 'maintainer' } },
    });
    const input = await reconstructLedgerInput(options(fixture));
    expect(input.event.sender.login).toBe('maintainer');
    expect(input.decisionActorPermission).toBe('admin');
    expect(fixture.calls).toContainEqual([
      'getJson',
      '/repos/example/example-wiki/collaborators/maintainer/permission',
    ]);
  });

  test('recognizes GitHub built-in Maintain through role_name despite legacy write permission', async () => {
    const fixture = apiFixture({
      permission: {
        permission: 'write',
        role_name: 'maintain',
        user: { login: 'maintainer' },
      },
    });
    const input = await reconstructLedgerInput(options(fixture));
    expect(input.decisionActorPermission).toBe('maintain');
    expect((await reconstructLedgerEntry(options(apiFixture({ permission: fixture.values.permission })))).prNumber).toBe(42);
  });

  test('rejects mismatched or insufficient actor permission', async () => {
    const mismatch = apiFixture({ permission: { permission: 'admin', user: { login: 'other' } } });
    await expectAsyncError(reconstructLedgerEntry(options(mismatch)), 'permission-actor-mismatch');

    const insufficient = apiFixture({
      permission: { permission: 'write', role_name: 'write', user: { login: 'maintainer' } },
    });
    await expectAsyncError(
      reconstructLedgerEntry(options(insufficient)),
      'decision-actor-not-maintainer',
      LedgerError,
    );
  });

  test('reconstructs a closed-unmerged actor from the unique matching timeline close event', async () => {
    const unmerged = pullRequest({
      merged: false,
      merged_at: null,
      merged_by: null,
      merge_commit_sha: null,
    });
    const fixture = apiFixture({
      pullRequest: unmerged,
      timeline: [
        { event: 'closed', created_at: '2026-08-02T09:00:00Z', actor: { login: 'older-actor' } },
        { event: 'reopened', created_at: '2026-08-03T10:30:00Z', actor: { login: 'helper-bot' } },
        { event: 'closed', created_at: '2026-08-03T11:00:00.900Z', actor: { login: 'maintainer' } },
      ],
    });
    const entry = await reconstructLedgerEntry(options(fixture));
    expect(entry.maintainerDecision).toBe('closed-unmerged');
    expect(entry.mergeCommitSha).toBeNull();
    expect(fixture.calls).toContainEqual([
      'paginate',
      '/repos/example/example-wiki/issues/42/timeline',
      { accept: 'application/vnd.github+json' },
    ]);
  });

  test('fails closed when the matching closed-unmerged actor is missing or ambiguous', async () => {
    const unmerged = pullRequest({ merged: false, merged_at: null, merged_by: null, merge_commit_sha: null });
    for (const [timeline, code] of [
      [[{ event: 'closed', created_at: '2026-08-02T11:00:00Z', actor: { login: 'maintainer' } }], 'missing-close-actor'],
      [[
        { event: 'closed', created_at: '2026-08-03T11:00:00Z', actor: { login: 'maintainer' } },
        { event: 'closed', created_at: '2026-08-03T11:00:00.500Z', actor: { login: 'other-maintainer' } },
      ], 'ambiguous-close-actor'],
    ]) {
      const fixture = apiFixture({ pullRequest: unmerged, timeline });
      await expectAsyncError(reconstructLedgerEntry(options(fixture)), code);
    }
  });

  test('closed-unmerged actor helper rejects malformed timeline evidence directly', () => {
    for (const [timeline, code] of [
      [null, 'invalid-timeline-response'],
      [[{ event: 'closed', created_at: 'not-a-date', actor: { login: 'maintainer' } }], 'invalid-timestamp'],
      [[{ event: 'closed', created_at: '2026-08-03T11:00:00Z', actor: {} }], 'invalid-string'],
    ]) {
      try {
        reconstructClosedUnmergedActor(timeline, '2026-08-03T11:00:00Z');
      } catch (error) {
        if (code === 'invalid-timestamp') {
          expect(error).toBeInstanceOf(LedgerError);
        } else {
          expect(error).toBeInstanceOf(LedgerGithubError);
        }
        expect(error.code).toBe(code);
      }
    }
  });
});
