import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { pipelineArtifactPaths } from '../src/pipeline.js';
import { requestPublication } from '../src/publisher/client.js';
import { prepareStore, storeContextFromConfig } from '../src/store.js';

const APP = path.resolve(import.meta.dir, '..');
const CLI = path.join(APP, 'bin/owner-alpha-publisher.js');
const GIT = Bun.which('git');
const JOB = 'OA-HOSTILE';
const EDIT = '# Page\n\nFixture new sentence.\n';
const fixtureRoots = new Set();
const transportCommands = ['push', 'ls-remote', 'fetch', 'clone', 'pull'];

function git(cwd, ...args) {
  if (transportCommands.includes(args[0])) {
    const root = [...fixtureRoots].find((candidate) => cwd === candidate || cwd.startsWith(`${candidate}/`));
    const destination = args.slice(1).find((arg) => !arg.startsWith('-'));
    if (!root || !destination || !path.isAbsolute(destination) || !realpathSync(destination).startsWith(`${root}/`)) {
      throw new Error('fixture Git transport requires a destination inside its temporary directory');
    }
  }
  return execFileSync(GIT, ['-C', cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function fixture(action, { prepareJob = true, projectAtCheckout = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oa-hostile-'));
  fixtureRoots.add(root);
  let holder, app, appExited, publisher, exited;
  let activeSocket;
  try {
    const checkout = path.join(root, 'source');
    const dotGit = path.join(checkout, '.git');
    const primary = path.join(root, 'primary.git');
    const second = path.join(root, 'second.git');
    const repo = path.join(root, 'publisher.git');
    const canary = path.join(root, 'canary');
    const shim = path.join(root, 'shim');
    const log = path.join(root, 'publisher-git.jsonl');
    const configFile = path.join(root, 'owner.json');
    const socketPath = path.join(root, 'socket', 'publisher.sock');
    const holdPath = path.join(root, 'socket', 'hold.sock');
    await mkdir(path.dirname(socketPath), { mode: 0o700 });
    await chmod(path.dirname(socketPath), 0o700);
    await mkdir(path.join(checkout, 'docs'), { recursive: true });
    await mkdir(shim);
    await writeFile(log, '');
    git(root, 'init', '-q');
    await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
    git(checkout, 'init', '-q', '--initial-branch=main');
    git(checkout, 'config', 'user.email', 'fixture@example.invalid');
    git(checkout, 'config', 'user.name', 'Fixture');
    await writeFile(path.join(checkout, 'docs', 'page.md'), '# Page\n\nFixture old sentence.\n');
    git(checkout, 'add', 'docs/page.md');
    git(checkout, 'commit', '-qm', 'base');
    const base = git(checkout, 'rev-parse', 'HEAD');
    git(root, 'init', '-q', '--bare', '--initial-branch=main', primary);
    git(root, 'init', '-q', '--bare', '--initial-branch=main', second);
    git(checkout, 'push', '-q', primary, 'main');
    const raw = JSON.parse(await readFile(path.join(APP, 'owner-alpha.example.json'), 'utf8'));
    raw.repository.checkout = checkout;
    raw.publisher = { socketPath: holdPath };
    const url = raw.repository.remote.url;
    git(checkout, 'remote', 'add', 'origin', url);
    const config = validateOwnerAlphaConfig(raw);
    const projectRoot = projectAtCheckout ? checkout : root;
    if (projectAtCheckout) await writeFile(path.join(checkout, '.gitignore'), '.workspace/\n');
    const context = storeContextFromConfig(config, projectRoot);
    await prepareStore(context);
    await writeFile(configFile, JSON.stringify(raw), { mode: 0o600 });
    const paths = pipelineArtifactPaths(JOB);
    const committed = path.join(context.storeRoot, paths.committed);
    const receipt = path.join(context.storeRoot, paths.pushed);
    const runner = path.join(root, 'publisher.mjs');
    await writeFile(runner, `import { runPublisherCli } from ${JSON.stringify(pathToFileURL(CLI).href)};
try { await runPublisherCli({ configFile: process.argv[2], socketPath: process.argv[3], repository: process.argv[4],
  projectRoot: ${JSON.stringify(projectRoot)} }); }
catch (error) { process.stderr.write((error.code ?? 'uncoded-error') + '\\n'); process.exitCode = 1; }
`);
    // Log the full real publisher argv before translating the policy's required
    // HTTPS URL. Keep Git itself (including receive-pack) real and file-only.
    await writeFile(path.join(shim, 'git'), `#!${process.execPath}
import { appendFileSync, realpathSync } from 'node:fs';
const args = process.argv.slice(2);
const app = process.env.OA_HOSTILE_ACTOR === 'app';
if (!app) appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(),
  nosystem: process.env.GIT_CONFIG_NOSYSTEM, global: process.env.GIT_CONFIG_GLOBAL,
  prompt: process.env.GIT_TERMINAL_PROMPT, configCount: process.env.GIT_CONFIG_COUNT ?? null }) + '\\n');
let command = 0;
while (['--git-dir', '-C', '-c', '--no-pager'].includes(args[command])) {
  command += args[command] === '--no-pager' ? 1 : 2;
}
if (${JSON.stringify(transportCommands)}.includes(args[command])) {
  const destination = args.findIndex((arg, index) => index > command && !arg.startsWith('-'));
  try {
    if (args[destination] === (app ? 'origin' : ${JSON.stringify(url)})) args[destination] = ${JSON.stringify(primary)};
    if (!args[destination]?.startsWith('/') || !realpathSync(args[destination]).startsWith(${JSON.stringify(`${root}/`)})) throw new Error();
  } catch {
    appendFileSync(${JSON.stringify(`${log}.violation`)}, 'unsafe Git transport\\n');
    process.exit(99);
  }
  args.splice(command, 0, '-c', 'protocol.file.allow=always');
}
const child = Bun.spawnSync([${JSON.stringify(GIT)}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } });
process.exit(child.exitCode);
`, { mode: 0o700 });
    const start = async (repository = repo, { refused = false } = {}) => {
      const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(root, 'hostile-path') };
      publisher = spawn(process.execPath, [runner, configFile, socketPath, repository], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      publisher.stdout.on('data', (chunk) => { stdout += chunk; });
      publisher.stderr.on('data', (chunk) => { stderr += chunk; });
      exited = new Promise((resolve, reject) => {
        publisher.once('error', reject);
        publisher.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
      if (refused) return exited;
      for (let count = 0; count < 200 && !stdout.includes('publisher ready'); count++) {
        if (publisher.exitCode !== null) throw new Error(`publisher stopped early: ${stderr}`);
        await delay(20);
      }
      expect(stdout).toBe('owner-alpha publisher ready\n');
      return publisher;
    };
    let bound;
    if (prepareJob) {
      let requestArrived;
      const request = new Promise((resolve) => { requestArrived = resolve; });
      holder = net.createServer((socket) => {
        activeSocket = socket;
        socket.once('data', (bytes) => requestArrived(bytes.toString()));
      });
      await new Promise((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(holdPath, resolve);
      });
      const appRunner = path.join(root, 'app.mjs');
      const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.join(APP, 'src', `${name}.js`)).href);
      await writeFile(appRunner, `import { loadOwnerAlphaConfig } from ${moduleUrl('config')};
import { createSaveHandler } from ${moduleUrl('pipeline')};
const save = createSaveHandler({ config: await loadOwnerAlphaConfig(${JSON.stringify(configFile)}),
  projectRoot: ${JSON.stringify(projectRoot)}, dependencies: {
    async runPreApplyChecks() { return { ok: true, rendered: { witnesses: { old: 'old sentence.', new: 'new sentence.' } } }; },
  },
});
const result = await save.startEdit({ jobId: ${JSON.stringify(JOB)}, renderer: { relativePath: 'docs/page.md', slug: 'docs/page' },
  editedText: ${JSON.stringify(EDIT)} }).completion;
process.stdout.write(JSON.stringify(result));
`);
      app = spawn(process.execPath, [appRunner], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, GIT_ALLOW_PROTOCOL: 'file', OA_HOSTILE_ACTOR: 'app' } });
      let output = '';
      app.stdout.on('data', (chunk) => { output += chunk; });
      app.stderr.on('data', (chunk) => { output += chunk; });
      appExited = new Promise((resolve, reject) => {
        app.once('error', reject);
        app.once('close', () => resolve(output));
      });
      const admission = await Promise.race([request, appExited]);
      expect(admission).toBe(`${JSON.stringify({ v: 1, jobId: JOB })}\n`);
      bound = git(checkout, 'rev-parse', 'HEAD');
    }
    await action({ root, checkout, dotGit, primary, second, repo, canary, log, url, base, bound, committed, receipt,
      socketPath, start, storeRoot: context.storeRoot });
  } finally {
    if (publisher && publisher.exitCode === null && publisher.signalCode === null) publisher.kill('SIGTERM');
    await exited;
    activeSocket?.destroy();
    if (holder) await new Promise((resolve) => holder.close(resolve));
    if (app && app.exitCode === null && app.signalCode === null) app.kill('SIGTERM');
    await appExited;
    const violation = path.join(root, 'publisher-git.jsonl.violation');
    try {
      await expect(lstat(violation)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fixtureRoots.delete(root);
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function checkOutcome(fx, { refused = false } = {}) {
  await fx.start();
  const reply = await requestPublication({ socketPath: fx.socketPath, jobId: JOB }).catch((error) => ({ code: error.code }));
  expect(reply).toEqual(refused ? { code: 'publisher-failed' } : { ok: true, status: 'pushed' });
  const wanted = refused ? fx.base : fx.bound;
  expect(git(fx.primary, 'for-each-ref', '--format=%(objectname) %(refname)')).toBe(`${wanted} refs/heads/main`);
  expect(git(fx.second, 'for-each-ref')).toBe('');
  if (refused) await expect(lstat(fx.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(JSON.parse(await readFile(fx.receipt, 'utf8')).result.commit).toBe(wanted);
  await expect(lstat(fx.canary)).rejects.toMatchObject({ code: 'ENOENT' });
  const calls = (await readFile(fx.log, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const { args, cwd, nosystem, global, prompt, configCount } of calls) {
    expect(args.slice(0, 2)).toEqual(['--git-dir', fx.repo]);
    expect(cwd).toBe(fx.repo);
    expect([nosystem, global, prompt, configCount]).toEqual(['1', '/dev/null', '0', null]);
    expect(args).toContain('protocol.file.allow=never');
    expect(args.some((argument) => argument.startsWith(fx.checkout))).toBe(false);
  }
  const pushes = calls.filter(({ args }) => args.includes('push'));
  expect(pushes).toHaveLength(refused ? 0 : 1);
  if (!refused) expect(pushes[0].args.slice(-2)).toEqual([fx.url, `${fx.bound}:refs/heads/main`]);
}

async function canaryScript(fx) {
  const script = path.join(fx.root, 'canary.sh');
  await writeFile(script, `#!/bin/sh\ntouch '${fx.canary}'\nexit 1\n`, { mode: 0o700 });
  return script;
}

const successful = [
  ['hook files and core.hooksPath', async (fx) => {
    const alternate = path.join(fx.root, 'hostile-path');
    await mkdir(alternate);
    const script = await canaryScript(fx);
    for (const directory of [path.join(fx.dotGit, 'hooks'), alternate]) {
      for (const hook of ['pre-push', 'reference-transaction', 'post-checkout', 'pre-receive', 'update', 'post-receive']) {
        await writeFile(path.join(directory, hook), await readFile(script), { mode: 0o700 });
      }
    }
    git(fx.checkout, 'config', 'core.hooksPath', alternate);
  }],
  ['Git command and credential settings', async (fx) => {
    const script = await canaryScript(fx);
    for (const key of ['core.sshCommand', 'core.fsmonitor', 'core.pager']) git(fx.checkout, 'config', key, script);
    git(fx.checkout, 'config', 'credential.helper', `!${script}`);
  }],
  ['URL rewrite and added push destination', async (fx) => {
    for (const key of ['insteadOf', 'pushInsteadOf']) {
      for (const url of [fx.url, fx.primary]) git(fx.checkout, 'config', '--add', `url.${fx.second}.${key}`, url);
    }
    git(fx.checkout, 'config', '--add', 'remote.origin.pushurl', fx.primary);
    git(fx.checkout, 'config', '--add', 'remote.origin.pushurl', fx.second);
  }],
  ['upload-pack hook and config include', async (fx) => {
    const script = await canaryScript(fx);
    const included = path.join(fx.root, 'included.gitconfig');
    await writeFile(included, `[core]\n\tfsmonitor = ${script}\n\tsshCommand = ${script}\n[credential]\n\thelper = !${script}\n`);
    git(fx.checkout, 'config', 'uploadpack.packObjectsHook', script);
    git(fx.checkout, 'config', 'include.path', included);
  }],
  ['packed history, annotated tag, and divergent extra branch', async (fx) => {
    git(fx.checkout, 'tag', '-am', 'do not publish', 'private');
    git(fx.checkout, 'switch', '-qc', 'never-push');
    git(fx.checkout, 'commit', '--allow-empty', '-qm', 'do not publish this commit');
    git(fx.checkout, 'switch', '-q', 'main');
    git(fx.checkout, 'gc', '--prune=now');
  }],
];

for (const [label, setup] of successful) {
  test(`publisher isolates ${label}`, () => fixture(async (fx) => {
    await setup(fx);
    await checkOutcome(fx);
  }), 15_000);
}

for (const form of ['alternates', 'object directory symlink', 'fanout symlink', 'loose object symlink', 'hardlinked object']) {
  test(`publisher cannot resolve commit through ${form}`, () => fixture(async (fx) => {
    const objects = path.join(fx.dotGit, 'objects');
    const outside = path.join(fx.root, 'outside');
    const fanout = fx.bound.slice(0, 2);
    const loose = fx.bound.slice(2);
    if (form === 'alternates' || form === 'object directory symlink') {
      await rename(objects, outside);
      if (form === 'alternates') {
        await mkdir(path.join(objects, 'info'), { recursive: true });
        await writeFile(path.join(objects, 'info', 'alternates'), `${outside}\n`);
      } else await symlink(outside, objects);
    } else if (form === 'fanout symlink') {
      await rename(path.join(objects, fanout), outside);
      await symlink(outside, path.join(objects, fanout));
    } else {
      const file = path.join(objects, fanout, loose);
      await rename(file, outside);
      if (form === 'loose object symlink') await symlink(outside, file);
      else {
        const { link } = await import('node:fs/promises');
        await link(outside, file);
      }
    }
    await checkOutcome(fx, { refused: true });
  }), 15_000);
}

for (const change of ['two paths', 'different parent', 'mode change', 'message change']) {
  test(`publisher refuses tampered commit with ${change}`, () => fixture(async (fx) => {
    const file = path.join(fx.checkout, 'docs', 'page.md');
    const evidence = JSON.parse(await readFile(fx.committed, 'utf8'));
    if (change === 'two paths') {
      await writeFile(path.join(fx.checkout, 'extra.md'), 'another file\n');
      git(fx.checkout, 'add', 'extra.md');
      git(fx.checkout, 'commit', '--amend', '--no-edit', '-q');
    } else if (change === 'different parent') {
      git(fx.checkout, 'reset', '--hard', fx.base);
      git(fx.checkout, 'commit', '--allow-empty', '-qm', 'different parent');
      await writeFile(file, EDIT);
      git(fx.checkout, 'add', 'docs/page.md');
      git(fx.checkout, 'commit', '-qm', evidence.result.message);
    } else if (change === 'mode change') {
      git(fx.checkout, 'update-index', '--chmod=+x', 'docs/page.md');
      git(fx.checkout, 'commit', '--amend', '--no-edit', '-q');
    } else git(fx.checkout, 'commit', '--amend', '-qm', `${evidence.result.message} changed`);
    evidence.result.commit = git(fx.checkout, 'rev-parse', 'HEAD');
    expect(evidence.result.commit).not.toBe(fx.bound);
    await writeFile(fx.committed, JSON.stringify(evidence));
    await checkOutcome(fx, { refused: true });
  }), 15_000);
}

for (const variant of ['symlink', 'group-writable']) {
  test(`publisher refuses to start with a ${variant} repository`, () => fixture(async (fx) => {
    const target = path.join(fx.root, 'other-directory');
    await mkdir(target, { mode: 0o700 });
    if (variant === 'symlink') await symlink(target, fx.repo);
    else { await mkdir(fx.repo); await chmod(fx.repo, 0o770); }
    const exit = await fx.start(fx.repo, { refused: true });
    expect(exit).toEqual({ code: 1, signal: null, stdout: '', stderr: 'publisher-unsafe-repository\n' });
    expect(await readFile(fx.log, 'utf8')).toBe('');
  }, { prepareJob: false }), 15_000);
}

for (const variant of ['inside checkout', 'symlink into checkout']) {
  test(`publisher refuses to start with an artifact store ${variant}`, () => fixture(async (fx) => {
    if (variant === 'symlink into checkout') {
      const target = path.join(fx.checkout, 'alternate-store');
      await mkdir(target);
      await rm(fx.storeRoot, { recursive: true });
      await symlink(target, fx.storeRoot);
    }
    const exit = await fx.start(fx.repo, { refused: true });
    expect(exit).toEqual({ code: 1, signal: null, stdout: '', stderr: 'publisher-unsafe-store\n' });
    expect(await readFile(fx.log, 'utf8')).toBe('');
  }, { prepareJob: false, projectAtCheckout: variant === 'inside checkout' }), 15_000);
}
