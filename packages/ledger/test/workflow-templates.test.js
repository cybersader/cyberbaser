import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';

const packageRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const templatesDirectory = resolve(packageRoot, 'templates');
const capturePath = resolve(templatesDirectory, 'decision-ledger-capture.yml');
const recordPath = resolve(templatesDirectory, 'decision-ledger-record.yml');
const ciPath = resolve(repositoryRoot, '.github/workflows/ledger.yml');

const CHECKOUT_SHA = '11bd71901bbe5b1630ceea73d27597364c9af683';
const UPLOAD_ARTIFACT_SHA = 'ea165f8d65b6e75b540449e92b4886f43607fa02';
const SETUP_BUN_SHA = '735343b667d3e6f658f44d0eca948eb6282f2b76';
const TOOLING_PLACEHOLDER_SHA = '0'.repeat(40);
const IMMUTABLE_ACTION_RE = /^[^\s@]+@[0-9a-f]{40}$/;
const CONTRIBUTOR_CONTEXT_RE = /pull_request\.head|head_ref|workflow_run\.head_sha|pull_request\.head\.repo/i;
const FORCE_PUSH_RE = /git\s+(?:-C\s+\S+\s+)?push\b[^\n]*(?:--force(?:-with-lease)?\b|(?:^|\s)-f(?:\s|$)|(?:^|\s)\+[^\s]+)/im;

async function parseWorkflow(path) {
  const source = await readFile(path, 'utf8');
  const workflow = load(source, { schema: JSON_SCHEMA });
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new TypeError(`${path} must contain one workflow object`);
  }
  return { source, workflow };
}

function parseFixture(source) {
  return load(source, { schema: JSON_SCHEMA });
}

function triggerMap(workflow) {
  return workflow.on && typeof workflow.on === 'object' ? workflow.on : {};
}

function jobEntries(workflow) {
  return Object.entries(workflow.jobs ?? {});
}

function steps(workflow) {
  return jobEntries(workflow).flatMap(([jobName, job]) =>
    (job.steps ?? []).map((step, index) => ({ jobName, index, step })));
}

function hasWritePermission(permissions) {
  if (permissions === 'write-all') return true;
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) return false;
  return Object.values(permissions).some((permission) => permission === 'write' || permission === 'write-all');
}

function collectSafetyViolations(workflow, { allowPullRequestCheckout = false } = {}) {
  const violations = [];
  const triggers = triggerMap(workflow);
  const directPullRequest = Object.hasOwn(triggers, 'pull_request');

  if (Object.hasOwn(triggers, 'pull_request_target')) violations.push('pull-request-target');

  if (directPullRequest) {
    if (hasWritePermission(workflow.permissions)) violations.push('writable-single-stage-pr');
    for (const [, job] of jobEntries(workflow)) {
      if (hasWritePermission(job.permissions)) violations.push('writable-single-stage-pr');
    }
  }

  for (const { step } of steps(workflow)) {
    if (typeof step.uses === 'string') {
      if (!IMMUTABLE_ACTION_RE.test(step.uses)) violations.push('unpinned-action');
      if (step.uses.startsWith('actions/checkout@')) {
        const serializedWith = JSON.stringify(step.with ?? {});
        if ((directPullRequest && !allowPullRequestCheckout) || CONTRIBUTOR_CONTEXT_RE.test(serializedWith)) {
          violations.push('contributor-checkout');
        }
      }
    }
    if (typeof step.run === 'string' && FORCE_PUSH_RE.test(step.run)) violations.push('force-push');
  }

  return [...new Set(violations)];
}

function expectSafe(workflow) {
  expect(collectSafetyViolations(workflow)).toEqual([]);
}

describe('decision-ledger workflow templates', () => {
  test('replace the unsafe single-stage template with exactly two stages', async () => {
    const files = (await readdir(templatesDirectory))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
    expect(files).toEqual([
      'decision-ledger-capture.yml',
      'decision-ledger-record.yml',
    ]);
  });

  test('Stage A is an inert, deterministic, one-day capture', async () => {
    const { workflow } = await parseWorkflow(capturePath);
    expect(workflow.name).toBe('Decision Ledger Capture');
    expect(workflow['run-name']).toBe('Decision Ledger Capture / PR #${{ github.event.pull_request.number }}');
    expect(triggerMap(workflow)).toEqual({ pull_request: { types: ['closed'] } });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(['capture']);

    const job = workflow.jobs.capture;
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(5);
    expect(job.steps).toHaveLength(2);
    expect(job.steps.some((step) => String(step.uses ?? '').startsWith('actions/checkout@'))).toBe(false);

    const create = job.steps[0];
    expect(create.run).toContain('{"schemaVersion":1,"repositoryId":"%s","repository":"%s","sourceRunId":"%s","sourceRunAttempt":%s,"prNumber":%s}');
    expect(create.run).not.toMatch(/\b(?:bun|npm|npx|node|git|curl|wget)\b/);
    for (const authorityField of [
      'trustRoute', 'labels', 'actors', 'decision', 'baseSha', 'headSha', 'mergeCommitSha',
      'timestamps', 'checks', 'ofmVerdict', 'url', 'ref', 'path', 'command', 'refspec',
    ]) {
      expect(create.run).not.toContain(`"${authorityField}"`);
    }

    const upload = job.steps[1];
    expect(upload.uses).toBe(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`);
    expect(upload.with).toEqual({
      name: 'decision-ledger-capture-run-${{ github.run_id }}-pr-${{ github.event.pull_request.number }}',
      path: '${{ runner.temp }}/decision-ledger-capture.json',
      'if-no-files-found': 'error',
      'retention-days': 1,
      'compression-level': 9,
    });
    expectSafe(workflow);
  });

  test('Stage B is exact-run-bound, least-privilege, and non-cancelling repository-wide', async () => {
    const { source, workflow } = await parseWorkflow(recordPath);
    expect(workflow.name).toBe('Decision Ledger Record');
    expect(triggerMap(workflow)).toEqual({
      workflow_run: {
        workflows: ['Decision Ledger Capture'],
        types: ['completed'],
      },
    });
    expect(workflow.permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'write',
      issues: 'read',
      'pull-requests': 'read',
    });
    expect(workflow.concurrency).toEqual({
      group: 'decision-ledger-${{ github.repository_id }}',
      'cancel-in-progress': false,
    });

    const job = workflow.jobs.record;
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(15);
    for (const condition of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'pull_request'",
      "github.event.workflow_run.name == 'Decision Ledger Capture'",
      "github.event.workflow_run.path == '.github/workflows/decision-ledger-capture.yml'",
      'github.event.workflow_run.repository.id == github.event.repository.id',
      'github.event.workflow_run.repository.full_name == github.repository',
      'github.event.workflow_run.id > 0',
      'github.event.workflow_run.run_attempt > 0',
      'github.ref_name == github.event.repository.default_branch',
    ]) {
      expect(job.if).toContain(condition);
    }

    const checkoutSteps = job.steps.filter((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
    expect(checkoutSteps).toHaveLength(2);
    expect(checkoutSteps[0].uses).toBe(`actions/checkout@${CHECKOUT_SHA}`);
    expect(checkoutSteps[0].with).toMatchObject({
      repository: '${{ github.repository }}',
      ref: '${{ github.event.repository.default_branch }}',
      'fetch-depth': 0,
      path: 'vault',
    });
    expect(checkoutSteps[1].uses).toBe(`actions/checkout@${CHECKOUT_SHA}`);
    expect(checkoutSteps[1].with).toEqual({
      repository: 'cybersader/cyberbaser',
      ref: TOOLING_PLACEHOLDER_SHA,
      'fetch-depth': 1,
      path: 'cyberbaser',
      'persist-credentials': false,
    });
    expect(source).toContain('NON-RUNNABLE PLACEHOLDER');
    expect(source).not.toMatch(/\b(?:main|master|latest)\b.*(?:tooling|Cyberbaser)|ref:\s*(?:main|master|latest)\b/i);

    const bun = job.steps.find((step) => String(step.uses ?? '').startsWith('oven-sh/setup-bun@'));
    expect(bun.uses).toBe(`oven-sh/setup-bun@${SETUP_BUN_SHA}`);
    expect(bun.with['bun-version']).toBe('1.3.11');

    const install = job.steps.find((step) => step.name === 'Install locked ledger dependency closure');
    expect(install.run.trim().split('\n')).toEqual([
      'bun install --cwd cyberbaser/packages/ofm --frozen-lockfile',
      'bun install --cwd cyberbaser/packages/trust --frozen-lockfile',
      'bun install --cwd cyberbaser/packages/ledger --frozen-lockfile',
    ]);

    const record = job.steps.find((step) => step.run?.includes('cb-decision-ledger-github.js record'));
    expect(record).toBeDefined();
    expect(record.env.SOURCE_RUN_ID).toBe('${{ github.event.workflow_run.id }}');
    expect(record.env.SOURCE_RUN_ATTEMPT).toBe('${{ github.event.workflow_run.run_attempt }}');
    expect(record.run).toContain('--event "$GITHUB_EVENT_PATH"');
    expect(record.run).toContain('--run-id "$SOURCE_RUN_ID"');
    expect(record.run).toContain('--run-attempt "$SOURCE_RUN_ATTEMPT"');
    expect(record.run).toContain('--repository-id "$EXPECTED_REPOSITORY_ID"');
    expect(record.run).toContain('--repository "$EXPECTED_REPOSITORY"');
    expect(job.steps.some((step) => String(step.uses ?? '').startsWith('actions/download-artifact@'))).toBe(false);
    expectSafe(workflow);
  });
});

describe('workflow safety regression checks', () => {
  test('reject pull_request_target', () => {
    const workflow = parseFixture(`
name: unsafe
on:
  pull_request_target:
jobs: {}
`);
    expect(collectSafetyViolations(workflow)).toContain('pull-request-target');
  });

  test('reject a writable single-stage pull_request workflow', () => {
    const workflow = parseFixture(`
name: unsafe
on:
  pull_request:
permissions:
  contents: write
jobs:
  record:
    steps:
      - run: bun ledger.js append
`);
    expect(collectSafetyViolations(workflow)).toContain('writable-single-stage-pr');
  });

  test('reject contributor checkout', () => {
    const workflow = parseFixture(`
name: unsafe
on:
  pull_request:
permissions: {}
jobs:
  capture:
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
`);
    expect(collectSafetyViolations(workflow)).toContain('contributor-checkout');
  });

  test('reject unpinned actions', () => {
    const workflow = parseFixture(`
name: unsafe
on:
  workflow_dispatch:
jobs:
  test:
    steps:
      - uses: actions/upload-artifact@v4
`);
    expect(collectSafetyViolations(workflow)).toContain('unpinned-action');
  });

  test('reject force pushes', () => {
    const workflow = parseFixture(`
name: unsafe
on:
  workflow_dispatch:
jobs:
  record:
    steps:
      - run: git push --force origin HEAD:main
`);
    expect(collectSafetyViolations(workflow)).toContain('force-push');
  });

  test('all installed ledger workflows stay read-only and pinned', async () => {
    const { workflow } = await parseWorkflow(ciPath);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(hasWritePermission(workflow.permissions)).toBe(false);
    expect(workflow.jobs.test['timeout-minutes']).toBeLessThanOrEqual(15);
    expect(workflow.jobs.test.steps[0].uses).toBe(`actions/checkout@${CHECKOUT_SHA}`);
    expect(workflow.jobs.test.steps[0].with['persist-credentials']).toBe(false);
    expect(workflow.jobs.test.steps[1].uses).toBe(`oven-sh/setup-bun@${SETUP_BUN_SHA}`);
    expect(workflow.jobs.test.steps[1].with['bun-version']).toBe('1.3.11');
    expect(workflow.jobs.test.steps[2].run.trim().split('\n')).toEqual([
      'bun install --cwd packages/ofm --frozen-lockfile',
      'bun install --cwd packages/trust --frozen-lockfile',
      'bun install --cwd packages/ledger --frozen-lockfile',
    ]);
    expect(workflow.jobs.test.steps.at(-1).run).toBe('bun test packages/ledger/test');
    expect(collectSafetyViolations(workflow, { allowPullRequestCheckout: true })).toEqual([]);
  });
});
