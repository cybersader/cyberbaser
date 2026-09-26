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

function hasWritePermission(permissions) {
  if (permissions === 'write-all') return true;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;
  return Object.values(permissions).some((value) => value === 'write' || value === 'write-all');
}

describe('proposal review read-only CI', () => {
  test('uses pinned actions and one package-only test without secrets or mutation', async () => {
    const path = resolve(repositoryRoot, '.github', 'workflows', 'proposal-review.yml');
    const source = await readFile(path, 'utf8');
    const workflow = load(source, { schema: JSON_SCHEMA });
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.on.pull_request).toBeObject();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(hasWritePermission(workflow.permissions)).toBe(false);
    expect(source).not.toMatch(/secrets\./u);
    expect(source).not.toMatch(PUBLICATION_RE);
    expect(Object.keys(workflow.jobs)).toEqual(['test']);

    const job = workflow.jobs.test;
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(10);
    expect(job.steps).toHaveLength(4);
    expect(job.steps[0].uses).toBe(`actions/checkout@${CHECKOUT_SHA}`);
    expect(job.steps[0].with['persist-credentials']).toBe(false);
    expect(job.steps[1].uses).toBe(`oven-sh/setup-bun@${SETUP_BUN_SHA}`);
    expect(job.steps[1].with['bun-version']).toBe('1.3.11');
    expect(job.steps[2].run.trim().split('\n')).toEqual([
      'bun install --cwd packages/ofm --frozen-lockfile',
      'bun install --cwd packages/trust --frozen-lockfile',
      'bun install --cwd packages/proposal --frozen-lockfile',
      'bun install --cwd packages/proposal-queue --frozen-lockfile',
      'bun install --cwd packages/proposal-review --frozen-lockfile',
    ]);
    expect(job.steps[3].run).toBe('bun test packages/proposal-review/test');

    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(IMMUTABLE_ACTION_RE);
      if (step.run) {
        expect(step.run).not.toMatch(REPOSITORY_MUTATION_RE);
        expect(step.run).not.toMatch(PUBLICATION_RE);
      }
    }
  });
});
