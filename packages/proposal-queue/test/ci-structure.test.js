import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';

const repositoryRoot = resolve(import.meta.dir, '..', '..', '..');
const CHECKOUT_SHA = '11bd71901bbe5b1630ceea73d27597364c9af683';
const SETUP_BUN_SHA = '735343b667d3e6f658f44d0eca948eb6282f2b76';
const IMMUTABLE_ACTION_RE = /^[^\s@]+@[0-9a-f]{40}$/u;
const REPOSITORY_MUTATION_RE = /\b(?:POST|PUT|PATCH|DELETE)\b|\bgit\s+(?:push|merge|reset|checkout|switch|commit|tag)\b/iu;
const PUBLICATION_RE = /upload-artifact|deploy-pages|create-release|docker\s+push/iu;

async function parseWorkflow(name) {
  const path = resolve(repositoryRoot, '.github', 'workflows', name);
  const source = await readFile(path, 'utf8');
  const workflow = load(source, { schema: JSON_SCHEMA });
  expect(workflow).toBeObject();
  return { source, workflow };
}

function hasWritePermission(permissions) {
  if (permissions === 'write-all') return true;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;
  return Object.values(permissions).some((value) => value === 'write' || value === 'write-all');
}

function expectReadOnlyWorkflow(source, workflow) {
  expect(workflow.on.pull_request_target).toBeUndefined();
  expect(workflow.on.pull_request).toBeObject();
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(hasWritePermission(workflow.permissions)).toBe(false);
  expect(source).not.toMatch(/secrets\./u);
  expect(source).not.toMatch(PUBLICATION_RE);

  for (const job of Object.values(workflow.jobs)) {
    expect(hasWritePermission(job.permissions)).toBe(false);
    for (const step of job.steps ?? []) {
      if (step.uses) expect(step.uses).toMatch(IMMUTABLE_ACTION_RE);
      if (step.run) {
        expect(step.run).not.toMatch(REPOSITORY_MUTATION_RE);
        expect(step.run).not.toMatch(PUBLICATION_RE);
      }
    }
  }
}

function expectPinnedBootstrap(job) {
  expect(job.steps[0].uses).toBe(`actions/checkout@${CHECKOUT_SHA}`);
  expect(job.steps[0].with['persist-credentials']).toBe(false);
  expect(job.steps[1].uses).toBe(`oven-sh/setup-bun@${SETUP_BUN_SHA}`);
  expect(job.steps[1].with['bun-version']).toBe('1.3.11');
}

describe('WP4 read-only CI structure', () => {
  test('proposal queue CI remains one pinned package-only test', async () => {
    const { source, workflow } = await parseWorkflow('proposal-queue.yml');
    expectReadOnlyWorkflow(source, workflow);
    expect(Object.keys(workflow.jobs)).toEqual(['test']);

    const job = workflow.jobs.test;
    expect(job['timeout-minutes']).toBe(10);
    expect(job.steps).toHaveLength(4);
    expectPinnedBootstrap(job);
    expect(job.steps[2].run).toBe('bun install --cwd packages/proposal-queue --frozen-lockfile');
    expect(job.steps[3].run).toBe('bun test packages/proposal-queue/test');
  });

  test('account-free CI tests package, app, and disabled renderer layers without publishing', async () => {
    const { source, workflow } = await parseWorkflow('account-free-intake.yml');
    expectReadOnlyWorkflow(source, workflow);
    expect(Object.keys(workflow.jobs)).toEqual(['test']);

    const job = workflow.jobs.test;
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(15);
    expect(job.steps).toHaveLength(9);
    expectPinnedBootstrap(job);

    const runs = job.steps.map((step) => step.run).filter(Boolean);
    for (const command of [
      'bun install --cwd packages/proposal-queue --frozen-lockfile',
      'bun install --cwd packages/account-free-intake --frozen-lockfile',
      'bun install --cwd apps/account-free-intake --frozen-lockfile',
      'bun test packages/proposal-queue/test',
      'bun test packages/account-free-intake/test',
      'bun test apps/account-free-intake/test',
      'bash renderers/quartz-cyberbase/tests/run.sh',
    ]) expect(runs).toContain(command);
    expect(source).not.toMatch(/\b(?:docker|curl|wget)\b/iu);
  });

  test('account-free container CI builds and accepts locally without publishing', async () => {
    const { source, workflow } = await parseWorkflow('account-free-intake-container.yml');
    expectReadOnlyWorkflow(source, workflow);
    expect(Object.keys(workflow.jobs)).toEqual(['verify']);

    const job = workflow.jobs.verify;
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(30);
    expect(job.steps).toHaveLength(7);
    expectPinnedBootstrap(job);

    const runs = job.steps.map((step) => step.run).filter(Boolean);
    expect(runs).toContain('bun install --cwd apps/account-free-intake --frozen-lockfile');
    expect(runs).toContain('bun test deploy/account-free-intake/test');
    expect(runs).toContain('docker build --progress=plain --file deploy/account-free-intake/Containerfile --tag cyberbaser-account-free-intake:ci .');
    expect(runs).toContain('bun test deploy/account-free-intake/test/runtime-acceptance.test.js');
    expect(source).toContain('ACCOUNT_FREE_INTAKE_CONTAINER_IMAGE');
    expect(source).not.toMatch(/\b(?:push|login)\b[^\n]*docker|docker[^\n]*\b(?:push|login)\b/iu);
    expect(source).not.toMatch(/\b(?:curl|wget)\b/iu);
  });
});
