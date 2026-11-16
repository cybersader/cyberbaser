import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertPrerequisites, createSuggestionsFixture, optionsFromArgs, PAGES, PREPARE_COMMAND, PROJECT_ROOT, QUOTE, REPLACEMENT } from '../bin/suggestions-rehearsal-fixture.js';
import { instructions } from '../bin/suggestions-rehearsal.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { deriveIntakeConfig } from '../src/suggestions.js';
import { ACCOUNT_FREE_INTENT_ARTIFACT_TYPE } from '../../../packages/account-free-intake/src/contract.js';

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
  test('arguments allow only bounded loopback port selection and published test modes', () => {
    expect(optionsFromArgs([])).toEqual({ keep: false, challenge: null, prepare: false, port: 46437 });
    expect(optionsFromArgs(['--keep', '--challenge', 'spent', '--port', '49000'])).toEqual({ keep: true, challenge: 'spent', prepare: false, port: 49000 });
    for (const args of [['--port', '65534'], ['--port', '0'], ['--port', 'no'], ['--host', '0.0.0.0'], ['--challenge', 'real'], ['--prepare', '--keep']]) expect(() => optionsFromArgs(args)).toThrow();
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
    expect(text).toContain('paste into Text to replace');
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

  test('missing renderer has a plain preparation command, without creating throwaway state', async () => {
    await expect(assertPrerequisites({ seed: path.join(PROJECT_ROOT, '.workspace/no-such-suggestions-seed') })).rejects.toThrow(PREPARE_COMMAND);
  });
});

const realTest = process.env.SUGGESTIONS_REHEARSAL_REAL_QUARTZ === '1' ? test : test.skip;
realTest('noninteractive launcher: real rendered form, HTTP queue/page limit, Approve, Apply, rebuilt page and complete cleanup', async () => {
  await assertPrerequisites();
  const port = freePorts();
  const owner = `http://127.0.0.1:${port}`;
  const reader = `http://127.0.0.1:${port + 1}`;
  const intake = `http://127.0.0.1:${port + 2}`;
  const child = Bun.spawn([process.execPath, path.join(PROJECT_ROOT, 'apps/owner-alpha/bin/suggestions-rehearsal.js'), '--port', String(port)],
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
    const pageUrl = `${reader}/cyberbase/mfa-methods`;
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
    expect(await readFile(path.join(root, 'vault/mfa-methods.md'), 'utf8')).toBe(PAGES['mfa-methods.md']);
    const apply = await auth(`/api/review/${queueId}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queueId, csrf }) });
    expect(apply.status).toBe(202);
    const job = await apply.json();
    const completed = await until(async () => {
      const response = await auth(`/api/jobs/${job.jobId}`);
      const state = await response.json();
      if (['failed', 'blocked-pre-apply', 'manual-intervention', 'deployment-failed'].includes(state.state)) throw new Error(`Local job stopped: ${state.state} ${JSON.stringify(state.failure)}`);
      return state.state === 'completed' ? state : null;
    }, 150_000);
    expect(completed.state).toBe('completed');
    expect(await readFile(path.join(root, 'vault/mfa-methods.md'), 'utf8')).toBe(PAGES['mfa-methods.md'].replace(QUOTE, REPLACEMENT));
    expect(await readFile(path.join(root, 'vault/recovery-codes.md'), 'utf8')).toBe(PAGES['recovery-codes.md']);
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
    for (const origin of [owner, reader, intake]) {
      await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    }
  } finally {
    // No force-removal: if shutdown cannot settle, preserve evidence rather than
    // deleting a vault under an active source-writing job.
    await stop();
  }
}, 330_000);
