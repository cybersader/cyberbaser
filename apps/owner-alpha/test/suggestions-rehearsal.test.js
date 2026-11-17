import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { assertPrerequisites, createSuggestionsFixture, optionsFromArgs, PAGES, PREPARE_COMMAND, PROJECT_ROOT, QUOTE, REPLACEMENT } from '../bin/suggestions-rehearsal-fixture.js';
import { EventEmitter } from 'node:events';
import { instructions, installSignInSignal } from '../bin/suggestions-rehearsal.js';
import { copyCommittedFolder, MAX_COPY_BYTES } from '../bin/suggestions-rehearsal-source.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { deriveIntakeConfig } from '../src/suggestions.js';
import { ACCOUNT_FREE_INTENT_ARTIFACT_TYPE } from '../../../packages/account-free-intake/src/contract.js';
import { select } from '../../../packages/publish/src/index.js';

const SOURCE_FOLDER = '📁 03 - Curations, Stacks';
const SOURCE_PAGE = `${SOURCE_FOLDER}/MFA methods.md`;
const SOURCE_BYTES = Buffer.from(`---\r\ntitle: Copied MFA methods\r\n---\r\n# MFA methods\r\n\r\n${QUOTE}\r\n\r\n![[diagram.svg]]\r\n\r\n[[guide.pdf]]\r\n`);
const SOURCE_ATTACHMENT = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>\n';
const exec = promisify(execFile);
async function sourceGit(source, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const { stdout } = await exec('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: PROJECT_ROOT, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout.trim();
}
async function sourceVault({ lf = false } = {}) {
  const source = await mkdtemp(path.join(PROJECT_ROOT, '.workspace/source-suggestions-'));
  cleanup.push(() => rm(source, { recursive: true, force: true }));
  await mkdir(path.join(source, SOURCE_FOLDER, 'nested'), { recursive: true });
  await mkdir(path.join(source, '_attachments'));
  await writeFile(path.join(source, SOURCE_PAGE), lf ? SOURCE_BYTES.toString('utf8').replaceAll('\r\n', '\n') : SOURCE_BYTES);
  await writeFile(path.join(source, SOURCE_FOLDER, 'nested/Second note.md'), '# Second note\n\nKeep this ordinary sentence unchanged.\n');
  await writeFile(path.join(source, SOURCE_FOLDER, 'Private note.md'), '---\npublish: false\n---\nPrivate. ![[private.png]]\n');
  await writeFile(path.join(source, SOURCE_FOLDER, 'Other private.md'), '---\ncb-publish: false\n---\nAlso private.\n');
  await writeFile(path.join(source, '_attachments/diagram.svg'), SOURCE_ATTACHMENT);
  await writeFile(path.join(source, '_attachments/guide.pdf'), '%PDF-1.4\nfixture\n');
  await writeFile(path.join(source, '_attachments/unreferenced.png'), 'unreferenced');
  await writeFile(path.join(source, '_attachments/private.png'), 'private only');
  await writeFile(path.join(source, 'outside.md'), 'Not selected.');
  await sourceGit(source, ['init', '-q', '--initial-branch=main']);
  await sourceGit(source, ['config', 'user.name', 'Source Fixture']);
  await sourceGit(source, ['config', 'user.email', 'source@example.invalid']);
  await sourceGit(source, ['add', '-A']);
  await sourceGit(source, ['commit', '-qm', 'Published source snapshot']);
  await sourceGit(source, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await writeFile(path.join(source, SOURCE_PAGE), '# Unpushed content\n\nThis is not the published snapshot.\n');
  await sourceGit(source, ['add', '-A']);
  await sourceGit(source, ['commit', '-qm', 'Extra unpushed commit']);
  await writeFile(path.join(source, SOURCE_PAGE), 'DIRTY working-tree content\n');
  await writeFile(path.join(source, '_attachments/diagram.svg'), 'DIRTY attachment bytes\n');
  await writeFile(path.join(source, 'outside.md'), 'Staged dirty content\n');
  await sourceGit(source, ['add', 'outside.md']);
  await writeFile(path.join(source, 'untracked.md'), 'Untracked private content\n');
  return source;
}
async function sourceSnapshot(source) {
  // Include .git/index, objects, refs, logs, and working-tree mtimes, not atimes.
  const mtimes = {};
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = path.join(directory, name);
      const info = await lstat(absolute, { bigint: true });
      mtimes[path.relative(source, absolute)] = info.mtimeNs.toString();
      if (info.isDirectory()) await walk(absolute);
    }
  }
  const status = await sourceGit(source, ['status', '--porcelain=v1']);
  const head = await sourceGit(source, ['rev-parse', 'HEAD']);
  const refs = await sourceGit(source, ['for-each-ref', '--format=%(refname) %(objectname)']);
  await walk(source);
  return { status, head, refs, mtimes };
}

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options) {
  const value = await createSuggestionsFixture(options);
  cleanup.push(() => value.cleanup());
  return value;
}
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

async function until(condition, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await Bun.sleep(50);
  }
  throw new Error('Bounded rehearsal wait timed out.');
}
function freePorts() {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const servers = [];
    try {
      const port = 48000 + Math.floor(Math.random() * 5000);
      for (let offset = 0; offset < 3; offset += 1) servers.push(Bun.serve({ hostname: '127.0.0.1', port: port + offset, fetch: () => new Response('reserved') }));
      return port;
    } catch { /* Try another bounded triple. */ }
    finally { for (const server of servers) server.stop(true); }
  }
  throw new Error('No free loopback port triple found.');
}

// Register a genuine skip when the parallel owner challenge config change is
// absent. The independent raw-fixture shape tests still run in every checkout.
let challengeConfigSupported = true;
const configProbe = await createSuggestionsFixture({ challenge: 'pass' });
try { validateOwnerAlphaConfig(configProbe.config); }
catch (error) {
  if (error.code === 'unknown-config-key' && error.details?.location === '$.suggestions.form') {
    challengeConfigSupported = false;
    console.error('SKIP: owner suggestions.form.challenge is not accepted yet; raw rehearsal challenge shapes remain covered.');
  } else throw error;
} finally { await configProbe.cleanup(); }
const challengeConfigTest = challengeConfigSupported ? test : test.skip;

describe('suggestions rehearsal fixture (hermetic)', () => {
  test('a launcher-local signal requests fresh sign-in output without stdin or an HTTP endpoint', () => {
    const target = new EventEmitter();
    let issued = 0;
    const dispose = installSignInSignal({ target, issueSignIn: () => { issued += 1; } });
    expect(issued).toBe(0);
    target.emit('SIGUSR1');
    target.emit('SIGUSR1');
    expect(issued).toBe(2);
    dispose();
    expect(target.listenerCount('SIGUSR1')).toBe(0);
    target.emit('SIGUSR1');
    expect(issued).toBe(2);
  });

  test('printed copied-page examples stay canonical and short, with home as the first link', () => {
    const fixture = {
      root: '/owned/throwaway', readerOrigin: 'http://127.0.0.1:49001', ownerOrigin: 'http://127.0.0.1:49000', challenge: null, keep: false,
      copied: { ref: 'origin/main', commit: 'a'.repeat(40), pages: 8, publishedPages: Array(8), attachments: 0,
        pageLinks: Array.from({ length: 8 }, (_, index) => `${encodeURIComponent('📁-Curations,-Stacks')}/page-${index}`) },
    };
    const output = instructions(fixture);
    const links = output.match(/http:\/\/127\.0\.0\.1:49001\/cyberbase\/[^\s]*/gu);
    expect(links).toHaveLength(6);
    expect(links[0]).toBe(`${fixture.readerOrigin}/cyberbase/`);
    expect(links[1]).toContain('%F0%9F%93%81-Curations%2C-Stacks/page-0');
    expect(output).not.toContain('%252C');
    expect(output).not.toContain('/cyberbase/📁');
  });

  test('arguments allow bounded ports, one private host and published test modes', () => {
    expect(optionsFromArgs([])).toEqual({ keep: false, challenge: null, prepare: false, port: 46437, host: '127.0.0.1' });
    expect(optionsFromArgs(['--keep', '--challenge', 'spent', '--port', '49000'])).toEqual({ keep: true, challenge: 'spent', prepare: false, port: 49000, host: '127.0.0.1' });
    // A tailnet (RFC 6598) or LAN address lets a phone reach the throwaway site; public and wildcard addresses are refused.
    expect(optionsFromArgs(['--host', '100.64.12.34']).host).toBe('100.64.12.34');
    expect(optionsFromArgs(['--host', '192.168.1.20']).host).toBe('192.168.1.20');
    for (const args of [['--port', '65534'], ['--port', '0'], ['--port', 'no'], ['--host', '0.0.0.0'], ['--host', '8.8.8.8'], ['--host', 'example.com'], ['--challenge', 'real'], ['--prepare', '--keep']]) expect(() => optionsFromArgs(args)).toThrow();
  });

  test('creates fresh three-page vault, private valid config and an owned local-only remote', async () => {
    const f = await fixture();
    const validated = validateOwnerAlphaConfig(f.config);
    const intake = deriveIntakeConfig(validated, f.projectRoot);
    expect(validated.listen).toEqual({ host: '127.0.0.1', port: 46437, readerPort: 46438 });
    expect(validated.suggestions.form.enabled).toBe(true);
    expect(validated.proposalReview.enabled).toBe(true);
    expect(intake.publicOrigin).toBe(f.intakeOrigin);
    expect(intake.allowedFormOrigins).toEqual([f.readerOrigin]);
    expect(intake.queue.root.startsWith(`${f.root}/`)).toBe(true);
    expect(validated.repository.checkout).toBe(f.checkout);
    expect(await f.git(f.checkout, ['remote', 'get-url', '--push', 'origin'])).toBe(f.remote);
    expect(await f.git(f.checkout, ['rev-parse', 'HEAD'])).toBe(await f.git(f.remote, ['rev-parse', 'refs/heads/main']));
    expect(await f.git(f.checkout, ['status', '--porcelain'])).toBe('');
    for (const [name, bytes] of Object.entries(PAGES)) expect(await readFile(path.join(f.checkout, name), 'utf8')).toBe(bytes);
    expect((await lstat(f.root)).mode & 0o777).toBe(0o700);
    expect((await lstat(f.configFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(f.configFile, 'utf8'))).toEqual(f.config);
    await expect(f.git(PROJECT_ROOT, ['status'])).rejects.toThrow('containment');
    const text = instructions(f);
    for (const step of [1, 2, 3, 4, 5, 6]) expect(text).toContain(`\n${step}. `);
    expect(text).toContain(f.readerOrigin);
    expect(text).toContain(`${f.ownerOrigin}/owner/review`);
    expect(text).toContain('simulated');
    expect(text).toContain('2. Tap Suggest edits, tap into text and type, then choose Review & send.');
    expect(text).not.toContain('Text to replace');
    expect(text.indexOf(`${f.readerOrigin}/cyberbase/`)).toBeLessThan(text.indexOf(`${f.readerOrigin}/cyberbase/mfa-methods`));
    expect(text).toContain('start from the site home');
    expect(text).toContain(`kill -USR1 ${process.pid}`);
    await f.cleanup();
    await f.cleanup();
    expect(await exists(f.root)).toBe(false);
  });

  test('--keep retains only this owned throwaway state after stop', async () => {
    const f = await fixture({ keep: true });
    cleanup.push(() => rm(f.root, { recursive: true, force: true }));
    // Cleanup after the explicit rm would fail its ownership check, so settle it now.
    await f.cleanup();
    expect(await exists(f.configFile)).toBe(true);
    expect(instructions(f)).toContain('--keep: stopped state will remain');
  });

  for (const mode of ['pass', 'fail', 'spent']) {
    test(`--challenge ${mode} writes a private published test-key file and the frozen config shape`, async () => {
      const f = await fixture({ challenge: mode });
      const challenge = f.config.suggestions.form.challenge;
      expect(Object.keys(challenge).sort()).toEqual(['expectedHostnames', 'provider', 'secretFile', 'siteKey']);
      expect(challenge.provider).toBe('turnstile');
      expect(challenge.expectedHostnames).toEqual(['example.com']);
      expect(challenge.secretFile.startsWith(`${f.root}/`)).toBe(true);
      expect((await lstat(challenge.secretFile)).mode & 0o777).toBe(0o600);
      expect(challenge.siteKey).toBe(mode === 'fail' ? '2x00000000000000000000AB' : '1x00000000000000000000AA');
      expect((await readFile(challenge.secretFile, 'utf8')).trim()).toBe(`${mode === 'pass' ? 1 : mode === 'fail' ? 2 : 3}x0000000000000000000000000000000AA`);
      expect(instructions(f)).toContain('needs internet access to challenges.cloudflare.com');
    });
    challengeConfigTest(`owner config accepts rehearsal challenge ${mode}`, async () => {
      const f = await fixture({ challenge: mode });
      const config = validateOwnerAlphaConfig(f.config);
      expect(config.suggestions.form.challenge.siteKey).toBe(f.config.suggestions.form.challenge.siteKey);
      const derived = deriveIntakeConfig(config, f.projectRoot);
      expect(derived.botCheck.secretFile).toBe(f.config.suggestions.form.challenge.secretFile);
      expect(derived.botCheck.expectedHostnames).toEqual(['example.com']);
    });
  }

  test('copy arguments require an explicit folder and bound, while keeping optional modes', () => {
    expect(optionsFromArgs(['--from', '/source', '--folder', SOURCE_FOLDER, '--keep', '--challenge', 'pass'])).toEqual({
      keep: true, challenge: 'pass', prepare: false, port: 46437, host: '127.0.0.1', from: '/source', folder: SOURCE_FOLDER, ref: 'origin/main', maxPages: 400,
    });
    expect(optionsFromArgs(['--from', '/source', '--folder', SOURCE_FOLDER, '--ref', 'HEAD~1', '--max-pages', '800']).maxPages).toBe(800);
    for (const args of [
      ['--from', '/source'], ['--folder', SOURCE_FOLDER], ['--ref', 'HEAD'], ['--ref', 'origin/main'], ['--max-pages', '800'], ['--max-pages', '400'],
      ['--from', '/source', '--folder', '../private'], ['--from', '/source', '--folder', '/absolute'],
      ['--from', '/source', '--folder', '**'], ['--from', '/source', '--folder', '.git'],
      ['--from', '/source', '--folder', SOURCE_FOLDER, '--max-pages', '0'],
      ['--prepare', '--from', '/source', '--folder', SOURCE_FOLDER],
    ]) expect(() => optionsFromArgs(args)).toThrow();
  });

  test('copies exact committed emoji paths, only referenced attachments, and deny-wins publication without touching the dirty source', async () => {
    const source = await sourceVault();
    const before = await sourceSnapshot(source);
    const f = await fixture({ from: source, folder: SOURCE_FOLDER, challenge: 'pass', keep: true });
    cleanup.push(() => rm(f.root, { recursive: true, force: true }));
    validateOwnerAlphaConfig(f.config);
    expect(f.copied.ref).toBe('origin/main');
    expect(f.copied.commit).toBe(await sourceGit(source, ['rev-parse', 'origin/main']));
    expect(f.copied.commit).not.toBe(before.head);
    expect(f.copied.pages).toBe(4);
    expect(f.copied.attachments).toBe(2);
    expect(await readFile(path.join(f.checkout, SOURCE_PAGE))).toEqual(SOURCE_BYTES);
    expect(await readFile(path.join(f.checkout, '_attachments/diagram.svg'), 'utf8')).toBe(SOURCE_ATTACHMENT);
    expect(await readFile(path.join(f.checkout, '_attachments/guide.pdf'), 'utf8')).toBe('%PDF-1.4\nfixture\n');
    for (const name of ['_attachments/unreferenced.png', '_attachments/private.png', 'outside.md', 'untracked.md']) expect(await exists(path.join(f.checkout, name))).toBe(false);
    const selection = select(f.checkout);
    expect(selection.errors).toEqual([]);
    expect(selection.report.published.pages).toEqual([SOURCE_PAGE, `${SOURCE_FOLDER}/nested/Second note.md`, 'index.md'].sort());
    expect(selection.report.published.assets).toEqual(['_attachments/diagram.svg']);
    expect(selection.report.denied.some((entry) => entry.path === `${SOURCE_FOLDER}/Private note.md`)).toBe(true);
    const index = await readFile(path.join(f.checkout, 'index.md'), 'utf8');
    expect(index).toContain(encodeURIComponent(SOURCE_FOLDER));
    expect(index).not.toContain('Private note');
    expect(index).not.toContain('Other private');
    expect(instructions(f)).toContain('All edits go only to the throwaway copy, never the real vault.');
    expect(instructions(f)).toContain(`/cyberbase/${encodeURIComponent('📁-03---Curations,-Stacks')}/MFA-methods`);
    expect(instructions(f)).toContain('Tap Suggest edits, tap into text and type');
    expect(instructions(f)).not.toContain('/cyberbase/📁');
    expect(instructions(f)).toContain('needs internet access');
    expect(instructions(f)).not.toContain('open MFA methods');
    await f.cleanup();
    expect(await exists(f.root)).toBe(true);
    expect(await sourceSnapshot(source)).toEqual(before);
  });

  test('allows an explicit local ref without reading dirty source content', async () => {
    const source = await sourceVault();
    const before = await sourceSnapshot(source);
    const f = await fixture({ from: source, folder: SOURCE_FOLDER, ref: 'HEAD' });
    expect(await readFile(path.join(f.checkout, SOURCE_PAGE), 'utf8')).toBe('# Unpushed content\n\nThis is not the published snapshot.\n');
    expect(f.copied.attachments).toBe(0);
    await f.cleanup();
    expect(await sourceSnapshot(source)).toEqual(before);
  });

  test('refuses missing refs/folders, excessive page counts, docs and previous throwaway sources', async () => {
    const source = await sourceVault();
    const before = await sourceSnapshot(source);
    await expect(createSuggestionsFixture({ from: source, folder: SOURCE_FOLDER, ref: 'missing-ref' })).rejects.toThrow('does not exist as a local commit');
    await expect(createSuggestionsFixture({ from: source, folder: 'missing-folder' })).rejects.toThrow('does not exist');
    await expect(createSuggestionsFixture({ from: source, folder: SOURCE_FOLDER, maxPages: 3 })).rejects.toThrow('Raise --max-pages');
    const allowed = await fixture({ from: source, folder: SOURCE_FOLDER, maxPages: 4 });
    expect(allowed.copied.pages).toBe(4);
    await expect(createSuggestionsFixture({ from: path.join(PROJECT_ROOT, 'docs'), folder: SOURCE_FOLDER })).rejects.toThrow('project docs');
    await expect(createSuggestionsFixture({ from: path.join(PROJECT_ROOT, 'docs/src'), folder: SOURCE_FOLDER })).rejects.toThrow('project docs');
    await expect(createSuggestionsFixture({ from: allowed.checkout, folder: SOURCE_FOLDER })).rejects.toThrow('throwaway');
    await allowed.cleanup();
    expect(await sourceSnapshot(source)).toEqual(before);
  });

  test('refuses committed Markdown symlinks rather than following paths out of the copy', async () => {
    const source = await sourceVault();
    await symlink('/outside/private.md', path.join(source, SOURCE_FOLDER, 'Escape.md'));
    await sourceGit(source, ['add', `${SOURCE_FOLDER}/Escape.md`]);
    await sourceGit(source, ['commit', '-qm', 'Unsafe source fixture']);
    const before = await sourceSnapshot(source);
    await expect(createSuggestionsFixture({ from: source, folder: SOURCE_FOLDER, ref: 'HEAD' })).rejects.toThrow('symlink');
    expect(await sourceSnapshot(source)).toEqual(before);
  });

  test('enforces the default 400-page and 50 MiB byte caps before reading oversized objects', async () => {
    const source = await sourceVault();
    const f = await fixture();
    const note = '# Note\n\nAn ordinary sentence. ![[large.bin]]\n';
    const oid = '1'.repeat(40);
    const entry = (name, size) => `100644 blob ${oid} ${size}\t${name}\0`;
    async function attempt(tree) {
      let blobReads = 0;
      const command = async (program, args) => {
        expect(program).toBe('git');
        let stdout;
        if (args.includes('--show-toplevel')) stdout = source;
        else if (args.includes('--verify')) stdout = oid;
        else if (args.includes('ls-tree')) stdout = tree;
        else if (args.includes('cat-file')) { blobReads += 1; stdout = note; }
        else throw new Error('Unexpected source command.');
        return { stdout: Buffer.from(stdout) };
      };
      try {
        await copyCommittedFolder({ from: source, folder: SOURCE_FOLDER, checkout: f.checkout, root: f.root, projectRoot: PROJECT_ROOT, command });
        throw new Error('Expected cap refusal.');
      } catch (error) { return { message: error.message, blobReads }; }
    }
    const tooMany = await attempt(Array.from({ length: 401 }, (_, index) => entry(`${SOURCE_FOLDER}/${index}.md`, note.length)).join(''));
    expect(tooMany).toEqual({ message: 'Source folder has 401 Markdown pages; the limit is 400. Raise --max-pages explicitly to copy more.', blobReads: 0 });
    const markdown = await attempt(entry(SOURCE_PAGE, MAX_COPY_BYTES + 1));
    expect(markdown.message).toContain('Markdown copy exceeds the 50 MiB');
    expect(markdown.blobReads).toBe(0);
    const assets = await attempt(entry(SOURCE_PAGE, note.length) + entry('_attachments/large.bin', MAX_COPY_BYTES + 1));
    expect(assets.message).toContain('Referenced attachments exceed the 50 MiB');
    expect(assets.blobReads).toBe(1);
  });

  test('refuses ambiguous referenced attachment filenames without mutating the source', async () => {
    const source = await sourceVault();
    await mkdir(path.join(source, '_attachments/nested'));
    await writeFile(path.join(source, '_attachments/nested/diagram.svg'), SOURCE_ATTACHMENT);
    await writeFile(path.join(source, SOURCE_PAGE), SOURCE_BYTES);
    await sourceGit(source, ['add', '_attachments/nested/diagram.svg', SOURCE_PAGE]);
    await sourceGit(source, ['commit', '-qm', 'Ambiguous source fixture']);
    const before = await sourceSnapshot(source);
    await expect(createSuggestionsFixture({ from: source, folder: SOURCE_FOLDER, ref: 'HEAD' })).rejects.toThrow('ambiguous');
    expect(await sourceSnapshot(source)).toEqual(before);
  });

  test('missing renderer has a plain preparation command, without creating throwaway state', async () => {
    await expect(assertPrerequisites({ seed: path.join(PROJECT_ROOT, '.workspace/no-such-suggestions-seed') })).rejects.toThrow(PREPARE_COMMAND);
  });
});

const realTest = process.env.SUGGESTIONS_REHEARSAL_REAL_QUARTZ === '1' ? test : test.skip;
for (const fromSource of [false, true]) realTest(`noninteractive launcher (${fromSource ? 'committed folder copy' : 'synthetic'}): real rendered form, HTTP queue/page limit, Approve, Apply, rebuilt page and complete cleanup`, async () => {
  await assertPrerequisites();
  const source = fromSource ? await sourceVault({ lf: true }) : null;
  const sourceBefore = source ? await sourceSnapshot(source) : null;
  const sourcePath = source ? SOURCE_PAGE : 'mfa-methods.md';
  const original = source ? SOURCE_BYTES.toString('utf8').replaceAll('\r\n', '\n') : PAGES['mfa-methods.md'];
  const untouchedPath = source ? `${SOURCE_FOLDER}/nested/Second note.md` : 'recovery-codes.md';
  const untouchedBytes = source ? await readFile(path.join(source, untouchedPath), 'utf8') : PAGES['recovery-codes.md'];
  const port = freePorts();
  const owner = `http://127.0.0.1:${port}`;
  const reader = `http://127.0.0.1:${port + 1}`;
  const intake = `http://127.0.0.1:${port + 2}`;
  const child = Bun.spawn([process.execPath, path.join(PROJECT_ROOT, 'apps/owner-alpha/bin/suggestions-rehearsal.js'), '--port', String(port),
    ...(source ? ['--from', source, '--folder', SOURCE_FOLDER] : [])],
    { cwd: PROJECT_ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let output = ''; let errors = ''; let root;
  const consume = async (stream, receive) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) receive(decoder.decode(chunk, { stream: true }));
  };
  const reading = [consume(child.stdout, (text) => { output += text; }), consume(child.stderr, (text) => { errors += text; })];
  const stop = async () => {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 130_000);
    try { await child.exited; await Promise.all(reading); } finally { clearTimeout(timer); }
  };
  cleanup.push(stop);
  try {
    const bootstrap = await until(() => {
      if (child.exitCode !== null) throw new Error(`Launcher exited before ready: ${errors.replace(/token=[\w-]+/gu, 'token=[redacted]')}`);
      return output.match(/Owner alpha bootstrap: (http:\/\/127\.0\.0\.1:\d+\/owner\/bootstrap\?token=[A-Za-z0-9_-]{43})/u)?.[1];
    }, 150_000);
    root = output.match(/Owned state: (.+)\n/u)?.[1];
    expect(root).toBeTruthy();
    const pageUrl = `${reader}/cyberbase/${source ? `${encodeURIComponent('📁-03---Curations,-Stacks')}/MFA-methods` : 'mfa-methods'}`;
    const page = await fetch(pageUrl, { signal: AbortSignal.timeout(5000) });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(QUOTE);
    expect(html).toContain('suggest-correction-form');
    const bindingDigest = html.match(/data-binding-digest="([^"]+)"/u)?.[1];
    const pageId = html.match(/data-page-id="([^"]+)"/u)?.[1];
    expect(bindingDigest).toBeTruthy(); expect(pageId).toBeTruthy();
    const post = (attempt) => fetch(`${intake}/v1/corrections`, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Origin: reader, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, artifactType: ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
        bindingDigest, pageId, selection: { quote: QUOTE, prefix: null, suffix: null }, replacement: REPLACEMENT,
        rationale: `SMS can be phished. Disposable test attempt ${attempt}.`, evidence: [], idempotencyKey: null }) });
    const submitted = await post(1);
    expect(submitted.status).toBe(202);
    const queueId = (await submitted.json()).receipt.queueId;
    expect((await post(2)).status).toBe(202);
    const limited = await post(3);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe('rate-limited');
    const pending = path.join(root, 'owner-runtime/.workspace/owner-alpha/suggestions/queue/pending');
    expect(await readdir(pending)).toHaveLength(2);

    const signIn = await fetch(bootstrap, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    expect(signIn.status).toBe(303);
    const cookie = signIn.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    const auth = (route, init = {}) => fetch(`${owner}${route}`, { ...init, signal: AbortSignal.timeout(15_000),
      headers: { Cookie: cookie, Origin: owner, ...(init.headers ?? {}) } });
    const listed = await auth('/api/review');
    expect(listed.status).toBe(200);
    expect((await listed.json()).actionable.some((item) => item.summary.queueId === queueId)).toBe(true);
    const review = await auth(`/owner/review/${queueId}`);
    expect(review.status).toBe(200);
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain('Deployment and live confirmation are simulated');
    const csrf = reviewHtml.match(/data-csrf="([^"]+)"/u)?.[1];
    const reviewEvidenceDigest = reviewHtml.match(/data-review-evidence-digest="([^"]+)"/u)?.[1];
    expect(csrf).toBeTruthy(); expect(reviewEvidenceDigest).toBeTruthy();
    const approve = await auth(`/api/review/${queueId}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueId, reviewEvidenceDigest, action: 'approve', reason: 'Fix the deliberately wrong MFA statement.', csrf }) });
    expect(approve.status).toBe(201);
    expect(await readFile(path.join(root, 'vault', sourcePath), 'utf8')).toBe(original);
    const apply = await auth(`/api/review/${queueId}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queueId, csrf }) });
    expect(apply.status, await apply.clone().text()).toBe(202);
    const job = await apply.json();
    const completed = await until(async () => {
      const response = await auth(`/api/jobs/${job.jobId}`);
      const state = await response.json();
      if (['failed', 'blocked-pre-apply', 'manual-intervention', 'deployment-failed'].includes(state.state)) throw new Error(`Local job stopped: ${state.state} ${JSON.stringify(state.failure)}`);
      return state.state === 'completed' ? state : null;
    }, 150_000);
    expect(completed.state).toBe('completed');
    expect(await readFile(path.join(root, 'vault', sourcePath), 'utf8')).toBe(original.replace(QUOTE, REPLACEMENT));
    expect(await readFile(path.join(root, 'vault', untouchedPath), 'utf8')).toBe(untouchedBytes);
    const readHead = async (directory) => {
      const git = Bun.spawn(['git', '-C', directory, 'rev-parse', 'refs/heads/main'], {
        cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'ignore', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
      const text = await new Response(git.stdout).text();
      expect(await git.exited).toBe(0);
      return text.trim();
    };
    expect(await readHead(path.join(root, 'vault'))).toBe(await readHead(path.join(root, 'local-only.git')));
    const updated = await fetch(pageUrl, { signal: AbortSignal.timeout(5000) });
    expect(await updated.text()).toContain(REPLACEMENT);
    const jobPage = await auth(`/owner/jobs/${job.jobId}`);
    const jobHtml = await jobPage.text();
    expect(jobHtml).toContain('Local rehearsal complete');
    expect(jobHtml).not.toContain('Live on the page.');
    await stop();
    expect(child.exitCode).toBe(0);
    expect(await exists(root)).toBe(false);
    expect(output).toContain('Owned services closed and throwaway state removed');
    if (source) {
      expect(output).toContain('All edits go only to the throwaway copy, never the real vault.');
      expect(await sourceSnapshot(source)).toEqual(sourceBefore);
    }
    for (const origin of [owner, reader, intake]) {
      await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    }
  } finally {
    // No force-removal: if shutdown cannot settle, preserve evidence rather than
    // deleting a vault under an active source-writing job.
    await stop();
  }
}, 330_000);
