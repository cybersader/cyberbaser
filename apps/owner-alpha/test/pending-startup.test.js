import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadOwnerAlphaConfig } from '../src/config.js';
import { loadDurableJob, transitionDurableJob } from '../src/job-state.js';
import { createSaveHandler, pipelineArtifactPaths } from '../src/pipeline.js';
import { runOwnerAlphaServer } from '../src/server.js';
import { assertCheckoutReady } from '../src/source.js';
import { storeContextFromConfig } from '../src/store.js';

const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const jobId = 'OA-pending-restart';
const edited = '# Note\n\nNew value.\n';

async function fixture({ pending = true } = {}) {
  const projectRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'oa-startup-'));
  cleanup.push(() => rm(projectRoot, { recursive: true, force: true }));
  const checkout = path.join(projectRoot, 'vault');
  const mirror = path.join(projectRoot, 'mirror.git');
  const socketPath = path.join(projectRoot, 'publisher.sock');
  const configFile = path.join(projectRoot, 'config.json');
  const raw = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
  raw.repository = { ...raw.repository, checkout, remote: { name: 'origin', url: 'https://github.com/example/fixture.git' } };
  raw.owner.identity = 'example';
  raw.workflow.repository = 'example/fixture';
  raw.live.baseUrl = 'https://example.github.io/fixture/';
  raw.publisher = { mirror, socketPath };
  await writeFile(configFile, JSON.stringify(raw), { mode: 0o600 });
  const config = await loadOwnerAlphaConfig(configFile);
  const context = storeContextFromConfig(config, projectRoot);
  const git = (...args) => execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
  const notes = (...args) => git('-C', checkout, ...args);
  const mirrorHead = () => git('-C', mirror, 'rev-parse', 'main');
  git('init', '-q', '--template=');
  await writeFile(path.join(projectRoot, '.gitignore'), '.workspace/\n');
  git('init', '-q', '-b', 'main', '--template=', checkout);
  notes('config', 'user.name', 'Fixture');
  notes('config', 'user.email', 'fixture@example.invalid');
  notes('config', 'commit.gpgSign', 'false');
  notes('remote', 'add', 'origin', raw.repository.remote.url);
  await mkdir(path.join(checkout, 'Notes'));
  const source = path.join(checkout, 'Notes/Page.md');
  const old = '# Note\n\nOld value.\n';
  await writeFile(source, old);
  await writeFile(path.join(checkout, 'publish.yml'), 'allow:\n  - "Notes/**"\n');
  notes('add', '.');
  notes('commit', '-qm', 'Fixture base');
  git('clone', '-q', '--bare', '--', checkout, mirror);
  const base = mirrorHead();
  let requests = 0;
  const publisher = net.createServer((socket) => socket.once('data', () => {
    requests += 1;
    socket.end('{"ok":false,"code":"owner-approval-missing"}\n');
  }));
  await new Promise((resolve, reject) => publisher.once('error', reject).listen(socketPath, resolve));
  cleanup.push(() => new Promise((resolve) => publisher.close(resolve)));
  if (pending) {
    const pipeline = createSaveHandler({ config, context, projectRoot, dependencies: {
      runPreApplyChecks: async () => ({ ok: true, rendered: { witnesses: { old: 'Old value.', new: 'New value.' } } }),
    } });
    const save = pipeline.startEdit({ jobId, renderer: { relativePath: 'Notes/Page.md', slug: 'Notes/Page' }, editedText: edited });
    await save.accepted;
    expect(await save.completion).toMatchObject({ state: 'awaiting-approval' });
  } else {
    await writeFile(source, edited);
    notes('commit', '-qam', 'Unrecorded local edit');
  }
  const head = notes('rev-parse', 'HEAD');
  const start = async () => {
    const runtime = await runOwnerAlphaServer({ configFile, projectRoot,
      rebuildSite: async ({ config: siteConfig }) => {
        await assertCheckoutReady(siteConfig);
        throw new Error('must not render the unsigned checkout');
      },
      createUpstreamStatus: () => ({ refresh: async () => {} }),
      startServers: () => ({ readerOrigin: 'http://127.0.0.1:4318', stop() {} }),
    });
    cleanup.push(() => runtime.stop(true));
    return runtime;
  };
  return { context, notes, source, base, head, mirrorHead, mirror, start, config, requests: () => requests };
}

test('node startup recovers the exact local commit without rendering or requesting a push', async () => {
  const f = await fixture();
  const before = await loadDurableJob(f.context, jobId);
  expect(f.notes('rev-parse', 'HEAD^')).toBe(f.base);
  await expect(assertCheckoutReady(f.config)).rejects.toMatchObject({ code: 'checkout-not-at-origin-branch' });
  const runtime = await f.start();
  expect(await runtime.recovery).toMatchObject([{ jobId, state: 'awaiting-approval' }]);
  expect(await loadDurableJob(f.context, jobId)).toEqual(before);
  expect(f.notes('rev-parse', 'HEAD')).toBe(f.head);
  expect(await readFile(f.source, 'utf8')).toBe(edited);
  expect(f.mirrorHead()).toBe(f.base);
  expect(f.requests()).toBe(1);
});

test('node startup still refuses an unrecorded local commit', async () => {
  const f = await fixture({ pending: false });
  await expect(f.start()).rejects.toMatchObject({ code: 'checkout-not-at-origin-branch' });
  expect(f.notes('rev-parse', 'HEAD')).toBe(f.head);
  expect(f.mirrorHead()).toBe(f.base);
  expect(f.requests()).toBe(0);
});

test('node startup refuses another local commit stacked on the pending one', async () => {
  const f = await fixture();
  f.notes('commit', '-qm', 'Extra local commit', '--allow-empty');
  const head = f.notes('rev-parse', 'HEAD');
  await expect(f.start()).rejects.toMatchObject({ code: 'checkout-not-at-origin-branch' });
  expect(f.notes('rev-parse', 'HEAD')).toBe(head);
  expect(f.notes('rev-parse', 'HEAD^')).toBe(f.head);
  expect(f.mirrorHead()).toBe(f.base);
});

test('node startup does not conceal local changes on top of a pending commit', async () => {
  const f = await fixture();
  const dirty = '# Note\n\nUncommitted changes.\n';
  await writeFile(f.source, dirty);
  await expect(f.start()).rejects.toMatchObject({ code: 'checkout-not-at-origin-branch' });
  expect(await readFile(f.source, 'utf8')).toBe(dirty);
  expect(f.requests()).toBe(1);
});

test('node startup refuses a recorded commit when the mirror moved', async () => {
  const f = await fixture();
  const different = f.notes('commit-tree', f.notes('rev-parse', `${f.base}^{tree}`), '-p', f.base, '-m', 'Mirror advanced independently');
  f.notes('push', '-q', '--', f.mirror, `${different}:refs/heads/main`);
  await expect(f.start()).rejects.toMatchObject({ code: 'checkout-not-at-origin-branch' });
  expect(f.notes('rev-parse', 'HEAD')).toBe(f.head);
  expect(f.mirrorHead()).toBe(different);
  expect(f.requests()).toBe(1);
});

test('node startup refuses a recorded commit when the job was cancelled', async () => {
  const f = await fixture();
  await transitionDurableJob(f.context, jobId, 'cancelled', { at: new Date().toISOString(), reason: 'fixture-cancelled' });
  await expect(f.start()).rejects.toMatchObject({ code: 'checkout-not-at-origin-branch' });
  expect(f.notes('rev-parse', 'HEAD')).toBe(f.head);
  expect(f.requests()).toBe(1);
});

test('node startup refuses a commit whose tree disagrees with the durable exact edit', async () => {
  const f = await fixture();
  await writeFile(f.source, '# Note\n\nSome other value.\n');
  f.notes('commit', '-qa', '--amend', '--no-edit');
  const head = f.notes('rev-parse', 'HEAD');
  expect(head).not.toBe(f.head);
  const file = path.join(f.context.storeRoot, pipelineArtifactPaths(jobId).committed);
  const effect = JSON.parse(await readFile(file, 'utf8'));
  effect.result.commit = head;
  effect.result.verification.commit = head;
  await writeFile(file, JSON.stringify(effect));
  await expect(f.start()).rejects.toMatchObject({ code: 'checkout-not-at-origin-branch' });
  expect(f.notes('rev-parse', 'HEAD')).toBe(head);
  expect(f.requests()).toBe(1);
});
