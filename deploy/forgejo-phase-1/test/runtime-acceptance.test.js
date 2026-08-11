import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const HARNESS = path.join(ROOT, 'deploy', 'forgejo-phase-1', 'src', 'harness.js');
const REQUIRED = [
  'OWNER_ALPHA_REAL_FORGEJO',
  'WP3_FORGEJO_IMAGE',
  'WP3_FORGEJO_RUNNER',
  'WP3_FORGEJO_RUNNER_SHA256',
];
const enabled = REQUIRED.every((name) => typeof process.env[name] === 'string' && process.env[name].length > 0)
  && process.env.OWNER_ALPHA_REAL_FORGEJO === '1';
const realTest = enabled ? test : test.skip;

describe('WP3 disposable Forgejo Actions acceptance', () => {
  test('skips without all four exact opt-in inputs and performs no Docker work', () => {
    const env = { ...process.env };
    for (const name of REQUIRED) delete env[name];
    const result = Bun.spawnSync({
      cmd: [process.execPath, HARNESS],
      cwd: ROOT,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      status: 'skipped',
      reason: 'OWNER_ALPHA_REAL_FORGEJO is not 1',
    });
  });

  test('refuses a fully supplied opt-in gate before lock or run-root when the pinned image is not staged', async () => {
    const fixture = `/tmp/wp3-fake-engine-${process.pid}-${randomUUID()}`;
    const runner = path.join(fixture, 'runner');
    const docker = path.join(fixture, 'docker');
    const bytes = '#!/usr/bin/env bash\nexit 0\n';
    await mkdir(fixture, { mode: 0o700 });
    await writeFile(runner, bytes, { mode: 0o700, flag: 'wx' });
    await writeFile(docker, `#!/usr/bin/env bash\nif [[ "\${1:-}" == "info" ]]; then printf '%s\\n' '["name=rootless"]'; exit 0; fi\nexit 1\n`, { mode: 0o700, flag: 'wx' });
    await chmod(runner, 0o700);
    await chmod(docker, 0o700);
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, HARNESS],
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          OWNER_ALPHA_REAL_FORGEJO: '1',
          WP3_FORGEJO_IMAGE: `sha256:${'a'.repeat(64)}`,
          WP3_FORGEJO_RUNNER: runner,
          WP3_FORGEJO_RUNNER_SHA256: createHash('sha256').update(bytes).digest('hex'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      // The isolation contract is asserted structurally and the pinned image
      // presence is checked before any lock, run root, or resource creation.
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('not present in the local engine');
      expect(result.stdout.toString()).toBe('');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  realTest('proves the controlled PR, exact owner-alpha Save, live witness, storage ceiling, and scoped cleanup', async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, HARNESS],
      cwd: ROOT,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const graceful = setTimeout(() => child.kill('SIGTERM'), 20 * 60 * 1000);
    const forced = setTimeout(() => child.kill('SIGKILL'), 20 * 60 * 1000 + 30_000);
    const exitCode = await child.exited;
    clearTimeout(graceful);
    clearTimeout(forced);
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
    const evidence = JSON.parse(stdout.trim().split('\n').at(-1));
    expect(evidence.status).toBe('passed');
    expect(evidence.provider).toBe('forgejo-actions');
    expect(evidence.instanceVersion).toMatch(/^16\./u);
    expect(evidence.authoritativeRepositoryUnchanged).toBe(true);
    expect(evidence.pr).toMatchObject({ checks: ['ofm-check', 'trust-gate'], merged: true });
    expect(evidence.save.changedPath).toBe('content/page.md');
    expect(evidence.save.exactSourceSplice).toBe(true);
    expect(evidence.save.run.headSha).toBe(evidence.save.commit);
    expect(evidence.save.jobs.map((job) => job.name)).toEqual(['build', 'deploy']);
    expect(evidence.save.jobs.every((job) => job.attempt === 1 && job.handle.length > 0)).toBe(true);
    expect(evidence.save.publication).toMatchObject({ state: 'success', deploymentJobName: 'deploy', forgeEnvironmentAttested: false });
    expect(evidence.remoteRef).toBe(evidence.save.commit);
    expect(evidence.liveWitness).toEqual({ oldAbsent: true, newUnique: true });
    expect(evidence.storage.peakBytes).toBeLessThan(4_294_967_296);
    expect(evidence.cleanup).toMatchObject({
      complete: true,
      stoppedProcesses: 2,
      removedResources: 4,
      skippedProcesses: 0,
      skippedResources: 0,
    });
    expect(JSON.stringify(evidence)).not.toMatch(/password|authorization|private.?key|bootstrap|credential|token/iu);
  }, 21 * 60 * 1000);
});
