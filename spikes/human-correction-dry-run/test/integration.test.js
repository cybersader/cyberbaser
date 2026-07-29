import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC_CASE, SYNTHETIC_OWNER_POLICY, runSyntheticVerification, syntheticVerificationJson } from '../src/verification.js';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('authoritative synthetic integration', () => {
  test('passes every named deterministic criterion', async () => {
    const report = await runSyntheticVerification();
    expect(report.complete).toBe(true);
    expect(report.checks).toHaveLength(11);
    expect(report.checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  test('produces byte-identical deterministic verifier JSON', async () => {
    expect(await syntheticVerificationJson()).toBe(await syntheticVerificationJson());
  });

  test('bin/verify.js emits the authoritative report and exits zero', async () => {
    const process = Bun.spawn(['bun', 'run', 'bin/verify.js'], {
      cwd: projectDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, NO_COLOR: '1' },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout).complete).toBe(true);
  });

  test('dry-run CLI accepts a caller-supplied local checkout and writes nothing', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'correction-cli-'));
    temporaryDirectories.push(temp);
    const caseFile = path.join(temp, 'case.json');
    const policyFile = path.join(temp, 'policy.json');
    await writeFile(caseFile, JSON.stringify(SYNTHETIC_CASE), 'utf8');
    await writeFile(policyFile, JSON.stringify(SYNTHETIC_OWNER_POLICY), 'utf8');

    const process = Bun.spawn([
      'bun', 'run', 'bin/dry-run.js',
      '--checkout', fixturesDir,
      '--case', caseFile,
      '--policy', policyFile,
      '--policy-revision', 'cli-policy-v1',
      '--format', 'json',
    ], {
      cwd: projectDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, NO_COLOR: '1' },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const evidence = JSON.parse(stdout);
    expect(evidence.status).toContain('no source write');
    expect(evidence.trust.policyRevision).toBe('cli-policy-v1');
    expect(stdout).not.toContain(SYNTHETIC_CASE.sourcePath);
    expect(stdout).not.toContain(fixturesDir);
  });
});
