import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';

const repositoryRoot = resolve(import.meta.dir, '..', '..', '..');
const workflowPath = resolve(repositoryRoot, '.github/workflows/forgejo-intake.yml');
const IMMUTABLE_ACTION_RE = /^[^\s@]+@[0-9a-f]{40}$/u;
const MUTATION_RE = /\b(?:POST|PUT|PATCH|DELETE)\b|\bgit\s+(?:push|merge|reset|checkout|switch|commit|tag)\b/iu;
const PUBLICATION_RE = /upload-artifact|deploy-pages|create-release|publish|docker\s+push/iu;

function hasWritePermission(permissions) {
  if (permissions === 'write-all') return true;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;
  return Object.values(permissions).some((value) => value === 'write' || value === 'write-all');
}

test('Forgejo intake CI remains one read-only pinned package test', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const workflow = load(source, { schema: JSON_SCHEMA });
  expect(workflow).toBeObject();
  expect(workflow.on.pull_request_target).toBeUndefined();
  expect(workflow.on.pull_request).toBeObject();
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(hasWritePermission(workflow.permissions)).toBe(false);
  expect(Object.keys(workflow.jobs)).toEqual(['test']);

  const job = workflow.jobs.test;
  expect(hasWritePermission(job.permissions)).toBe(false);
  expect(job['timeout-minutes']).toBe(10);
  expect(job.steps).toHaveLength(4);
  for (const step of job.steps) {
    if (step.uses) expect(step.uses).toMatch(IMMUTABLE_ACTION_RE);
    if (step.run) {
      expect(step.run).not.toMatch(MUTATION_RE);
      expect(step.run).not.toMatch(PUBLICATION_RE);
    }
  }

  expect(job.steps[0].uses).toBe('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683');
  expect(job.steps[0].with['persist-credentials']).toBe(false);
  expect(job.steps[1].uses).toBe('oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76');
  expect(job.steps[1].with['bun-version']).toBe('1.3.11');
  expect(job.steps[2].run.trim().split('\n')).toEqual([
    'bun install --cwd packages/ofm --frozen-lockfile',
    'bun install --cwd packages/trust --frozen-lockfile',
    'bun install --cwd packages/proposal --frozen-lockfile',
    'bun install --cwd packages/forgejo-intake --frozen-lockfile',
  ]);
  expect(job.steps[3].run).toBe('bun test packages/forgejo-intake/test');
  expect(source).not.toMatch(/secrets\./u);
  expect(source).not.toMatch(PUBLICATION_RE);
});
