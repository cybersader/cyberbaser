#!/usr/bin/env bun
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORM_ORIGIN,
  configInput,
  createFixture,
  request as intakeRequest,
} from '../../account-free-intake/test/helpers.js';
import {
  openIntakeService,
  startReviewIpcServer,
  validateConfig as validateIntakeConfig,
} from '../../account-free-intake/src/index.js';
import {
  createOwnerAlphaHandler,
  createOwnerProposalReviewService,
  createOwnerProposalReviewSource,
  createProposalReviewClient,
  defineStoreContext,
  prepareStore,
  recoverProposalDecisions,
  startOwnerAlphaServers,
  validateOwnerAlphaConfig,
} from '../src/index.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INTAKE_REPOSITORY = 'https://forge.example:8443/owner/wiki.git';
const OWNER_HOST = '127.0.0.1';
const requestedPort = Number(process.env.CYBERBASER_UI_REVIEW_PORT ?? 4317);
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65534) {
  throw new TypeError('CYBERBASER_UI_REVIEW_PORT must be an integer from 1024 through 65534');
}
const OWNER_PORT = requestedPort;
const OWNER_ORIGIN = `http://${OWNER_HOST}:${OWNER_PORT}`;
const READER_ORIGIN = `http://${OWNER_HOST}:${OWNER_PORT + 1}`;
const statusInput = process.env.CYBERBASER_UI_REVIEW_STATUS_FILE
  ?? path.join(PROJECT_ROOT, '.workspace', 'live-review-ui', 'status.json');
const STATUS_FILE = path.isAbsolute(statusInput) ? path.normalize(statusInput) : path.resolve(PROJECT_ROOT, statusInput);
const NO_OPEN = process.env.CYBERBASER_UI_REVIEW_NO_OPEN === '1';

async function git(cwd, args) {
  const child = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout.trim();
}

function ownerConfig({ checkout, socketPath }) {
  return validateOwnerAlphaConfig({
    schemaVersion: 1,
    listen: { host: OWNER_HOST, port: OWNER_PORT },
    proposalReview: {
      enabled: true,
      socketPath,
      requestTimeoutMs: 5000,
      maxListEntries: 100,
    },
    repository: {
      checkout,
      remote: { name: 'origin', url: INTAKE_REPOSITORY },
      branch: 'main',
    },
    owner: {
      identity: 'owner',
      allowedTrustRoutes: ['auto-merge', 'quick-review'],
    },
    live: { baseUrl: 'https://published.example/' },
    workflow: {
      provider: 'forgejo-actions',
      apiBaseUrl: 'https://forge.example:8443/api/v1',
      repository: 'owner/wiki',
      path: '.forgejo/workflows/publish-site.yml',
      event: 'push',
      branch: 'main',
      jobs: ['build', 'deploy'],
      deploymentJob: 'deploy',
    },
    workspace: {
      root: '.workspace/owner-alpha',
      store: '.workspace/owner-alpha/store',
      site: '.workspace/owner-alpha/site',
      cache: '.workspace/owner-alpha/cache',
    },
    paths: { include: ['**/*.md'], exclude: ['.git/**', '.workspace/**'] },
    limits: {
      maxSourceBytes: 2_097_152,
      maxReplacementBytes: 65_536,
      maxChangedBytes: 65_536,
      maxChangedLines: 60,
      maxArtifactBytes: 8_388_608,
      requestTimeoutMs: 30_000,
      networkTimeoutMs: 900_000,
    },
    checks: {
      allowedOfmVerdicts: ['clean'],
      requirePublishedSource: true,
      requireProjectionVerification: true,
      requireNoNewBrokenLinks: true,
      requireRenderedWitness: true,
    },
    git: {
      autoCommit: true,
      autoPush: true,
      useHooks: true,
      commitMessagePrefix: 'owner-alpha:',
    },
  });
}

async function writeStatus(value) {
  await mkdir(path.dirname(STATUS_FILE), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(STATUS_FILE), 0o700);
  await writeFile(STATUS_FILE, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(STATUS_FILE, 0o600);
}

async function submit(service, fixture, overrides) {
  const response = await service.fetch(intakeRequest('/v1/corrections', {
    method: 'POST',
    origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixture.intent(overrides)),
  }));
  if (response.status !== 202) {
    throw new Error(`fixture proposal submission failed with status ${response.status}`);
  }
  return (await response.json()).receipt;
}

async function openBrowser(url) {
  const child = Bun.spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'pipe' });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`browser launch failed: ${stderr.trim() || `exit ${exitCode}`}`);
}

const fixture = await createFixture();
let intake;
let reviewIpc;
let servers;
let stopping = false;
let disposeInput = () => {};

async function settleWithin(promises, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([
    Promise.allSettled(promises).then(() => 'settled'),
    timeout,
  ]);
  clearTimeout(timer);
  return result;
}

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  disposeInput();
  servers?.stop(true);
  const runtimeCleanup = await settleWithin([
    reviewIpc?.close().catch(() => {}),
    intake?.close().catch(() => {}),
  ], 2_000);
  await writeStatus({
    state: 'stopped',
    pid: process.pid,
    stoppedAt: new Date().toISOString(),
    ownerOrigin: OWNER_ORIGIN,
    reviewUrl: `${OWNER_ORIGIN}/owner/review`,
    runtimeCleanup,
  }).catch(() => {});
  await settleWithin([fixture.cleanup().catch(() => {})], 2_000);
  process.exit(exitCode);
}

try {
  const reviewRuntime = path.join(fixture.root, 'review-runtime');
  await mkdir(reviewRuntime, { mode: 0o700 });
  await chmod(reviewRuntime, 0o700);
  const socketPath = path.join(reviewRuntime, 'review.sock');
  const intakeConfig = validateIntakeConfig(configInput(fixture.root, {
    reviewIpc: {
      enabled: true,
      socketPath,
      requestTimeoutMs: 5000,
      maxConcurrentRequests: 4,
      maxListEntries: 100,
    },
  }));
  intake = await openIntakeService({ config: intakeConfig });
  reviewIpc = await startReviewIpcServer({ config: intakeConfig, review: intake.review });

  const receipts = [];
  receipts.push(await submit(intake, fixture, {
    replacement: 'the',
    rationale: 'Correct the obvious spelling error in the published note.',
    evidence: ['https://www.merriam-webster.com/dictionary/the'],
  }));
  receipts.push(await submit(intake, fixture, {
    replacement: 'that',
    rationale: 'Prefer a demonstrative determiner for the sentence in this proposal.',
    evidence: ['https://www.merriam-webster.com/dictionary/that'],
  }));
  receipts.push(await submit(intake, fixture, {
    replacement: 'a',
    rationale: 'Simplify the phrase by replacing the misspelling with an indefinite article.',
    evidence: ['https://www.merriam-webster.com/dictionary/a'],
  }));

  const checkout = path.join(fixture.root, 'checkout');
  await git(checkout, ['remote', 'set-url', 'origin', INTAKE_REPOSITORY]);
  const ownerProject = path.join(fixture.root, 'owner-runtime');
  await mkdir(ownerProject, { mode: 0o700 });
  await git(ownerProject, ['init', '-q', '--initial-branch=main']);
  await writeFile(path.join(ownerProject, '.gitignore'), '.workspace/\n', { mode: 0o600 });
  const config = ownerConfig({ checkout, socketPath });
  const workspaceRoot = path.join(ownerProject, config.workspace.root);
  const storeRoot = path.join(ownerProject, config.workspace.store);
  const context = defineStoreContext({ projectRoot: ownerProject, workspaceRoot, storeRoot });
  await prepareStore(context);
  await recoverProposalDecisions(context);

  const client = createProposalReviewClient({
    socketPath,
    requestTimeoutMs: config.proposalReview.requestTimeoutMs,
  });
  const source = createOwnerProposalReviewSource({ config, client });
  const proposalReview = createOwnerProposalReviewService({ config, context, source });
  const ownerFetch = createOwnerAlphaHandler({
    config,
    projectRoot: ownerProject,
    proposalReview,
    createEditSession: async () => { throw new Error('UI review fixture does not expose editing'); },
    saveEdit: async () => { throw new Error('UI review fixture cannot apply source changes'); },
    lookupJob: async () => null,
  });
  const readerFetch = async (request) => {
    const url = new URL(request.url);
    if (request.headers.get('host') !== `${OWNER_HOST}:${OWNER_PORT + 1}`) {
      return new Response('invalid host', { status: 421 });
    }
    if (url.pathname === '/cyberbase/' || url.pathname === '/cyberbase') {
      return new Response(null, { status: 302, headers: { Location: `${OWNER_ORIGIN}/owner/review` } });
    }
    return new Response('not found', { status: 404 });
  };
  servers = startOwnerAlphaServers({ config, ownerFetch, readerFetch });

  const verificationBootstrap = `${OWNER_ORIGIN}/owner/bootstrap?token=${encodeURIComponent(servers.bootstrapToken)}`;
  const signIn = await fetch(verificationBootstrap, { redirect: 'manual' });
  if (signIn.status !== 303) throw new Error(`verification sign-in failed with status ${signIn.status}`);
  const cookie = signIn.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('verification sign-in did not issue a session cookie');
  const reviewPage = await fetch(`${OWNER_ORIGIN}/owner/review`, { headers: { Cookie: cookie } });
  const reviewHtml = await reviewPage.text();
  if (reviewPage.status !== 200 || !receipts.every((receipt) => reviewHtml.includes(receipt.queueId))) {
    throw new Error('owner review page did not render every live proposal');
  }

  async function issueAndOpenBrowser() {
    const token = ownerFetch.issueBootstrap();
    const bootstrapUrl = `${OWNER_ORIGIN}/owner/bootstrap?token=${encodeURIComponent(token)}`;
    await openBrowser(bootstrapUrl);
  }

  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const onData = (chunk) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (line.trim().toLowerCase() === 'b') {
          void issueAndOpenBrowser().catch((error) => {
            process.stderr.write(`Browser re-arm failed: ${error.message}\n`);
          });
        }
      }
    };
    process.stdin.on('data', onData);
    disposeInput = () => {
      process.stdin.off('data', onData);
      process.stdin.pause();
    };
  }

  process.once('SIGINT', () => { void stop(0); });
  process.once('SIGTERM', () => { void stop(0); });

  await writeStatus({
    state: 'ready',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ownerOrigin: OWNER_ORIGIN,
    readerOrigin: READER_ORIGIN,
    reviewUrl: `${OWNER_ORIGIN}/owner/review`,
    proposalCount: receipts.length,
  });
  if (!NO_OPEN) await issueAndOpenBrowser();
  process.stdout.write(`Owner review fixture ready: ${OWNER_ORIGIN}/owner/review\n`);
  if (!NO_OPEN) process.stdout.write('An authenticated browser launch was requested.\n');
  if (process.stdin.isTTY) process.stdout.write("Enter 'b' to issue and open a fresh one-time sign-in. Press Ctrl-C to stop.\n");
  await new Promise(() => {});
} catch (error) {
  process.stderr.write(`Owner review fixture failed: ${error?.code ?? error?.message ?? 'unexpected-error'}\n`);
  await stop(1);
}
