import { prepareProposal, createChangeSetProposal, applyChangeSetProposal, describeChangeSet, changeSetProposalDigest } from '@cyberbaser/proposal';
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
    proposal: prepareProposal(Buffer.from('Correct teh typo.\n\n## Notes\n\nA second paragraph that stays untouched.\n\n- first item\n- second item\n'), {
      proposalId: `browser-review:${number}`,
      source: { repository: 'https://forge.example/owner/wiki.git', revision: 'a'.repeat(40), path: 'docs/notes.md' },
      operation: { type: 'quote', selector: { quote: 'teh', prefix: 'Correct ', suffix: ' typo.' }, replacement },
      submission: { submittedAt: `2026-08-21T12:00:0${number}Z`, rationale, evidence: ['https://example.com/reference'], identityClaim: null },
    }),
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

function statefulReviewService({ multi = false } = {}) {
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
  if (multi) {
    const entry = entries[0];
    const original = entry.evidence.proposal;
    const base = Buffer.from(entry.document.baseText);
    const proposal = createChangeSetProposal(base, {
      proposalId: original.proposalId, source: original.source, submission: original.submission,
      operations: [
        { operationId: 'spelling', start: base.indexOf('teh'), end: base.indexOf('teh') + 3, expected: 'teh', replacement: 'the' },
        { operationId: 'list-word', start: base.indexOf('second item'), end: base.indexOf('second item') + 6, expected: 'second', replacement: 'another' },
      ],
    });
    entry.evidence.proposal = proposal;
    entry.changes = describeChangeSet(base, proposal);
    entry.document.candidateText = applyChangeSetProposal(base, proposal).toString('utf8');
    entry.summary.proposalDigest = changeSetProposalDigest(proposal);
    entry.summary.candidateDigest = proposal.changeSet.files[0].candidate.digest;
  }
  const decisions = new Map();
  const applications = new Map();
  let failNextRecord = !multi;

  function history() {
    return [...decisions.values()]
      .sort((left, right) => right.decision.decidedAt.localeCompare(left.decision.decidedAt));
  }

  return Object.freeze({
    entries,
    applications,
    applicationAvailable: true,
    async applicationStatus(queueId) {
      // Like the real service, report the job's current stage, not the stage at the act.
      const recorded = applications.get(queueId) ?? null;
      const applied = recorded === null ? null : { ...recorded, jobState: 'pushing' };
      const attempts = applied === null ? [] : [applied];
      return { queueId, state: applied === null ? 'eligible' : 'applied', reason: null, details: {}, branchTip: 'c'.repeat(40), input: null, attempts, latest: applied };
    },
    async apply(queueId) {
      if (applications.has(queueId)) {
        return { applied: false, status: await this.applicationStatus(queueId), event: null, job: null };
      }
      const attempt = { attempt: 1, appliedAt: '2026-08-21T12:20:00Z', jobId: `OA-browser-${applications.size + 1}`, jobState: 'accepted', failure: null, retryable: false };
      applications.set(queueId, attempt);
      return { applied: true, status: await this.applicationStatus(queueId), event: { attempt: 1 }, job: { jobId: attempt.jobId, state: 'accepted' } };
    },
    async list() {
      return {
        actionable: entries.filter((entry) => !decisions.has(entry.summary.queueId)),
        history: history().map((entry) => {
          const recorded = applications.get(entry.decision.queueId) ?? null;
          return { ...entry, application: recorded === null ? null : { state: 'applied', jobId: recorded.jobId, jobState: 'pushing', appliedAt: recorded.appliedAt } };
        }),
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

async function browserFixture(options = {}) {
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
  const proposalReview = statefulReviewService(options);
  const ownerFetch = createOwnerAlphaHandler({
    config,
    proposalReview,
    createEditSession: async () => { throw new Error('not available'); },
    saveEdit: async () => { throw new Error('not available'); },
    lookupJob: async (jobId) => {
      const applied = [...proposalReview.applications.values()].find((attempt) => attempt.jobId === jobId);
      if (!applied) return null;
      return {
        jobId,
        state: 'pushing',
        origin: { type: 'approved-proposal', queueId: [...proposalReview.applications.keys()][0], relativePath: 'docs/notes.md' },
        revision: 7,
        createdAt: '2026-08-21T12:20:00.000Z',
        updatedAt: '2026-08-21T12:20:09.000Z',
        recovery: { classification: 'restart-safe', automatic: true, instruction: 'Resume the exact push.' },
        failure: null,
      };
    },
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
      if (request.method() === 'POST' && request.url().includes('/api/review/') && request.url().endsWith('/decision')) decisionPosts += 1;
    });

    await page.goto(`${fixture.ownerOrigin}/owner/bootstrap?token=${fixture.servers.bootstrapToken}`);
    await page.waitForURL(`${fixture.readerOrigin}/cyberbase/`);
    await page.click('#review-link');
    await page.waitForURL(`${fixture.ownerOrigin}/owner/review`);
    await expect(page.locator('h1').textContent()).resolves.toBe('Proposals');
    await expect(page.locator('#needs-review .proposal-row').count()).resolves.toBe(2);
    await expect(page.locator('#needs-review .proposal-row-count').allTextContents()).resolves.toEqual(['1 change', '1 change']);
    await expect(page.locator('#needs-review .proposal-row').first().textContent()).resolves.toContain('From a visitor');
    await capture(page, 'inbox-light-desktop');

    await Promise.all([
      page.waitForURL(`${fixture.ownerOrigin}/owner/review/**`),
      page.locator('#needs-review .proposal-row-link').first().click(),
    ]);
    // Content first: the note, as the site shows it, in a sandboxed frame; the
    // private panel beside it holds the decision.
    const frameElement = page.locator('#rv-frame');
    await expect(frameElement.getAttribute('sandbox')).resolves.toBe('');
    const note = page.frameLocator('#rv-frame');
    await expect(note.locator('h1').textContent()).resolves.toBe('Notes');
    await expect(note.locator('del').allTextContents()).resolves.toEqual(['teh']);
    await expect(note.locator('ins').allTextContents()).resolves.toEqual(['the']);
    await expect(note.locator('ul li').count()).resolves.toBe(2);
    await expect(note.locator('h3').textContent()).resolves.toBe('Notes');
    await expect(page.locator('.rv-sheet h1').textContent()).resolves.toBe('1 change');
    await expect(page.locator('.rv-from').textContent()).resolves.toBe('From a visitor, not signed in.');
    const frameBox = await frameElement.boundingBox();
    const sheetBox = await page.locator('#rv-sheet').boundingBox();
    expect(frameBox.x + frameBox.width).toBeLessThanOrEqual(sheetBox.x);
    await capture(page, 'proposal-light-desktop');

    // Exact evidence stays one tap away, with its comparison modes.
    await page.locator('.rv-details > summary').click();
    const changesTab = page.getByRole('link', { name: 'Changes' });
    const currentTab = page.getByRole('link', { name: 'Current' });
    const compareTab = page.getByRole('link', { name: 'Compare' });
    await page.locator('#publication-review-details > details > summary').click();
    await expect(changesTab.getAttribute('aria-current')).resolves.toBe('page');
    await expect(page.locator('.mode-panel-changes .md-source del').count()).resolves.toBe(1);
    await expect(page.locator('.mode-panel-changes .md-source ins').count()).resolves.toBe(1);
    await Promise.all([page.waitForURL(/[?]mode=current$/u), currentTab.click()]);
    await expect(page.locator('.mode-panel-current .md-source ins').count()).resolves.toBe(0);
    await currentTab.focus();
    await currentTab.press('End');
    await expect(compareTab.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    await compareTab.press('Home');
    await expect(changesTab.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    await Promise.all([page.waitForURL(/[?]mode=changes$/u), changesTab.click()]);

    // Approve opens one sheet; the note is asked for there and checked on confirm.
    const approve = page.locator('.rv-act [data-action="approve"]');
    const sheet = page.locator('#decision-dialog');
    await approve.click();
    await expect(sheet.evaluate((element) => element.open)).resolves.toBe(true);
    await expect(page.locator('#decision-dialog-title').textContent()).resolves.toBe('Approve this proposal?');
    const reasonField = page.locator('#decision-reason');
    await expect(reasonField.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    const confirm = page.locator('#decision-confirm');
    await expect(confirm.textContent()).resolves.toBe('Approve');
    await confirm.click();
    await expect(page.locator('#decision-status').textContent()).resolves.toContain('Write a short note');
    expect(decisionPosts).toBe(0);

    await reasonField.fill('🧭'.repeat(1025));
    await expect(page.locator('#decision-byte-count').textContent()).resolves.toContain('4100 of 4096');
    await expect(page.locator('#decision-byte-count').evaluate((element) => getComputedStyle(element).display)).resolves.toBe('block');
    await confirm.click();
    await expect(page.locator('#decision-status').textContent()).resolves.toContain('4096 UTF-8 bytes or fewer');

    await reasonField.fill('The wording is clear and correct.');
    await expect(page.locator('#decision-byte-count').evaluate((element) => getComputedStyle(element).display)).resolves.toBe('none');
    expect(decisionPosts).toBe(0);
    await page.keyboard.press('Escape');
    await expect(sheet.evaluate((element) => element.open)).resolves.toBe(false);
    await expect(approve.evaluate((element) => element === document.activeElement)).resolves.toBe(true);

    // Phone: the page on top, the panel at the bottom, nothing wider than the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const phoneFrame = await frameElement.boundingBox();
    const phoneSheet = await page.locator('#rv-sheet').boundingBox();
    expect(phoneFrame.y + phoneFrame.height).toBeLessThanOrEqual(phoneSheet.y + 1);
    expect(Math.abs((phoneSheet.y + phoneSheet.height) - 844)).toBeLessThanOrEqual(2);
    expect(await page.locator('.rv-details').evaluate((element) => element.open)).toBe(true);
    await page.locator('#rv-fold').click();
    await expect(page.locator('#rv-body').isVisible()).resolves.toBe(false);
    await expect(page.locator('#rv-fold').getAttribute('aria-expanded')).resolves.toBe('false');
    await page.locator('#rv-fold').click();
    await capture(page, 'proposal-dark-mobile');
    await approve.click();
    await expect(reasonField.inputValue()).resolves.toBe('The wording is clear and correct.');
    const dialogBox = await page.locator('#decision-dialog').boundingBox();
    expect(Math.abs((dialogBox.y + dialogBox.height) - 844)).toBeLessThanOrEqual(2);
    await capture(page, 'approval-confirm-dark-mobile');
    expect(decisionPosts).toBe(0);

    // A refused write keeps the sheet, the note and the choice; retrying records it.
    await confirm.click();
    await page.waitForFunction(() => document.querySelector('#decision-status')?.textContent
      ?.includes('Another owner action is finishing'));
    expect(decisionPosts).toBe(1);
    await expect(sheet.evaluate((element) => element.open)).resolves.toBe(true);
    await expect(reasonField.inputValue()).resolves.toBe('The wording is clear and correct.');
    await confirm.click();
    await page.waitForURL(`${fixture.ownerOrigin}/owner/decisions/**`);
    expect(decisionPosts).toBe(2);
    await expect(page.locator('#application-heading').textContent()).resolves.toBe('Approved');
    await expect(page.getByText('The page has not changed. Applying is a separate step.', { exact: true }).count()).resolves.toBe(1);
    await expect(page.locator('[data-action]').count()).resolves.toBe(0);
    await expect(page.frameLocator('#rv-frame').locator('ins').allTextContents()).resolves.toEqual(['the']);
    // The separate step: put it on the page. One button, one sheet, then the job.
    const applyButton = page.getByRole('button', { name: 'Apply to page', exact: true });
    await expect(applyButton.count()).resolves.toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(page, 'approval-receipt-dark-mobile');
    const receiptUrl = page.url();
    await applyButton.click();
    await expect(page.locator('#apply-dialog-title').textContent()).resolves.toBe('Apply to the page?');
    await expect(page.locator('#apply-confirm').evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    await capture(page, 'apply-confirm-dark-mobile');
    await page.keyboard.press('Escape');
    await expect(page.locator('#decision-dialog').evaluate((element) => element.open)).resolves.toBe(false);
    await expect(applyButton.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
    await applyButton.click();
    await page.locator('#apply-confirm').click();
    await page.waitForURL(`${fixture.ownerOrigin}/owner/jobs/OA-browser-1`);
    await expect(page.locator('h1').textContent()).resolves.toBe('notes'); // the saving page is headed by the note's title;
    await page.waitForFunction(() => document.querySelector('#job-stage')?.textContent === 'Saving');
    await expect(page.locator('.job-step[data-status="done"]').count()).resolves.toBe(1); // Checking is done; steps are Checking, Saving, Updating the site, Done;
    await expect(page.locator('.job-step[data-status="current"]').textContent()).resolves.toBe('Saving');
    await expect(page.getByRole('link', { name: 'Back to the suggestion' }).count()).resolves.toBe(1);
    await capture(page, 'apply-job-dark-mobile');
    await page.goto(receiptUrl);
    await expect(page.locator('#application-heading').textContent()).resolves.toBe('Applying');
    await expect(page.locator('.application-stage strong').textContent()).resolves.toBe('Pushing to your repository');
    await expect(page.getByRole('link', { name: 'Follow it' }).getAttribute('href')).resolves.toBe('/owner/jobs/OA-browser-1');
    await expect(page.getByRole('button', { name: 'Apply to page', exact: true }).count()).resolves.toBe(0);
    await capture(page, 'applied-receipt-dark-mobile');
    await Promise.all([
      page.waitForURL(`${fixture.ownerOrigin}/owner/review`),
      page.getByRole('link', { name: 'Back to Proposals' }).click(),
    ]);
    await expect(page.locator('#decided .decision-label').first().textContent()).resolves.toBe('Applied');
    await expect(page.locator('#decided .proposal-row').count()).resolves.toBe(1);
    await capture(page, 'decided-dark-mobile');
    await Promise.all([
      page.waitForURL(`${fixture.ownerOrigin}/owner/review/**`),
      page.locator('#needs-review .proposal-row-link').click(),
    ]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await page.locator('.rv-act [data-action="reject"]').click();
    await expect(page.locator('#decision-dialog-title').textContent()).resolves.toBe('Reject this proposal?');
    await expect(confirm.textContent()).resolves.toBe('Reject');
    await page.locator('#decision-reason').fill('The suggestion changes the intended meaning.');
    await capture(page, 'rejection-confirm-light-desktop');
    expect(decisionPosts).toBe(2);
    await confirm.click();
    await page.waitForURL(`${fixture.ownerOrigin}/owner/decisions/**`);
    await expect(page.locator('#application-heading').textContent()).resolves.toBe('Rejected');
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


acceptanceTest('browser v2 reviews every change and makes one whole-set decision before a separate application', async () => {
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const action of ['approve', 'reject']) {
      const fixture = await browserFixture({ multi: true });
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const decisions = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().endsWith('/decision')) decisions.push(request.postDataJSON());
      });
      await page.goto(`${fixture.ownerOrigin}/owner/bootstrap?token=${fixture.servers.bootstrapToken}`);
      await page.waitForURL(`${fixture.readerOrigin}/cyberbase/`);
      await page.click('#review-link');
      await page.waitForURL(`${fixture.ownerOrigin}/owner/review`);
      const row = page.locator('#needs-review .proposal-row').first();
      expect(await row.locator('.proposal-row-title').textContent()).toBe('Notes');
      expect(await row.locator('.proposal-row-count').textContent()).toBe('2 changes');
      await row.locator('.proposal-row-link').click();
      await page.waitForURL(`${fixture.ownerOrigin}/owner/review/**`);
      // Every change is on the page, reachable from the panel, and exact in Details.
      const note = page.frameLocator('#rv-frame');
      expect(await note.locator('del').allTextContents()).toEqual(['teh', 'second']);
      expect(await note.locator('ins').allTextContents()).toEqual(['the', 'another']);
      expect(await page.locator('#rv-pos').textContent()).toBe('1 of 2');
      await page.locator('#rv-next').click();
      expect(await page.locator('#rv-pos').textContent()).toBe('2 of 2');
      await page.waitForFunction(() => document.querySelector('#rv-frame').getAttribute('src').endsWith('/page#c2'));
      await page.locator('#rv-list-toggle').click();
      expect(await page.locator('#rv-list li').count()).toBe(2);
      expect(await page.locator('#rv-list a[aria-current="true"]').textContent()).toContain('second');
      await page.locator('#rv-list a[data-change="1"]').click();
      expect(await page.locator('#rv-pos').textContent()).toBe('1 of 2');
      expect(await page.locator('.inspected-change').count()).toBe(2);
      expect(await page.locator('.inspected-change').first().textContent()).toContain('Line 1, column 9');
      expect(await page.locator('.inspected-change').last().textContent()).toContain('another');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.locator(`.rv-act [data-action="${action}"]`).click();
      expect(await page.locator('#decision-dialog-title').textContent()).toBe(action === 'approve' ? 'Approve all 2 changes?' : 'Reject all 2 changes?');
      await page.locator('#decision-reason').fill('Decide both changes as one suggestion.');
      await page.locator('#decision-confirm').click();
      await page.waitForURL(`${fixture.ownerOrigin}/owner/decisions/**`);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].action).toBe(action);
      expect(Object.keys(decisions[0]).sort()).toEqual(['action', 'csrf', 'queueId', 'reason', 'reviewEvidenceDigest']);
      expect(fixture.proposalReview.applications.size).toBe(0);
      expect(await page.locator('.inspected-change').count()).toBe(2);
      if (action === 'approve') {
        await page.getByRole('button', { name: 'Apply to page', exact: true }).click();
        await page.locator('#apply-confirm').click();
        await page.waitForURL(`${fixture.ownerOrigin}/owner/jobs/OA-browser-1`);
        expect(fixture.proposalReview.applications.size).toBe(1);
      } else {
        expect(await page.getByRole('button', { name: 'Apply to page', exact: true }).count()).toBe(0);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}, 60_000);
