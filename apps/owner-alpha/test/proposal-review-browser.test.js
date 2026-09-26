import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OwnerAlphaError,
  createOwnerAlphaHandler,
  startOwnerAlphaServers,
  validateOwnerAlphaConfig,
} from '../src/index.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../../..');
const APP_ROOT = path.resolve(import.meta.dir, '..');
const EXAMPLE = path.join(APP_ROOT, 'owner-alpha.example.json');
const PLAYWRIGHT = path.join(PROJECT_ROOT, 'docs', 'node_modules', 'playwright', 'index.js');
const SCREENSHOTS = process.env.OWNER_ALPHA_REVIEW_SCREENSHOTS ?? null;
const running = [];

async function capture(page, name) {
  if (SCREENSHOTS === null) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`), fullPage: true });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function digest(byte) {
  return `sha-256=:${Buffer.alloc(32, byte).toString('base64')}:`;
}

function reviewEntry(number, { replacement, rationale }) {
  const queueId = `Q-00000000-0000-4000-8000-00000000000${number}`;
  const reviewDigest = digest(number);
  const evidence = {
    queueId,
    proposal: {
      proposalId: `browser-review:${number}`,
      source: {
        repository: 'https://forge.example/owner/wiki.git',
        revision: 'a'.repeat(40),
        path: 'docs/notes.md',
      },
      operation: {
        type: 'quote',
        selector: { prefix: 'Correct ', quote: 'teh', suffix: ' typo.' },
        start: 8,
        end: 11,
        baseDigest: digest(7),
        candidateDigest: digest(number + 10),
        expectedOldBytesBase64: Buffer.from('teh').toString('base64'),
        replacementBytesBase64: Buffer.from(replacement).toString('base64'),
      },
      submission: {
        rationale,
        evidence: ['https://example.com/reference'],
      },
    },
    classification: {
      verifiedSubject: null,
      policyStatus: 'valid',
      policyDigest: digest(8),
      classification: {
        tier: 'anonymous',
        route: 'full-review',
        reasons: ['anonymous-author'],
        checks: {},
      },
    },
    state: { state: 'pending-review' },
  };
  const baseText = 'Correct teh typo.\n\n## Notes\n\nA second paragraph that stays untouched.\n\n- first item\n- second item\n';
  const candidateText = baseText.replace('teh', replacement);
  return {
    document: { baseText, candidateText, reason: null },
    summary: {
      schemaVersion: 1,
      artifactType: 'cyberbaser-proposal-review-summary',
      queueId,
      proposalId: evidence.proposal.proposalId,
      proposalDigest: reviewDigest,
      candidateDigest: evidence.proposal.operation.candidateDigest,
      reviewEvidenceDigest: reviewDigest,
      source: evidence.proposal.source,
      receivedAt: `2026-08-21T12:00:0${number}Z`,
      expiresAt: '2026-09-20T12:00:00Z',
      state: 'pending-review',
      lane: 'lane-b',
      tier: 'anonymous',
      route: 'full-review',
    },
    evidence,
    sourceVerification: { gitObjectId: 'b'.repeat(40) },
  };
}

function decisionSummary(decision, entry) {
  return {
    queueId: decision.queueId,
    action: decision.action,
    reason: decision.reason,
    decidedAt: decision.decidedAt,
    reviewEvidenceDigest: entry.summary.reviewEvidenceDigest,
    proposalId: entry.summary.proposalId,
    proposalDigest: entry.summary.proposalDigest,
    candidateDigest: entry.summary.candidateDigest,
    source: entry.summary.source,
    receivedAt: entry.summary.receivedAt,
    expiresAt: entry.summary.expiresAt,
    lane: entry.summary.lane,
    tier: entry.summary.tier,
    route: entry.summary.route,
  };
}

function statefulReviewService() {
  const entries = [
    reviewEntry(1, {
      replacement: 'the',
      rationale: 'Correct the obvious spelling error without changing the sentence meaning.',
    }),
    reviewEntry(2, {
      replacement: 'that',
      rationale: 'Prefer a demonstrative determiner in this sentence.',
    }),
  ];
  const decisions = new Map();
  let failNextRecord = true;

  function history() {
    return [...decisions.values()]
      .sort((left, right) => right.decision.decidedAt.localeCompare(left.decision.decidedAt));
  }

  return Object.freeze({
    entries,
    async list() {
      return {
        actionable: entries.filter((entry) => !decisions.has(entry.summary.queueId)),
        history: history(),
        historyTruncated: false,
        nextCursor: null,
      };
    },
    async load(queueId) {
      const decided = decisions.get(queueId);
      if (decided) return { entry: null, decision: decided.decision };
      const entry = entries.find((candidate) => candidate.summary.queueId === queueId);
      if (!entry) throw new OwnerAlphaError('review-ipc-not-found', 'not found');
      return { entry, decision: null };
    },
    async loadDecision(queueId) {
      return decisions.get(queueId) ?? null;
    },
    async record(intent) {
      if (failNextRecord) {
        failNextRecord = false;
        throw new OwnerAlphaError('lock-busy', 'busy');
      }
      const entry = entries.find((candidate) => candidate.summary.queueId === intent.queueId);
      const sequence = decisions.size + 1;
      const decision = {
        queueId: intent.queueId,
        action: intent.action,
        reason: intent.reason,
        decidedAt: `2026-08-21T12:10:0${sequence}Z`,
        decisionAuthority: { type: 'owner-alpha-local', identity: 'owner' },
        authorityScope: 'decision-only',
        reviewEvidenceDigest: entry.summary.reviewEvidenceDigest,
        reviewEvidence: entry.evidence,
        effectBoundary: {
          appliesSource: false,
          writesSource: false,
          commits: false,
          pushes: false,
          rebuilds: false,
          deploys: false,
          publishes: false,
        },
      };
      const summary = decisionSummary(decision, entry);
      decisions.set(intent.queueId, { decision, summary, queueRetained: true });
      return {
        decision,
        replayed: false,
        index: { decisions: history().map((item) => item.summary) },
      };
    },
  });
}

async function browserFixture() {
  let ownerPort;
  while (true) {
    ownerPort = await freePort();
    if (ownerPort >= 65_535) continue;
    try {
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(ownerPort + 1, '127.0.0.1', () => server.close(resolve));
      });
      break;
    } catch {
      // Try another consecutive pair.
    }
  }
  const readerPort = ownerPort + 1;
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  raw.listen.port = ownerPort;
  raw.listen.readerPort = readerPort;
  raw.proposalReview.enabled = true;
  raw.proposalReview.socketPath = '/run/user/1000/cyberbaser/review.sock';
  const config = validateOwnerAlphaConfig(raw);
  const proposalReview = statefulReviewService();
  const ownerFetch = createOwnerAlphaHandler({
    config,
    proposalReview,
    createEditSession: async () => { throw new Error('not available'); },
    saveEdit: async () => { throw new Error('not available'); },
    lookupJob: async () => null,
  });
  const ownerOrigin = `http://127.0.0.1:${ownerPort}`;
  const readerOrigin = `http://127.0.0.1:${readerPort}`;
  const readerFetch = async (request) => {
    if (request.headers.get('host') !== `127.0.0.1:${readerPort}`) return new Response('invalid host', { status: 421 });
    const url = new URL(request.url);
    if (url.pathname !== '/cyberbase/' && url.pathname !== '/cyberbase') return new Response('not found', { status: 404 });
    return new Response(`<!doctype html><html><body><a id="review-link" href="${ownerOrigin}/owner/review">Review proposals</a></body></html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
  const servers = startOwnerAlphaServers({ config, ownerFetch, readerFetch });
  running.push(servers);
  return { ownerOrigin, readerOrigin, servers, proposalReview };
}

afterEach(() => {
  for (const servers of running.splice(0)) servers.stop(true);
});

const acceptanceTest = process.env.OWNER_ALPHA_ACCEPTANCE === '1' ? test : test.skip;

acceptanceTest('browser review is content-first, deliberate, recoverable, and responsive', async () => {
  const fixture = await browserFixture();
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
    });
    const page = await context.newPage();
    let decisionPosts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/review/')) decisionPosts += 1;
    });

    await page.goto(`${fixture.ownerOrigin}/owner/bootstrap?token=${fixture.servers.bootstrapToken}`);
    await page.waitForURL(`${fixture.readerOrigin}/cyberbase/`);
    await page.click('#review-link');
    await page.waitForURL(`${fixture.ownerOrigin}/owner/review`);
    await expect(page.locator('h1').textContent()).resolves.toBe('Proposals');
    await expect(page.locator('#needs-review .proposal-row').count()).resolves.toBe(2);
    await capture(page, 'inbox-light-desktop');

    await Promise.all([
      page.waitForURL(`${fixture.ownerOrigin}/owner/review/**`),
      page.locator('#needs-review .proposal-row-link').first().click(),
    ]);
    const changesTab = page.getByRole('link', { name: 'Changes' });
    const proposedTab = page.getByRole('link', { name: 'Proposed' });
    const currentTab = page.getByRole('link', { name: 'Current' });
    const compareTab = page.getByRole('link', { name: 'Compare' });
    await expect(changesTab.getAttribute('aria-current')).resolves.toBe('page');
    await expect(page.locator('.mode-panel-changes .md-heading').count()).resolves.toBeGreaterThan(0);
    await expect(page.locator('.mode-panel-changes .md-list li').count()).resolves.toBe(2);
    await expect(page.locator('.md-source-label').first().textContent()).resolves.toContain('Exact source');
    await expect(page.locator('.md-source del').count()).resolves.toBe(1);
    await expect(page.locator('.md-source ins').count()).resolves.toBe(1);
    await capture(page, 'proposal-light-desktop');

    await Promise.all([
      page.waitForURL(/[?]mode=current$/u),
      currentTab.click(),
    ]);
    await expect(page.locator('.mode-panel-current .md-source ins').count()).resolves.toBe(0);
    await expect(page.locator('.mode-panel-current .md-source del').count()).resolves.toBe(1);
    await Promise.all([
      page.waitForURL(/[?]mode=proposed$/u),
      proposedTab.click(),
    ]);
    await expect(page.locator('.mode-panel-proposed .md-source del').count()).resolves.toBe(0);
    await Promise.all([
      page.waitForURL(/[?]mode=compare$/u),
      compareTab.click(),
    ]);
    await expect(page.locator('.proof').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))))
      .resolves.toEqual(['Current source', 'Proposed change']);
    await currentTab.focus();
    await currentTab.press('End');
    await expect(compareTab.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    await compareTab.press('Home');
    await expect(changesTab.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    await Promise.all([
      page.waitForURL(/[?]mode=changes$/u),
      changesTab.click(),
    ]);

    // Approve opens one sheet; the note is asked for there and checked on confirm.
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    const sheet = page.locator('#decision-dialog');
    await expect(page.locator('.decision-bar-change strong').textContent()).resolves.toContain('“teh” to “the”');
    await approve.click();
    await expect(sheet.evaluate((element) => element.open)).resolves.toBe(true);
    await expect(page.locator('#decision-dialog-title').textContent()).resolves.toBe('Approve this suggestion?');
    const note = page.locator('#decision-reason');
    await expect(note.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    const confirmApproval = page.getByRole('button', { name: 'Approve suggestion' });
    await confirmApproval.click();
    await expect(page.locator('#decision-status').textContent()).resolves.toContain('Write a short note');
    expect(decisionPosts).toBe(0);

    await note.fill('🧭'.repeat(1025));
    await expect(page.locator('#decision-byte-count').textContent()).resolves.toContain('4100 of 4096');
    await expect(page.locator('#decision-byte-count').evaluate((element) => getComputedStyle(element).display)).resolves.toBe('block');
    await confirmApproval.click();
    await expect(page.locator('#decision-status').textContent()).resolves.toContain('4096 UTF-8 bytes or fewer');

    await note.fill('The wording is clear and correct.');
    await expect(page.locator('#decision-byte-count').evaluate((element) => getComputedStyle(element).display)).resolves.toBe('none');
    expect(decisionPosts).toBe(0);
    await page.keyboard.press('Escape');
    await expect(sheet.evaluate((element) => element.open)).resolves.toBe(false);
    await expect(approve.evaluate((element) => element === document.activeElement)).resolves.toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator('.md-source').first().evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('pre-wrap');
    expect(await page.locator('.technical-evidence').evaluate((element) => element.open)).toBe(false);
    await capture(page, 'exact-dark-mobile');
    await approve.click();
    await expect(note.inputValue()).resolves.toBe('The wording is clear and correct.');
    const dialogBox = await page.locator('#decision-dialog').boundingBox();
    expect(Math.abs((dialogBox.y + dialogBox.height) - 844)).toBeLessThanOrEqual(2);
    await capture(page, 'approval-confirm-dark-mobile');
    expect(decisionPosts).toBe(0);

    await confirmApproval.click();
    await page.waitForFunction(() => document.querySelector('#decision-status')?.textContent
      ?.includes('Another owner action is finishing'));
    expect(decisionPosts).toBe(1);
    await expect(sheet.evaluate((element) => element.open)).resolves.toBe(true);
    await expect(note.inputValue()).resolves.toBe('The wording is clear and correct.');
    await confirmApproval.click();
    await page.waitForURL(`${fixture.ownerOrigin}/owner/decisions/**`);
    expect(decisionPosts).toBe(2);
    await expect(page.getByText('Source unchanged', { exact: true }).textContent()).resolves.toBe('Source unchanged');
    await expect(page.getByText('No application, write, commit, push, rebuild, deployment, or publication started.').count()).resolves.toBe(1);
    await expect(page.locator('[data-action]').count()).resolves.toBe(0);
    await capture(page, 'approval-receipt-dark-mobile');

    await Promise.all([
      page.waitForURL(`${fixture.ownerOrigin}/owner/review`),
      page.getByRole('link', { name: 'Back to Proposals' }).click(),
    ]);
    await expect(page.locator('#decided .proposal-row').count()).resolves.toBe(1);
    await capture(page, 'decided-dark-mobile');
    await Promise.all([
      page.waitForURL(`${fixture.ownerOrigin}/owner/review/**`),
      page.locator('#needs-review .proposal-row-link').click(),
    ]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(page.locator('#decision-dialog-title').textContent()).resolves.toBe('Reject this suggestion?');
    await page.locator('#decision-reason').fill('The suggestion changes the intended meaning.');
    await capture(page, 'rejection-confirm-light-desktop');
    expect(decisionPosts).toBe(2);
    await page.getByRole('button', { name: 'Reject suggestion' }).click();
    await page.waitForURL(`${fixture.ownerOrigin}/owner/decisions/**`);
    await expect(page.locator('h1').textContent()).resolves.toBe('Proposal rejected');
    await capture(page, 'rejection-receipt-light-desktop');
    await Promise.all([
      page.waitForURL(`${fixture.ownerOrigin}/owner/review`),
      page.getByRole('link', { name: 'Back to Proposals' }).click(),
    ]);
    await expect(page.locator('#needs-review .proposal-row').count()).resolves.toBe(0);
    await expect(page.locator('#decided .proposal-row').count()).resolves.toBe(2);
    await expect(page.locator('#decided .proposal-row').first().textContent()).resolves.toContain('Rejected');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await browser.close();
  }
}, 120_000);
