import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';

const repositoryRoot = resolve(import.meta.dir, '..', '..', '..');
const CHECKOUT_SHA = '11bd71901bbe5b1630ceea73d27597364c9af683';
const SETUP_BUN_SHA = '735343b667d3e6f658f44d0eca948eb6282f2b76';
const RUST_TOOLCHAIN_SHA = '6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772';
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

function expectInstallClosure(step, packages) {
  expect(step.run.trim().split('\n')).toEqual(packages.map(
    (name) => `bun install --cwd ${name} --frozen-lockfile`,
  ));
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
    expectInstallClosure(job.steps[2], [
      'packages/ofm',
      'packages/trust',
      'packages/proposal',
      'packages/proposal-queue',
    ]);
    expect(job.steps[3].run).toBe('bun test packages/proposal-queue/test');
  });

  test('account-free CI tests package, app, and disabled renderer layers without publishing', async () => {
    const { source, workflow } = await parseWorkflow('account-free-intake.yml');
    expectReadOnlyWorkflow(source, workflow);
    expect(Object.keys(workflow.jobs)).toEqual(['test']);

    const job = workflow.jobs.test;
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(15);
    expect(job.steps).toHaveLength(7);
    expectPinnedBootstrap(job);
    expectInstallClosure(job.steps[2], [
      'packages/ofm',
      'packages/trust',
      'packages/proposal',
      'packages/proposal-queue',
      'packages/account-free-intake',
      'apps/account-free-intake',
    ]);

    const runs = job.steps.map((step) => step.run).filter(Boolean);
    for (const command of [
      'bun test packages/proposal-queue/test',
      'bun test packages/account-free-intake/test',
      'bun test apps/account-free-intake/test',
      'bash renderers/quartz-cyberbase/tests/run.sh',
    ]) expect(runs).toContain(command);
    expect(source).not.toMatch(/\b(?:docker|curl|wget)\b/iu);
  });

  test('Iroh fixture CI uses pinned local-only Rust and Bun verification without publishing', async () => {
    const { source, workflow } = await parseWorkflow('iroh-proposal-transfer.yml');
    expectReadOnlyWorkflow(source, workflow);
    expect(Object.keys(workflow.jobs)).toEqual(['verify']);

    const job = workflow.jobs.verify;
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(15);
    expect(job.steps).toHaveLength(8);
    expectPinnedBootstrap(job);
    expect(job.steps[2].uses).toBe(`dtolnay/rust-toolchain@${RUST_TOOLCHAIN_SHA}`);
    expect(job.steps[2].with.toolchain).toBe('1.97.1');

    expectInstallClosure(job.steps[3], [
      'packages/ofm',
      'packages/trust',
      'packages/proposal',
      'packages/proposal-queue',
      'spikes/iroh-proposal-transfer',
    ]);
    const runs = job.steps.map((step) => step.run).filter(Boolean);
    for (const command of [
      'cargo test --locked --manifest-path spikes/iroh-proposal-transfer/Cargo.toml',
      'bun test spikes/iroh-proposal-transfer/test',
      'bun test packages/proposal-queue/test/ci-structure.test.js',
      'bun run spikes/iroh-proposal-transfer/bin/verify.js',
    ]) expect(runs).toContain(command);
    expect(source).not.toMatch(/secrets\.|services:|upload-artifact|deploy-pages|docker|curl|wget/iu);
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

    expectInstallClosure(job.steps[2], [
      'packages/ofm',
      'packages/trust',
      'packages/proposal',
      'packages/proposal-queue',
      'packages/account-free-intake',
      'apps/account-free-intake',
    ]);
    const runs = job.steps.map((step) => step.run).filter(Boolean);
    expect(runs).toContain('bun test deploy/account-free-intake/test');
    expect(runs).toContain('docker build --progress=plain --file deploy/account-free-intake/Containerfile --tag cyberbaser-account-free-intake:ci .');
    expect(runs).toContain('bun test deploy/account-free-intake/test/runtime-acceptance.test.js');
    expect(source).toContain('ACCOUNT_FREE_INTAKE_CONTAINER_IMAGE');
    expect(source).not.toMatch(/\b(?:push|login)\b[^\n]*docker|docker[^\n]*\b(?:push|login)\b/iu);
    expect(source).not.toMatch(/\b(?:curl|wget)\b/iu);
  });
});
