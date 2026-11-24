import { createOwnerHandoffStore } from './owner-direct.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewProposalBinding, OWNER_DECISION_REASON_MAX_BYTES } from '@cyberbaser/proposal-review';
import { validateDigest, validateQueueId } from '@cyberbaser/proposal-queue';
import { loadOwnerAlphaConfig, validateOwnerAlphaConfig } from './config.js';
import { recordProposalDecision, recoverProposalDecisions } from './proposal-decisions.js';
import { createOwnerProposalReviewService } from './proposal-review-service.js';
import { createProposalReviewClient } from './proposal-review-client.js';
import { createOwnerProposalReviewSource } from './proposal-review.js';
import { documentProjection, segmentsWithinSpan } from '@cyberbaser/review-projection';
import { fail, OwnerAlphaError } from './errors.js';
import { listDurableJobs, loadDurableJob, validateJobId } from './job-state.js';
import { ensureOwnerSite } from './site.js';
import { createEditSession as createSourceEditSession, liveUrlForSlug } from './source.js';
import { createUpstream } from './upstream.js';
import { prepareStore, storeContextFromConfig } from './store.js';
import { startSuggestionIntake, suggestionFormOrigin, suggestionChallengeOrigin } from './suggestions.js';
import { createOwnerPublicationRuntime, createPublicationSourceGuard } from './owner-publication-runtime.js';
import { hasHiddenProposalSource, proposalDisplay, publicationDisplay } from './publication-display.js';
import { excerptDocument, escapeHtml as escapeReviewHtml, FRAME_CSP, frameDocument, noticeShell, receiptShell, reviewModel, reviewShell } from './proposal-review-page.js';
import { SITE_FRAME_CSP, SITE_REVIEW_REASONS, siteReviewFrame } from './site-review-page.js';
import { rendererIdentity } from './renderer-slot.js';
import { createBundlePreview } from './bundle-preview.js';

import { createOwnerCommands, OwnerCommandPrecondition } from './core/commands.js';
import { createApprovalRelay, publisherSigningFromSocket } from './core/approvals.js';
import { createJobApprovals, pendingStarterFile } from './core/job-approvals.js';
import { openBundleDesk } from './core/bundle-desk.js';
import { BUNDLE_FRAME_CSP, BUNDLE_IMAGE_HEADERS, bundleFramePage, bundleListPage, bundleShellPage, sniffedImageType } from './bundle-review-page.js';
import { parsePageBundle } from '../../../packages/proposal/src/page-bundle.js';
import { bundleGit } from './core/page-bundle.js';
import { ownerRequest } from './publisher/owner-control.js';
import { createBootstrapPrincipalAdapter, createDevicePrincipalAdapter } from './core/principal.js';
import { assertOutsideVault, loadDeviceKeyRegistry } from './core/device-key-files.js';
import { openDeviceStore } from './core/device-store.js';
import { createPairingManager } from './core/pairing.js';
import { bindEndpoint, CMD_ALPN, irohAudience, loadNodeSecret, PAIR_ALPN, startIrohCarrier } from './iroh-carrier.js';
import { qrMatrix, qrPath } from './qr.js';
import { createNoteStatus } from './note-status.js';
import { openNoteLinks } from './note-links.js';
import { createMemoryEditSessionStore } from './core/edit-sessions.js';
import { signedSocketAudience, startSignedRequestSocket } from './signed-request-socket.js';
import { createForgeSetup, handleForgeSetup } from './forge-setup.js';

export { createOwnerProposalReviewService, createMemoryEditSessionStore };

// Shared with first-run setup so both servers answer with the same headers,
// body limits and secret comparison.
export function ownerHttpTools() {
  return Object.freeze({ html, json, errorResponse, response, pageShell, readBoundedJson, sameSecret, exactToken, escapeHtml,
    cookieHeader, requestCookie, token, staticResponse, ownerCsp: OWNER_CSP });
}

const COOKIE_NAME = 'owner_alpha_session';
export const MAX_OWNER_SESSIONS = 64;
const MAX_REVIEW_DECISION_BODY_BYTES = OWNER_DECISION_REASON_MAX_BYTES + 16 * 1024;
const MAX_STATIC_BYTES = 64 * 1024 * 1024;
const PUBLIC_ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const OWNER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
].join('; ');

// Review pages embed exactly one thing: the owner-only, sandboxed page frame.
const REVIEW_SHELL_CSP = OWNER_CSP.replace("default-src 'none'", "default-src 'none'; frame-src 'self'");

const READER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
].join('; ');

// The reader site may post suggestions only to the intake the owner app runs
// beside it, and only when the owner turned the form on.
function readerCsp(config) {
  const formOrigin = suggestionFormOrigin(config);
  const reader = READER_CSP.replace("form-action 'none'", `form-action http://${config.listen.host}:${config.listen.port}`);
  if (formOrigin === null) return reader;
  const csp = reader.replace("connect-src 'self'", `connect-src 'self' ${formOrigin}`);
  const challengeOrigin = suggestionChallengeOrigin(config);
  if (challengeOrigin === null) return csp;
  return `${csp.replace("script-src 'self'", `script-src 'self' ${challengeOrigin}`)}; frame-src ${challengeOrigin}`;
}

const CONTENT_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
});

function token() {
  return randomBytes(32).toString('base64url');
}

function exactToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function sameSecret(left, right) {
  if (!exactToken(left) || !exactToken(right)) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function securityHeaders({ owner = false, cache = 'no-store', csp = OWNER_CSP } = {}) {
  const headers = new Headers({
    'Cache-Control': cache,
    'Content-Security-Policy': csp,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  if (owner) headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return headers;
}

function response(body, status, headers = {}) {
  const secured = securityHeaders({ owner: true });
  for (const [name, value] of Object.entries(headers)) secured.set(name, value);
  return new Response(body, { status, headers: secured });
}

function html(body, status = 200, headers = {}) {
  return response(body, status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
}

function json(value, status = 200, headers = {}) {
  return response(`${JSON.stringify(value)}\n`, status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function errorResponse(status, code) {
  return json({ error: { code } }, status);
}

export const RECOVERY_IN_PROGRESS_MESSAGE = 'Finishing an earlier publish. Try again in a moment.';
export const RECOVERY_FAILED_MESSAGE = 'An earlier publish could not be finished. Restart Cyberbaser to try again.';

/**
 * Startup recovery state for the runtime: recovering() is false once recovery
 * settled cleanly, else 'running' or 'failed'. wrapAsync / wrapSync refuse an
 * owner-act entry point until then; wrapSync keeps a synchronous return value
 * (publication's startEdit hands back its durable acceptance at once).
 */
export function createRecoveryGate() {
  let state = 'running';
  const refuse = () => {
    if (state === 'running') fail('recovery-in-progress', RECOVERY_IN_PROGRESS_MESSAGE);
    if (state === 'failed') fail('recovery-failed', RECOVERY_FAILED_MESSAGE);
  };
  return Object.freeze({
    recovering: () => (state === 'settled' ? false : state),
    settle(ok) { state = ok ? 'settled' : 'failed'; },
    wrapAsync: (action) => (typeof action !== 'function' ? action : async (...args) => { refuse(); return action(...args); }),
    wrapSync: (action) => (...args) => { refuse(); return action(...args); },
  });
}

function recoveryRefusal(state) {
  return state === 'failed'
    ? json({ error: { code: 'recovery-failed', message: RECOVERY_FAILED_MESSAGE } }, 503)
    : json({ error: { code: 'recovery-in-progress', message: RECOVERY_IN_PROGRESS_MESSAGE } }, 409, { 'Retry-After': '30' });
}

function cookieHeader(processSession) {
  return `${COOKIE_NAME}=${processSession}; Path=/; HttpOnly; SameSite=Strict`;
}

function requestCookie(request) {
  const raw = request.headers.get('cookie');
  if (raw === null || raw.length > 4096) return null;
  const matches = [];
  for (const field of raw.split(';')) {
    const part = field.trim();
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator) === COOKIE_NAME) matches.push(part.slice(separator + 1));
  }
  return matches.length === 1 ? matches[0] : null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function textareaText(value) {
  const escaped = String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return value.startsWith('\n') ? `\n${escaped}` : escaped;
}

function pageShell({ title, body, script = null, bodyClass = null, stylesheet = '/owner/assets/owner.css' }) {
  const scriptTag = [script].flat().filter(Boolean).map((source) => `<script src="${source}" defer></script>`).join('\n');
  const bodyAttribute = bodyClass === null ? '' : ` class="${escapeHtml(bodyClass)}"`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${stylesheet}">
${scriptTag}
</head>
<body${bodyAttribute}>
${body}
</body>
</html>
`;
}

function signInPage() {
  return pageShell({
    title: 'Sign in',
    script: '/owner/assets/bootstrap.js',
    body: `<main class="owner-shell">
<header class="owner-header"><h1 id="owner-bootstrap-heading">Sign in</h1></header>
<label for="owner-bootstrap-token">One-time sign-in code</label>
<input id="owner-bootstrap-token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="43">
<div class="actions"><button id="owner-bootstrap-submit" type="button">Sign in</button></div>
<p id="owner-bootstrap-status" class="status" role="status" aria-live="polite"></p>
<noscript><p>Signing in needs scripting enabled in this browser.</p></noscript>
</main>`,
  });
}

function editPage({ editSessionId, csrfToken, session, reviewEnabled, publicationEnabled }) {
  return pageShell({
    title: 'Owner edit',
    script: '/owner/assets/editor.js',
    body: `<main class="owner-shell" id="owner-editor" data-source-digest="${escapeHtml(session.source.digest)}" data-edit-session-id="${escapeHtml(editSessionId)}" data-csrf="${escapeHtml(csrfToken)}">
<header class="owner-header review-detail-header">
<div><p class="eyebrow">Owner alpha</p>
<h1>Edit Markdown</h1>
<a href="/owner/in-place?relativePath=${encodeURIComponent(session.relativePath)}&amp;slug=${encodeURIComponent(session.slug)}">Back to page editor</a></div>
${reviewEnabled ? '<a href="/owner/review">Review proposals</a>' : ''}
${publicationEnabled ? '<a href="/owner/publication">Publish workspace page</a>' : ''}
</header>
<form id="edit-form">
<label for="edited-text">Markdown</label>
<textarea id="edited-text" name="editedText" spellcheck="false" autocomplete="off">${textareaText(session.source.text)}</textarea>
<div class="actions owner-finish"><button type="button" id="cancel-edit" aria-label="Cancel editing">Cancel</button><button type="submit" id="save-button">Save</button></div>
<p id="form-status" class="status" role="status" aria-live="polite"></p>
</form>
</main>`,
  });
}

const NO_VISIBLE_CHANGE_COPY = 'Published, nothing visible changed';

function publicJob(job) {
  const result = {
    jobId: job.jobId,
    state: job.state,
    revision: job.revision,
  };
  if (job.liveKind === 'no-visible-change') result.liveCopy = NO_VISIBLE_CHANGE_COPY;
  if (typeof job.createdAt === 'string') result.createdAt = job.createdAt;
  if (typeof job.updatedAt === 'string') result.updatedAt = job.updatedAt;
  if (job.recovery && typeof job.recovery === 'object') {
    result.recovery = {
      classification: job.recovery.classification,
      automatic: job.recovery.automatic,
      instruction: job.recovery.instruction,
    };
  }
  if (job.failure && typeof job.failure === 'object') {
    result.failure = {
      code: job.failure.code,
      retryable: job.failure.retryable,
    };
  } else {
    result.failure = null;
  }
  if (job.origin && typeof job.origin === 'object' && typeof job.origin.type === 'string') {
    result.origin = { type: job.origin.type };
    if (typeof job.origin.relativePath === 'string') result.origin.relativePath = job.origin.relativePath;
    if (job.origin.type === 'approved-proposal' && typeof job.origin.queueId === 'string') {
      result.origin.queueId = job.origin.queueId;
    }
  }
  return result;
}

// The job in the owner's words: five things that happen to a change on its way
// to the page, which one is happening now, and what stopped if something did.
// Raw pipeline states stay available under the plain-words stage.
const JOB_STEPS = Object.freeze([
  { key: 'check', label: 'Checking the page', states: ['accepted', 'preflighting', 'checking', 'rendering', 'ready-to-apply'] },
  { key: 'change', label: 'Changing the page and saving the commit', states: ['applying', 'source-applied', 'committing', 'committed'] },
  { key: 'push', label: 'Pushing to your repository', states: ['pushing', 'pushed'] },
  { key: 'build', label: 'Waiting for the site to build', states: ['discovering-run', 'run-bound', 'monitoring-deployment', 'deployment-succeeded'] },
  { key: 'live', label: 'Checking the live page', states: ['verifying-live', 'live-verification-failed'] },
  { key: 'refresh', label: 'Refreshing your local copy', states: ['live-confirmed', 'rebuilding-local'] },
]);
const JOB_STOPS = Object.freeze({
  completed: { step: 6, copy: 'Live on the page.' },
  'blocked-pre-apply': { step: 0, copy: 'Stopped before changing the page. Nothing changed.' },
  'deployment-failed': { step: 3, copy: 'The page changed and was pushed, but the site build failed.' },
  'live-verification-failed': { step: 4, copy: 'Published, but the live page has not shown the change yet. Checking again.' },
  'manual-intervention': { step: 1, copy: 'Stopped partway and needs your attention.' },
  failed: { step: 0, copy: 'Stopped.' },
  cancelled: { step: 0, copy: 'Cancelled.' },
});

function jobStepIndex(state) {
  const index = JOB_STEPS.findIndex((step) => step.states.includes(state));
  if (index !== -1) return index;
  return JOB_STOPS[state]?.step ?? 0;
}

function jobStageCopy(state) {
  if (state === null || state === undefined) return 'Never started';
  if (JOB_STOPS[state]) return JOB_STOPS[state].copy;
  const step = JOB_STEPS.find((item) => item.states.includes(state));
  return step ? step.label : state;
}

// Display groups only. The underlying job state machine and recovery are unchanged.
const SAVE_STEPS = Object.freeze([
  { key: 'check', label: 'Checking', states: JOB_STEPS[0].states },
  { key: 'save', label: 'Saving', states: [...JOB_STEPS[1].states, ...JOB_STEPS[2].states] },
  { key: 'site', label: 'Updating the site', states: JOB_STEPS.slice(3).flatMap(step => step.states) },
  { key: 'done', label: 'Done', states: ['completed'] },
]);
const SAVE_STOPS = Object.freeze(Object.fromEntries(Object.entries(JOB_STOPS).map(([state, value]) => [state, {
  step: state === 'completed' ? 3 : value.step === 0 ? 0 : value.step < 3 ? 1 : 2,
  copy: state === 'completed' ? 'Saved' : state === 'live-verification-failed' ? 'Updating the site' : 'The save did not finish. Open Details for what happened.',
}])));
function jobPage(job, readerOrigin, appearance = null) {
  const safe = publicJob(job);
  if (safe.origin?.type === 'owner-publication') return publicationJobPage(safe);
  const done = safe.state === 'completed';
  const stopped = Object.hasOwn(SAVE_STOPS, safe.state) && !done && safe.state !== 'live-verification-failed';
  const current = SAVE_STEPS.findIndex(step => step.states.includes(safe.state));
  const active = current === -1 ? SAVE_STOPS[safe.state]?.step ?? 0 : current;
  const copy = safe.liveCopy ?? SAVE_STOPS[safe.state]?.copy ?? SAVE_STEPS[active].label;
  const title = job.page?.title || safe.origin?.relativePath?.split('/').at(-1)?.replace(/\.md$/u, '') || 'Your page';
  const slug = job.page?.slug ?? safe.origin?.relativePath?.replace(/\.md$/u, '');
  const view = slug ? liveUrlForSlug(`${readerOrigin}/cyberbase/`, slug) : `${readerOrigin}/cyberbase/`;
  const edit = safe.origin?.relativePath && slug ? `/owner/in-place?relativePath=${encodeURIComponent(safe.origin.relativePath)}&slug=${encodeURIComponent(slug)}` : `${readerOrigin}/cyberbase/`;
  const steps = SAVE_STEPS.map((step, index) => {
    const status = done || index < active ? 'done' : index === active ? (stopped ? 'stopped' : 'current') : 'pending';
    return `<li class="job-step job-step-${status}" data-step="${step.key}" data-status="${status}">${step.label}</li>`;
  }).join('');
  const stages = escapeHtml(JSON.stringify({ steps: SAVE_STEPS, stops: SAVE_STOPS, technical: { steps: JOB_STEPS, stops: JOB_STOPS } }));
  // Edit again reopens the owner's own edit. A proposal someone else sent is not
  // the owner's draft, so it gets no such link.
  const ownEdit = safe.origin?.type !== 'approved-proposal';
  return pageShell({
    title, script: '/owner/assets/job.js',
    // The same colour scheme as the owner's site, as on the review page.
    bodyClass: `save-page owner-scheme-${appearance?.colorScheme ?? 'system'}`,
    body: `<main class="owner-shell save-progress" id="owner-job" data-job-id="${escapeHtml(safe.jobId)}" data-stages="${stages}">
<header class="owner-header"><h1 id="save-heading">${escapeHtml(title)}</h1></header>
<section class="job-card" aria-live="polite"><p class="job-stage"><strong id="job-stage">${escapeHtml(copy)}</strong></p>
<ol class="job-steps" id="job-steps"${done || stopped ? ' hidden' : ''}>${steps}</ol>
<div class="save-result-links" id="save-result-links"${done ? '' : ' hidden'}><a class="save-view-page" href="${escapeHtml(view)}">View page</a>${ownEdit ? `<a href="${escapeHtml(edit)}">Edit again</a>` : ''}</div>
</section>
<details class="job-details" id="job-details"><summary>Details</summary><div id="job-rehearsal-details"></div>
<p id="job-technical-stage">${escapeHtml(jobStageCopy(safe.state))}</p><p id="job-recovery" class="status">${escapeHtml(safe.recovery?.instruction ?? '')}</p>
<p id="job-error" class="error">${safe.failure ? `Stopped (${escapeHtml(safe.failure.code)}).` : ''}</p>
<p class="job-technical">Job <span id="job-id">${escapeHtml(safe.jobId)}</span> · state <span id="job-state">${escapeHtml(safe.state)}</span> · updated <span id="job-updated">${escapeHtml(safe.updatedAt ?? '')}</span></p></details>
<p class="job-links">${safe.origin?.type === 'approved-proposal' ? `<a href="/owner/decisions/${encodeURIComponent(safe.origin.queueId)}">Back to the suggestion</a> · ` : ''}<a href="${escapeHtml(readerOrigin)}/cyberbase/">Return to Cyberbase</a></p></main>`,
  });
}

function proposalText(bytesBase64) {
  return Buffer.from(bytesBase64, 'base64').toString('utf8');
}

function compactReviewText(value, maximum = 160) {
  const text = String(value).replace(/\s+/gu, ' ').trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

// Owners think in days, not minutes: show the date and keep the exact instant
// on the element for anyone who needs it.
function reviewTime(value, { relative = false } = {}) {
  const instant = new Date(value);
  const visible = Number.isNaN(instant.getTime()) ? value
    : relative && instant.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? 'today'
      : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(instant);
  return `<time datetime="${escapeHtml(value)}" title="${escapeHtml(value)}">${escapeHtml(visible)}</time>`;
}

function proposalView(entry) {
  const proposal = entry.evidence.proposal;
  const binding = reviewProposalBinding(proposal);
  const operations = entry.changes?.operations ?? binding.operations;
  const first = operations[0];
  const legacy = proposal.schemaVersion === 1 ? proposal.operation : null;
  return Object.freeze({
    version: proposal.schemaVersion, path: binding.source.path, operations,
    operation: legacy ?? { ...first, type: 'offset' },
    oldText: first.expected, replacementText: first.replacement,
    prefix: first.context?.before ?? legacy?.selector?.prefix ?? '',
    suffix: first.context?.after ?? legacy?.selector?.suffix ?? '',
    hasContext: first.context !== undefined || legacy?.selector != null,
  });
}

function changeInspection(entry, { hiddenOperations = new Set(), hasHidden = false } = {}) {
  const view = proposalView(entry);
  return `<section class="change-inspection" aria-label="Each exact change"><h2>Exact changes</h2>${view.operations.map((op, index) => {
    const position = op.startPosition ? `Line ${op.startPosition.line}, column ${op.startPosition.column}` : `Bytes ${op.start}–${op.end}`;
    const context = (value) => hasHidden || hasHiddenProposalSource(value ?? '') ? '' : `<p class="context-note">${escapeHtml(value ?? '')}</p>`;
    const hidden = hiddenOperations.has(index + 1) || hasHiddenProposalSource(op.expected + op.replacement);
    const exact = hidden ? '<p>Hidden content · source not shown</p>'
      : `${context(op.context?.before ?? (index === 0 ? view.prefix : ''))}<div class="exact-change-grid"><div><h4>Before</h4><pre>${escapeHtml(op.expected)}</pre></div><div><h4>After</h4><pre>${escapeHtml(op.replacement)}</pre></div></div>${context(op.context?.after ?? (index === 0 ? view.suffix : ''))}`;
    return `<article class="inspected-change"><h3>Change ${index + 1} · ${escapeHtml(position)}</h3>${exact}</article>`;
  }).join('')}</section>`;
}

function changeName(view) {
  if (view.version === 2) return `${view.path} — ${view.operations.length} ${view.operations.length === 1 ? 'change' : 'changes'}`;
  const oldText = compactReviewText(view.oldText, 64);
  const replacementText = compactReviewText(view.replacementText, 64);
  if (oldText.length === 0) return `Add “${replacementText}”`;
  if (replacementText.length === 0) return `Remove “${oldText}”`;
  return `“${oldText}” to “${replacementText}”`;
}

function changedText(value) {
  return value.length === 0
    ? '<span class="empty-change">nothing</span>'
    : escapeHtml(value);
}

function compactContext(value, maximum, { fromEnd = false } = {}) {
  const text = String(value).replace(/\s+/gu, ' ');
  if (text.length <= maximum) return text;
  return fromEnd
    ? `…${text.slice(-(maximum - 1))}`
    : `${text.slice(0, maximum - 1)}…`;
}

function proposalContext(view, mode, { compact = false } = {}) {
  const prefix = compact ? compactContext(view.prefix, 72, { fromEnd: true }) : view.prefix;
  const suffix = compact ? compactContext(view.suffix, 72) : view.suffix;
  const selected = mode === 'current' ? view.oldText : view.replacementText;
  const bounded = compact ? compactReviewText(selected, 96) : selected;
  const context = view.hasContext
    ? `${escapeHtml(prefix)}<mark class="changed-word changed-${mode}">${changedText(bounded)}</mark>${escapeHtml(suffix)}`
    : `<mark class="changed-word changed-${mode}">${changedText(bounded)}</mark>`;
  return `<span class="proposal-prose">${context}</span>`;
}

function changeSummaryHtml(view, { compact = false } = {}) {
  if (view.version === 2) return `<span class="proposal-prose">${escapeHtml(changeName(view))}</span>`;
  const prefix = compact ? compactContext(view.prefix, 60, { fromEnd: true }) : view.prefix;
  const suffix = compact ? compactContext(view.suffix, 60) : view.suffix;
  const oldText = compact ? compactReviewText(view.oldText, 80) : view.oldText;
  const newText = compact ? compactReviewText(view.replacementText, 80) : view.replacementText;
  const removed = view.oldText.length === 0 ? '' : `<del class="changed-word changed-current">${escapeHtml(oldText)}</del>`;
  const added = view.replacementText.length === 0 ? '' : `<ins class="changed-word changed-proposed">${escapeHtml(newText)}</ins>`;
  const marks = `${removed}${removed !== '' && added !== '' ? ' ' : ''}${added}`;
  return view.hasContext
    ? `<span class="proposal-prose">${escapeHtml(prefix)}${marks}${escapeHtml(suffix)}</span>`
    : `<span class="proposal-prose">${marks}</span>`;
}

function decisionEntry(decision, summary) {
  return Object.freeze({
    summary: {
      schemaVersion: 1,
      artifactType: 'cyberbaser-proposal-review-summary',
      queueId: summary.queueId,
      proposalId: summary.proposalId,
      proposalDigest: summary.proposalDigest,
      candidateDigest: summary.candidateDigest,
      reviewEvidenceDigest: summary.reviewEvidenceDigest,
      source: summary.source,
      receivedAt: summary.receivedAt,
      expiresAt: summary.expiresAt,
      state: decision.reviewEvidence.state.state,
      lane: summary.lane,
      tier: summary.tier,
      route: summary.route,
    },
    evidence: decision.reviewEvidence,
    sourceVerification: null,
  });
}

// A suggestion that arrived as a pull request on the owner's forge says so:
// which request, where, and which forge account opened it. The link is built
// from the repository the proposal is bound to, never from contributor text.
function forgeOrigin(entry) {
  const carrier = entry.evidence?.carrier;
  if (carrier?.lane !== 'lane-a' || !carrier.metadata) return null;
  const repository = String(entry.summary.source.repository);
  let base;
  try {
    const url = new URL(repository);
    if (url.protocol !== 'https:') return null;
    base = url.toString().replace(/\.git$/u, '');
  } catch {
    return null;
  }
  const number = carrier.metadata.pullRequestNumber;
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const subject = entry.evidence.classification?.verifiedSubject?.author;
  const account = typeof subject === 'string' ? (/#user=(\d{1,20})$/u.exec(subject)?.[1] ?? null) : null;
  return Object.freeze({
    number,
    url: `${base}/pulls/${number}`,
    account,
    headSha: carrier.metadata.headSha,
    key: `${carrier.metadata.repositoryId}:${number}`,
  });
}

function forgeOriginHtml(origin, { compact = false } = {}) {
  if (origin === null) return '';
  const account = origin.account === null ? '' : ` by forge account #${escapeHtml(origin.account)}`;
  return `<span class="forge-origin">From <a href="${escapeHtml(origin.url)}" rel="noopener noreferrer">pull request #${origin.number}</a> on your forge${compact ? '' : account}</span>`;
}

function signedSubmitterHtml(entry) {
  const carrier = entry.evidence?.carrier;
  if (carrier?.lane !== 'lane-signed') return '';
  const submitter = carrier.metadata.submitter;
  const kind = submitter.kind === 'agent' ? 'Agent' : 'Owner device';
  const key = submitter.keyId.length > 12 ? `${submitter.keyId.slice(0, 12)}…` : submitter.keyId;
  return `<span class="proposal-submitter" title="Submitter ID: ${escapeHtml(submitter.id)}">Submitted by ${escapeHtml(kind)}: ${escapeHtml(submitter.label)} (key ${escapeHtml(key)})</span>`;
}

// Several heads of one request are one suggestion in the owner's eyes: the
// newest is the row, earlier heads fold beneath it.
function groupActionable(entries) {
  const groups = new Map();
  const order = [];
  for (const entry of entries) {
    const origin = forgeOrigin(entry);
    const key = origin === null ? `queue:${entry.summary.queueId}` : `forge:${origin.key}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(entry);
  }
  return order.map((key) => {
    const members = [...groups.get(key)].sort((left, right) => right.summary.receivedAt.localeCompare(left.summary.receivedAt));
    return { entry: members[0], earlier: members.slice(1) };
  });
}

// Decided rows say how far a suggestion got: Rejected, Approved (not yet on
// the page), Applied (on its way), or Live (confirmed on the page).
function decisionLabel(decision, application) {
  if (decision.action !== 'approve') return { key: 'reject', text: 'Rejected', at: decision.decidedAt };
  if (application?.state === 'live') return { key: 'live', text: 'Live', at: application.appliedAt };
  if (application?.state === 'applied') return { key: 'applied', text: 'Applied', at: application.appliedAt };
  return { key: 'approve', text: 'Approved', at: decision.decidedAt };
}

function reviewSummaryCard(entry, href, decision = null, application = null, earlier = []) {
  const count = proposalView(entry).operations.length;
  const label = decision === null ? null : decisionLabel(decision, application);
  const title = escapeHtml(proposalTitle(entry));
  const meta = `${proposalSender(entry, { link: false })} \u00b7 ${reviewTime(entry.summary.receivedAt, { relative: true })}`;
  const folded = earlier.length === 0
    ? ''
    : `<p class="earlier-versions">Earlier ${earlier.length === 1 ? 'version' : 'versions'} of this request: ${earlier.map((item) => `<a href="/owner/review/${encodeURIComponent(item.summary.queueId)}">received ${reviewTime(item.summary.receivedAt)}</a>`).join(', ')}</p>`;
  return `<article class="proposal-row">
<a class="proposal-row-link" href="${escapeHtml(href)}">
<span class="proposal-row-text"><strong class="proposal-row-title" title="${title}">${title}</strong><small>${meta}</small></span>
<span class="proposal-row-count">${label === null ? `${count} ${count === 1 ? 'change' : 'changes'}` : `<span class="decision-label decision-${label.key}">${label.text}</span>`}</span>
</a>
${folded}</article>`;
}

// One quiet line where publishing depends on GitHub; nothing when it is reachable.
export function upstreamNotice(upstream) {
  const state = typeof upstream?.current === 'function' ? upstream.current() : null;
  if (state?.state !== 'unreachable') return '';
  return '<p class="rv-note rv-upstream" role="status">Can\'t reach GitHub. You can still review; publishing waits until it is back.</p>';
}

function reviewListPage({ overlay, nextCursor, upstream = null }) {
  const actionable = overlay.actionable.length === 0
    ? '<p class="empty-state">Nothing is waiting for you.</p>'
    : groupActionable(overlay.actionable).map(({ entry, earlier }) => reviewSummaryCard(
        entry,
        `/owner/review/${encodeURIComponent(entry.summary.queueId)}`,
        null,
        null,
        earlier,
      )).join('\n');
  const history = overlay.history.length === 0
    ? '<p class="empty-state">No decisions yet.</p>'
    : overlay.history.map(({ decision, summary, application = null }) => reviewSummaryCard(
        decisionEntry(decision, summary),
        `/owner/decisions/${encodeURIComponent(summary.queueId)}`,
        decision,
        application,
      )).join('\n');
  const next = nextCursor === null
    ? ''
    : `<p class="pagination"><a href="/owner/review?cursor=${encodeURIComponent(nextCursor)}">More proposals</a></p>`;
  const waitingCount = groupActionable(overlay.actionable).length;
  const waiting = waitingCount === 1 ? '1 waiting' : `${waitingCount} waiting`;
  const decided = overlay.history.length === 0 ? '' : `<span class="section-count">${overlay.history.length} shown</span>`;
  return pageShell({
    title: 'Proposals',
    script: '/owner/assets/review.js',
    stylesheet: '/owner/assets/review.css',
    bodyClass: 'rv-doc rv-inbox',
    body: `<header class="rv-topbar"><b>Cyberbaser</b><span class="rv-priv">private to you</span></header>
<main class="rv-inbox-main" id="owner-review-list">
<h1>Proposals</h1>
${upstreamNotice(upstream)}
<section class="review-section" id="needs-review" aria-labelledby="actionable-heading">
<div class="section-heading"><h2 id="actionable-heading">Needs review</h2><span class="section-count">${waiting}</span></div>
<div class="proposal-list">${actionable}</div>
${next}
</section>
<section class="review-section decided-section" id="decided" aria-labelledby="history-heading">
<div class="section-heading"><h2 id="history-heading">Decided</h2>${decided}</div>
<div class="proposal-list">${history}</div>
${overlay.historyTruncated ? '<p class="rv-note">Only the newest decisions are shown here.</p>' : ''}
</section>
<p class="review-return"><a href="/">Return to your site</a></p>
</main>`,
  });
}

const REVIEW_MODES = Object.freeze([
  { key: 'changes', label: 'Changes', view: 'unified', hint: 'Removals and additions marked in place' },
  { key: 'proposed', label: 'Proposed', view: 'proposed', hint: 'The page as it would read if applied' },
  { key: 'current', label: 'Current', view: 'current', hint: 'The page as it reads today' },
  { key: 'compare', label: 'Compare', view: null, hint: 'Both sides at once' },
]);
const REVIEW_MODE_KEYS = Object.freeze(REVIEW_MODES.map((mode) => mode.key));

function reviewProjection(entry) {
  const document = entry.document ?? null;
  // A stated reason (for example the reading bound) means there is no text to
  // project; passing nulls on would misreport the page as absent from the base.
  if (document === null || document.reason !== null) return null;
  const operations = proposalView(entry).operations;
  const path = entry.summary.source.path;
  return documentProjection({
    files: [{
      path,
      exists: document.baseText !== null,
      baseText: document.baseText,
      candidateText: document.candidateText,
    }],
    operations: operations.map((operation) => ({ path, start: operation.start, end: operation.end, oldText: operation.expected, replacementText: operation.replacement })),
  });
}

function segmentsHtml(segments) {
  return segments.map((item) => {
    if (item.kind === 'context') return escapeHtml(item.text);
    if (item.kind === 'removed') return `<del class="doc-removed">${escapeHtml(item.text)}</del>`;
    if (item.kind === 'added') return `<ins class="doc-added">${escapeHtml(item.text)}</ins>`;
    const label = item.kind === 'insertion-point' ? 'insertion point' : 'removed here';
    return `<span class="doc-point">\u27e8${escapeHtml(label)}\u27e9</span>`;
  }).join('');
}

function tokenHtml(token) {
  if (token.type === 'code') return `<code class="md-code">${escapeHtml(token.text)}</code>`;
  if (token.type === 'strong') return `<strong>${escapeHtml(token.text)}</strong>`;
  if (token.type === 'emphasis') return `<em>${escapeHtml(token.text)}</em>`;
  if (token.type === 'link' || token.type === 'wikilink') {
    return `<span class="md-link md-${token.type}" title="${escapeHtml(token.target)} \u00b7 not resolved in review">${escapeHtml(token.text)}</span>`;
  }
  return escapeHtml(token.text);
}

function blockHtml(block) {
  const tokens = (block.tokens ?? []).map(tokenHtml).join('');
  if (block.kind === 'heading') return `<p class="md-heading md-h${block.level}">${tokens}</p>`;
  if (block.kind === 'paragraph') return `<p class="md-paragraph">${tokens}</p>`;
  if (block.kind === 'quote') return `<blockquote class="md-quote">${tokens}</blockquote>`;
  if (block.kind === 'code') return `<pre class="md-codeblock"><code>${escapeHtml(block.text)}</code></pre>`;
  if (block.kind === 'rule') return '<hr class="md-rule">';
  if (block.kind === 'list' || block.kind === 'ordered-list') {
    const items = block.items.map((item) => `<li${item.depth > 0 ? ' class="md-nested"' : ''}>${item.tokens.map(tokenHtml).join('')}</li>`).join('');
    return `<${block.kind === 'list' ? 'ul' : 'ol'} class="md-list">${items}</${block.kind === 'list' ? 'ul' : 'ol'}>`;
  }
  if (block.kind === 'frontmatter') {
    const rows = block.entries.map((entry) => `<div><dt>${escapeHtml(entry.name)}</dt><dd>${escapeHtml(entry.value)}</dd></div>`).join('');
    return `<div class="md-frontmatter"><p class="section-kicker">Page metadata</p><dl>${rows}</dl></div>`;
  }
  return '';
}

function documentEnd(source) {
  return source.blocks.at(-1)?.end ?? 0;
}

function segmentsInBlock(segments, block, end) {
  return segmentsWithinSpan(segments, block, end);
}

function blockSegments(segments, span, end) {
  const scoped = [];
  for (const item of segmentsInBlock(segments, span, end)) {
    if (item.kind !== 'context' || item.text.length !== item.end - item.start) {
      scoped.push(item);
      continue;
    }
    const start = Math.max(item.start, span.start);
    const end = Math.min(item.end, span.end);
    const sliced = item.text.slice(start - item.start, end - item.start);
    if (sliced.length > 0) scoped.push({ ...item, text: sliced });
  }
  return scoped;
}

// Blocks are keyed by the operation numbers they touch, so the removed and
// added halves of one operation always land in the same region even when the
// addition anchors at the start of the following block.
function changedOperations(source, block, end) {
  return new Set(segmentsInBlock(source.segments, block, end)
    .filter((item) => item.kind !== 'context')
    .map((item) => item.operation ?? source.segments.indexOf(item)));
}

function readingRegions(source) {
  const end = documentEnd(source);
  const regions = [];
  let index = 0;
  while (index < source.blocks.length) {
    const changed = changedOperations(source, source.blocks[index], end);
    if (changed.size === 0) {
      regions.push({ changed: false, blocks: [source.blocks[index]] });
      index += 1;
      continue;
    }
    const blocks = [source.blocks[index]];
    let cursor = index + 1;
    while (cursor < source.blocks.length) {
      const next = changedOperations(source, source.blocks[cursor], end);
      if (next.size === 0 || [...next].every((id) => !changed.has(id))) break;
      for (const id of next) changed.add(id);
      blocks.push(source.blocks[cursor]);
      cursor += 1;
    }
    regions.push({ changed: true, blocks });
    index = cursor;
  }
  return regions;
}

function sourceRegionHtml(source, span, label, extraClass = '') {
  return `<div class="md-source-wrap${extraClass}"><p class="md-source-label">${escapeHtml(label)}</p><div class="md-source">${segmentsHtml(blockSegments(source.segments, span, documentEnd(source)))}</div></div>`;
}

function readingHtml(source, className) {
  const parts = [];
  if (source.blocks.length === 0) {
    // An empty pinned page has no blocks; the declared change is still shown.
    parts.push(sourceRegionHtml(source, { start: 0, end: 0 }, 'Exact source \u00b7 changed passage'));
  }
  for (const region of readingRegions(source)) {
    const span = { start: region.blocks[0].start, end: region.blocks.at(-1).end };
    if (region.changed) {
      parts.push(sourceRegionHtml(source, span, 'Exact source \u00b7 changed passage'));
      continue;
    }
    const [block] = region.blocks;
    if (block.uninterpreted.length > 0) {
      parts.push(sourceRegionHtml(source, span, `Exact source \u00b7 not interpreted here: ${block.uninterpreted.join(', ')}`, ' md-source-uninterpreted'));
      continue;
    }
    parts.push(blockHtml(block));
  }
  return `<div class="reading-body ${className}">${parts.join('')}</div>`;
}

function operationNote(view) {
  const type = `${view.operation.type[0].toUpperCase()}${view.operation.type.slice(1)}`;
  return `${type} operation at bytes ${view.operation.start}\u2013${view.operation.end}.`;
}

function unavailableModeHtml(reason, entry) {
  if (entry.evidence.proposal.schemaVersion === 2) return `<p class="mode-unavailable">${escapeHtml(reason)}</p>${changeInspection(entry)}`;
  const view = proposalView(entry);
  return `<div class="mode-unavailable">
<p class="section-kicker">This view cannot be shown</p>
<p>${escapeHtml(reason)}</p>
<p class="context-note">The page is never invented from partial evidence. Here is the exact change instead.</p>
<div class="exact-change-grid">
<div><h3>Current bytes</h3><pre><code>${escapeHtml(view.oldText)}</code></pre></div>
<div><h3>Replacement bytes</h3><pre><code>${escapeHtml(view.replacementText)}</code></pre></div>
</div>
<p class="context-note">${escapeHtml(operationNote(view))}</p>
</div>`;
}

function comparePanelHtml(projection, entry) {
  const [file] = projection?.files ?? [];
  if (file && projection.modes.current.available && projection.modes.proposed.available) {
    const view = proposalView(entry);
    const currentNote = view.oldText.length === 0 ? 'No current text' : 'Removed';
    const proposedNote = view.replacementText.length === 0 ? 'Absent in the proposed result' : 'Added \u00b7 not yet approved';
    return `<div class="proof-grid">
<section class="proof proof-current" aria-label="Current source"><div class="proof-heading"><p class="proof-label">Current source</p><span class="semantic-label">${escapeHtml(currentNote)}</span></div>${readingHtml(file.current, 'compare-body')}</section>
<section class="proof proof-proposed" aria-label="Proposed change"><div class="proof-heading"><p class="proof-label">Proposed change</p><span class="semantic-label">${escapeHtml(proposedNote)}</span></div>${readingHtml(file.proposed, 'compare-body')}</section>
</div>`;
  }
  const view = proposalView(entry);
  const contextNote = view.hasContext
    ? 'The surrounding words come from the proposal\u2019s exact quote selector.'
    : 'This offset-bound proposal does not include surrounding quote context.';
  return `<div class="proof-grid">
<section class="proof proof-current" aria-label="Current source"><div class="proof-heading"><p class="proof-label">Current source</p></div><p class="context-copy">${proposalContext(view, 'current')}</p><p class="context-note">${escapeHtml(contextNote)}</p></section>
<section class="proof proof-proposed" aria-label="Proposed change"><div class="proof-heading"><p class="proof-label">Proposed change</p></div><p class="context-copy">${proposalContext(view, 'proposed')}</p><p class="context-note">${escapeHtml(contextNote)}</p></section>
</div>
<p class="context-note">${escapeHtml(operationNote(view))}</p>`;
}

function reviewModeNav(queueId, activeMode, projection) {
  const links = REVIEW_MODES.map((mode) => {
    const active = mode.key === activeMode;
    const state = mode.view === null ? null : projection?.modes[mode.key] ?? null;
    const hint = state !== null && state.available === false ? 'Not derivable' : mode.hint;
    return `<a class="mode-tab${active ? ' active' : ''}" href="/owner/review/${encodeURIComponent(queueId)}?mode=${mode.key}"${active ? ' aria-current="page"' : ''}><strong>${escapeHtml(mode.label)}</strong><small>${escapeHtml(active ? hint : '')}</small></a>`;
  }).join('');
  return `<nav class="review-modes" aria-label="Review mode">${links}</nav>`;
}

function comparisonPanel(entry, activeMode) {
  const projection = reviewProjection(entry);
  const mode = REVIEW_MODES.find((item) => item.key === activeMode) ?? REVIEW_MODES[0];
  const readingNote = 'This is a structural reading, not the published page.';
  let panel;
  if (mode.view === null) {
    panel = comparePanelHtml(projection, entry);
  } else if (projection === null) {
    panel = unavailableModeHtml(entry.document?.reason ?? 'The pinned page text is not available in this review evidence.', entry);
  } else if (!projection.modes[mode.key].available) {
    panel = unavailableModeHtml(projection.modes[mode.key].reason, entry);
  } else {
    panel = readingHtml(projection.files[0][mode.view], `document-${mode.key}`);
  }
  return `<section class="comparison-section" aria-labelledby="comparison-heading">
<h2 id="comparison-heading" class="visually-hidden">Read the change</h2>
${reviewModeNav(entry.summary.queueId, mode.key, projection)}
<p class="reading-note"><span>Removed text is <del>struck through</del>, added text is <ins>underlined</ins>, and everything else is the page's exact source.</span> <span>${escapeHtml(readingNote)}</span></p>
<div class="mode-panel mode-panel-${mode.key}">${panel}</div>
</section>`;
}

// Publication presentation uses only config or evidence already bound by the route.
// These helpers never read the authoring host or broaden the public job projection.
function publicationTitle(relativePath, text = '') {
  return /^#\s+([^\r\n]+)$/mu.exec(text)?.[1]?.replace(/\s+#+\s*$/u, '').trim()
    || (relativePath ? path.posix.basename(relativePath, '.md') : '') || 'Your page';
}

function publicationHeader(back = false) {
  return `<header class="publication-appbar"><a class="publication-brand" href="/owner/publication">Cyberbaser <span>Publication</span></a>${back ? '<a href="/owner/publication">Back to your page</a>' : '<span class="publication-private">Private workspace</span>'}</header>`;
}

const PUBLICATION_STOPS = Object.freeze({
  ...JOB_STOPS,
  completed: { step: 6, copy: 'Published and confirmed.' },
  'live-verification-failed': { step: 4, copy: 'The change was pushed. The live page is not confirmed yet. Checking again.' },
  'manual-intervention': { step: 1, copy: 'Publication stopped. Check the record before taking another action.' },
  failed: { step: 0, copy: 'Publication stopped. Changes may already have been made; check the record.' },
  cancelled: { step: 0, copy: 'Publication cancelled. Check the record before starting another review.' },
});

function publicationJobPage(safe) {
  const title = publicationTitle(safe.origin?.relativePath);
  const current = jobStepIndex(safe.state);
  const done = safe.state === 'completed';
  const stopped = Object.hasOwn(PUBLICATION_STOPS, safe.state) && !done;
  const stages = { steps: JOB_STEPS, stops: PUBLICATION_STOPS, activeCopy: 'Publishing this version' };
  const uncertain = ['failed', 'manual-intervention', 'cancelled'].includes(safe.state);
  const steps = JOB_STEPS.map((step, index) => {
    const status = uncertain ? 'unknown' : done || index < current ? 'done' : index === current ? (stopped ? 'stopped' : 'current') : 'pending';
    const stepCopy = step.key === 'live' && safe.liveCopy ? safe.liveCopy : step.label;
    const label = { done: 'Done', current: 'In progress', stopped: 'Stopped', pending: 'Waiting', unknown: 'See record' }[status];
    return `<li class="job-step job-step-${status}" data-step="${step.key}" data-status="${status}"><span>${escapeHtml(stepCopy)}</span><span class="publication-step-status">${label}</span></li>`;
  }).join('');
  return pageShell({ title: `${title} · Publication`, bodyClass: 'publication-page', script: '/owner/assets/publication.js',
    body: `${publicationHeader(true)}<main class="publication-shell publication-job" id="owner-job" data-job-id="${escapeHtml(safe.jobId)}" data-stages="${escapeHtml(JSON.stringify(stages))}">
<header class="publication-heading"><h1>${escapeHtml(title)}</h1></header>
<section aria-label="Publication progress" aria-live="polite"><h2 id="job-stage">${escapeHtml(safe.liveCopy ?? PUBLICATION_STOPS[safe.state]?.copy ?? stages.activeCopy)}</h2>
<p class="publication-explanation" id="publication-job-note" data-complete-copy="The reviewed version completed its publication checks.">${done ? 'The reviewed version completed its publication checks.' : 'This runs in the background. You can close this page and return to follow its progress.'}</p>
<ol class="job-steps" id="job-steps">${steps}</ol><p id="job-error" class="error" role="alert">${safe.failure ? `Stopped (${escapeHtml(safe.failure.code)}).` : ''}</p></section>
<details class="technical-evidence"><summary>Details for the record</summary><div class="publication-record">
<p>Source page ${escapeHtml(safe.origin?.relativePath ?? '—')}</p><p>Job <span id="job-id">${escapeHtml(safe.jobId)}</span></p><p>State <span id="job-state">${escapeHtml(safe.state)}</span></p><p>Updated <span id="job-updated">${escapeHtml(safe.updatedAt ?? '—')}</span></p>
<p id="job-recovery">${escapeHtml(safe.recovery?.instruction ?? '')}</p></div></details></main>` });
}

function publicationLanding(config, csrfToken, readerOrigin) {
  const mapping = config.ownerPublication.mappings[0];
  const title = publicationTitle(mapping.relativePath);
  const publicUrl = liveUrlForSlug(config.live.baseUrl, mapping.slug);
  return pageShell({ title: `${title} · Publication`, bodyClass: 'publication-page', script: '/owner/assets/publication.js',
    body: `${publicationHeader()}<main class="publication-shell publication-landing"><header class="publication-heading"><h1>${escapeHtml(title)}</h1></header>
<section class="publication-intro"><h2>Review your page before publishing</h2><p>Capture the current authoring version and see exactly what would change. Reviewing does not change or publish the page.</p>
<dl class="publication-destination"><dt>Public address</dt><dd><a href="${escapeHtml(publicUrl)}" rel="noreferrer">${escapeHtml(publicUrl)}</a></dd></dl></section>
<form id="publication-form" data-action="prepare" data-mapping-id="${escapeHtml(mapping.id)}" data-csrf="${escapeHtml(csrfToken)}">
<div class="publication-action"><p>Your next step is a private review.</p><button type="submit">Review changes</button></div><p id="publication-status" class="status" role="status"></p></form>
<p class="publication-local-link"><a href="${escapeHtml(readerOrigin)}/cyberbase/">Browse the local site</a></p></main>` });
}

function publicationBlock(block, text, tracked = null) {
  if (tracked?.kind === 'inline') {
    const groups = tracked.groups.map((group) => group.runs.map((run) => {
      const html = tokenHtml(run.token);
      return run.kind === 'context' ? html : run.kind === 'added'
        ? `<ins class="publication-ins" aria-label="Added">${html}</ins>`
        : `<del class="publication-del" aria-label="Removed">${html}</del>`;
    }).join(''));
    if (block.kind === 'paragraph') return `<p class="md-paragraph">${groups[0]}</p>`;
    if (block.kind === 'heading') return `<p class="md-heading md-h${block.level}">${groups[0]}</p>`;
    if (block.kind === 'quote') return `<blockquote class="md-quote">${groups[0]}</blockquote>`;
    if (block.kind === 'code') return `<pre class="md-codeblock">${groups[0]}</pre>`;
    if (block.items) { const tag = block.kind === 'ordered-list' ? 'ol' : 'ul'; return `<${tag}>${block.items.map((item, index) => `<li${item.depth ? ' class="md-nested"' : ''}>${groups[index]}</li>`).join('')}</${tag}>`; }
  }
  return block.uninterpreted?.length || !blockHtml(block)
    ? `<div class="publication-source-block"><p class="publication-source-label">Exact source · ${escapeHtml(block.uninterpreted?.join(', ') || block.kind)} is not rendered in this structural review</p><pre>${escapeHtml(text.slice(block.start, block.end))}</pre></div>`
    : blockHtml(block);
}

// Publication-only decorative icons. Labels and state belong to their controls.
function publicationIcon(name) {
  const paths = {
    previous: '<path d="m14 6-6 6 6 6"/>',
    next: '<path d="m10 6 6 6-6 6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="publication-eye-slash" d="m3 3 18 18"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    previousSource: '<path d="M9 5H5v4m0-4 5 5m-5 3a7 7 0 1 0 3-6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  return `<svg class="publication-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

function publicationDocument(display, text, { previous = false, proposal = false, repeatedTitle = null } = {}) {
  if (display.exactOnly) return `<div class="publication-exact-document"><p class="publication-source-label">Exact source</p><pre>${escapeHtml(text)}</pre></div>`;
  const rows = previous ? display.file.current.blocks.filter((block) => block.kind !== 'gap').map((block) => ({ block })) : display.tracked.rows;
  return rows.map((row) => {
    if (row === repeatedTitle) return '';
    const kind = row.tracked?.kind;
    const content = row.hidden ? '<p class="publication-source-label">Hidden content · source not shown</p>' : row.block
      ? publicationBlock(row.deleted ? { ...row.block, start: 0, end: row.previous[0].length } : row.block,
        row.deleted ? row.previous[0] : text, row.tracked)
      : `<p class="publication-removal">${row.removed ? 'Text removed at this position.' : 'Whitespace changed at this position.'}</p>`;
    if (proposal) {
      const anchors = (display.anchors.get(row) ?? []).map((number) => `<span class="proposal-change-anchor" data-change="${number}" tabindex="-1" aria-label="Change ${number}"></span>`).join('');
      const mark = (tag, label, html) => `<${tag} class="publication-${tag} proposal-block-mark" aria-label="${label}">${html}</${tag}>`;
      const old = row.baseBlock && ['block', 'exact'].includes(kind) ? row.previous[0] : null;
      const reading = row.hidden ? content : row.deleted ? mark('del', 'Removed block', content) : kind === 'added' || old !== null
        ? `${old === null ? '' : mark('del', 'Removed block', publicationBlock({ ...row.baseBlock, start: 0, end: old.length }, old))}${mark('ins', 'Added block', content)}`
        : content;
      return `<section class="publication-block${row.changed ? ' proposal-changed-block' : ''}">${anchors}${reading}</section>`;
    }
    const label = row.tracked && row.tracked.kind !== 'inline' ? `<p class="publication-change-label">${escapeHtml(row.tracked.reason)}</p>` : row.tracked?.note ? `<p class="publication-change-label">${escapeHtml(row.tracked.note)}</p>` : '';
    return `<section class="publication-block${row.mark ? ' publication-change' : ''}${row.deleted ? ' publication-deleted-block' : ''}${row.tracked?.kind === 'added' ? ' publication-added-block' : ''}"${row.mark ? ` id="publication-change-${row.mark}" tabindex="-1" data-change="${row.mark}"` : ''}>${row.mark ? `<span class="publication-margin-mark" aria-label="Change ${row.mark}">${row.mark}</span>` : ''}${label}${content}${row.changed && row.tracked?.kind !== 'inline' && row.previous?.some((part) => part.length) ? `<details class="publication-previous-fragment"><summary aria-label="Previous exact source${row.mark ? ` for change ${row.mark}` : ''}">${publicationIcon('previousSource')} Previous</summary><pre>${escapeHtml(row.previous.join('\n'))}</pre></details>` : ''}</section>`;
  }).join('');
}

function publicationCurrentPage(view) {
  const title = publicationTitle(view.relativePath, view.text);
  let primary = `<div class="publication-exact-document"><p class="publication-source-label">Exact source</p><pre>${escapeHtml(view.text)}</pre></div>`;
  try {
    const projection = documentProjection({ files: [{ path: view.relativePath, exists: true,
      baseText: view.text, candidateText: view.text }], operations: [] }).files[0].proposed;
    if (projection.available) {
      const rendered = projection.blocks.filter((block) => block.kind !== 'gap').map((block) =>
        `<section class="publication-block">${publicationBlock(block, view.text)}</section>`).join('');
      if (rendered) primary = rendered;
    }
  } catch { /* Unsupported projection keeps the escaped exact document, never a fake operation. */ }
  const detailsContent = `<section id="publication-review-details"><p>The captured page matches the pinned repository version. Current deployment has not been verified.</p><details class="technical-evidence"><summary>Exact source and review details</summary><div class="publication-record"><p>Pinned repository version ${escapeHtml(view.baseCommit)}.</p><p>${escapeHtml(view.relativePath)}</p><h3>Captured page · exact source</h3><pre>${escapeHtml(view.text)}</pre></div></details></section>`;
  return pageShell({ title: `${title} · Review document`, bodyClass: 'publication-page publication-document-review', script: '/owner/assets/publication.js',
    body: `${publicationHeader(true)}<main class="publication-review-app" data-marks-visible="false"><header class="publication-toolbar" aria-label="Document review controls"><div class="publication-toolbar-title"><h1>${escapeHtml(title)}</h1></div><div class="publication-review-controls"><span role="status">No changes</span><button type="button" id="publication-toggle-details" aria-expanded="false" aria-controls="publication-details-dialog" aria-haspopup="dialog" hidden>${publicationIcon('panel')}<span>Details</span></button></div><div class="publication-toolbar-publish"><span>Read only</span></div></header><div class="publication-document-scroll" id="publication-document-scroll" tabindex="0" aria-label="Reviewed document"><div class="publication-document-content"><article class="publication-reviewed-document" aria-label="Captured document">${primary}</article><details id="publication-review-fallback"><summary>Details</summary>${detailsContent}</details></div></div></main>${publicationDetailsDialog()}` });
}

function publicationDetailsDialog() {
  return `<dialog id="publication-details-dialog" aria-labelledby="publication-details-heading"><header class="publication-details-header"><h2 id="publication-details-heading">Details</h2><button type="button" id="publication-close-details" aria-label="Close details" autofocus>${publicationIcon('close')}<span>Close</span></button></header><div id="publication-details-body"></div></dialog>`;
}

function publicationReviewPage(draft, job, modeKey, csrfToken, publishAvailable) {
  const { session, operation, candidate } = draft.prepared;
  const title = publicationTitle(session.relativePath, candidate.text);
  const exactOperation = { path: session.relativePath, start: operation.start, end: operation.end,
    oldText: Buffer.from(operation.expectedOldBytesBase64, 'base64').toString('utf8'),
    replacementText: Buffer.from(operation.replacementBytesBase64, 'base64').toString('utf8') };
  const display = publicationDisplay({ path: session.relativePath, baseText: session.source.text,
    candidateText: candidate.text, operation: exactOperation });
  const diagnostic = job.status === 'present'
    ? `<p>This draft already has one job (${escapeHtml(job.state)}). It will not start again. Preparing unchanged evidence returns this same draft and job.</p>`
    : job.status === 'missing' ? '' : '<p>Job state cannot be established safely. Publication is unavailable; do not assume the job is absent.</p>';
  const publishable = publishAvailable && display.available && job.status === 'missing';
  const action = !publishAvailable ? '<span>Read only</span>' : !display.available
    ? '<p class="publication-unavailable" role="alert">The pinned source, exact operation and candidate are inconsistent or unavailable. Publish is disabled. Inspect the exact evidence.</p><button type="button" disabled>Publish unavailable</button>'
    : job.status === 'present'
      ? `<a class="publication-button" href="/owner/jobs/${draft.jobId}">View progress</a>`
      : publishable
        ? `<form id="publication-form" data-action="publish" data-draft-id="${draft.draftId}" data-csrf="${escapeHtml(csrfToken)}"><button type="submit">Publish</button><p id="publication-status" class="status" role="status"></p><noscript><p>JavaScript is required for deliberate publication confirmation.</p></noscript></form>`
        : '<p>Publication status is unavailable. A job may already exist; reload this review before taking another action.</p><button type="button" disabled>Publish unavailable</button>';
  const dialog = publishable ? `<dialog id="publication-dialog" aria-labelledby="publication-confirm-heading" aria-describedby="publication-confirm-consequence"><h2 id="publication-confirm-heading">Publish this version?</h2><p class="publication-dialog-title">${escapeHtml(title)}</p><p class="publication-meta">${escapeHtml(session.liveUrl)}</p><p id="publication-confirm-consequence">This runs checks, applies the exact reviewed change, commits and pushes it, then checks the deployment. Later authoring edits are not included.</p><div class="dialog-actions"><button type="button" class="publication-cancel" id="publication-cancel" autofocus>Cancel</button><button type="button" id="publication-confirm">Publish</button></div></dialog>` : '';
  const secondary = modeKey === 'current' || modeKey === 'compare';
  const comparison = display.available ? `<details id="publication-comparison"${modeKey === 'compare' ? ' open' : ''}><summary>Comparison with pinned repository version</summary><p>Exact comparison evidence, not a second publishing choice.</p><div class="proof-grid"><section><h3>Pinned repository version</h3><pre>${escapeHtml(session.source.text)}</pre></section><section><h3>Proposed version</h3><pre>${escapeHtml(candidate.text)}</pre></section></div></details>` : '';
  const primary = display.available ? publicationDocument(display, candidate.text) : `<p role="alert">${escapeHtml(display.reason)}</p><pre>${escapeHtml(candidate.text)}</pre>`;
  const marksVisible = modeKey !== 'proposed' && !display.tracked?.defaultClean;
  const trackedCount = display.tracked?.rows.filter((row) => row.mark).length ?? 0;
  const iconControl = (id, label, icon, extra = '', tooltip = label) => `<span class="publication-tool"><button type="button" id="publication-${id}" aria-label="${label}" aria-describedby="publication-${id}-tip" ${extra}>${publicationIcon(icon)}</button><span class="publication-tooltip" role="tooltip" id="publication-${id}-tip">${tooltip}</span></span>`;
  const reviewLimit = display.coarse ? `<aside class="publication-review-limit"><h3>Whole-document review</h3><p>${escapeHtml(display.coarseReason)}</p>${display.tracked?.reason && display.tracked.reason !== display.coarseReason ? `<p>${escapeHtml(display.tracked.reason)}</p>` : ''}</aside>` : '';
  const detailsContent = `<section id="publication-review-details">${reviewLimit}<details id="publication-previous-version"${modeKey === 'current' ? ' open' : ''}><summary>Pinned repository version</summary>${display.available && !display.exactOnly ? `<article class="publication-reviewed-document">${publicationDocument(display, session.source.text, { previous: true })}</article>` : `<pre>${escapeHtml(session.source.text)}</pre>`}</details>${comparison}<details class="technical-evidence"><summary>Exact source and review details</summary><div class="publication-record"><p>Captured authoring version ${draft.prepared.reference.source.version}. Draft ${draft.draftId}.</p><p>${escapeHtml(session.relativePath)} · ${escapeHtml(session.liveUrl)}</p>${diagnostic}${!display.available ? `<p>${escapeHtml(display.reason)}</p>` : ''}<h3>Pinned repository version · exact source</h3><pre>${escapeHtml(session.source.text)}</pre><h3>Entire proposed version · exact source</h3><pre>${escapeHtml(candidate.text)}</pre><h3>Authoritative exact operation</h3><p>Byte range ${operation.start}–${operation.end}. Derived display differences are never saved or applied.</p><h4>Expected old text</h4><pre>${escapeHtml(exactOperation.oldText)}</pre><h4>Replacement text</h4><pre>${escapeHtml(exactOperation.replacementText)}</pre></div></details></section>`;
  const detailsDialog = publicationDetailsDialog();
  return pageShell({ title: `${title} · Review document`, bodyClass: 'publication-page publication-document-review', script: '/owner/assets/publication.js',
    body: `${publicationHeader(true)}<main class="publication-review-app" data-marks-visible="${marksVisible}"><header class="publication-toolbar" aria-label="Document review controls"><div class="publication-toolbar-title"><h1>${escapeHtml(title)}</h1></div><div class="publication-review-controls">${display.available && trackedCount > 0 ? `<div class="publication-change-controls" aria-label="Change navigation">${iconControl('previous-change', 'Previous change', 'previous')}<output id="publication-change-count" aria-hidden="true">${trackedCount} ${trackedCount === 1 ? 'change' : 'changes'}</output>${iconControl('next-change', 'Next change', 'next')}</div>` : ''}${display.available ? iconControl('toggle-marks', 'Show changes', 'eye', `aria-pressed="${marksVisible}"`, marksVisible ? 'Changes shown' : 'Changes hidden') : ''}<button type="button" id="publication-toggle-details" aria-expanded="false" aria-controls="publication-details-dialog" aria-haspopup="dialog" hidden>${publicationIcon('panel')}<span>Details</span></button></div><div class="publication-toolbar-publish">${action}</div><span id="publication-review-announcement" class="publication-sr-only" role="status" aria-live="polite" aria-atomic="true">${trackedCount} ${trackedCount === 1 ? 'change' : 'changes'}. ${marksVisible ? 'Changes shown.' : 'Changes hidden.'}</span></header><div class="publication-document-scroll" id="publication-document-scroll" tabindex="0" aria-label="Reviewed document"><div class="publication-document-content">${display.coarse ? '<aside class="publication-coarse" role="note">Whole-document review</aside>' : ''}<article class="publication-reviewed-document" aria-label="Proposed document">${primary}</article><details id="publication-review-fallback"${secondary ? ' open' : ''}><summary>Details</summary>${detailsContent}</details></div></div></main>${detailsDialog}${dialog}` });
}

function technicalEvidence(entry, { decision = null, queueRetained = null, title = 'Technical evidence', disclosure = true } = {}) {
  const { evidence, summary, sourceVerification } = entry;
  const { classification: trust, verifiedSubject } = evidence.classification;
  const trustReasons = trust.reasons.length === 0
    ? '<p class="empty-state">No classification reason codes were recorded.</p>'
    : `<ul class="trust-reasons">${trust.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`;
  let decisionFacts = '';
  if (decision !== null) {
    const retained = queueRetained === true
      ? 'Still retained in the proposal queue.'
      : queueRetained === false
        ? 'No longer retained; exact reviewed evidence is embedded here.'
        : 'Queue retention could not be confirmed.';
    decisionFacts = `<section><h3>Decision record</h3><dl class="technical-facts">
<div><dt>Owner</dt><dd>${escapeHtml(decision.decisionAuthority.identity)}</dd></div>
<div><dt>Authority scope</dt><dd>${escapeHtml(decision.authorityScope)}</dd></div>
<div><dt>Queue copy</dt><dd>${escapeHtml(retained)}</dd></div>
</dl></section>`;
  }
  const submitter = evidence.carrier?.lane === 'lane-signed' ? evidence.carrier.metadata.submitter : null;
  const report = `<div class="technical-evidence-body">
<section><h3>Source binding</h3><dl class="technical-facts">
<div><dt>Path</dt><dd>${escapeHtml(summary.source.path)}</dd></div>
<div><dt>Repository</dt><dd>${escapeHtml(summary.source.repository)}</dd></div>
<div><dt>Revision</dt><dd>${escapeHtml(summary.source.revision)}</dd></div>
<div><dt>Git blob</dt><dd>${escapeHtml(sourceVerification?.gitObjectId ?? 'embedded decision evidence')}</dd></div>
<div><dt>Base digest</dt><dd>${escapeHtml(reviewProposalBinding(evidence.proposal).base.digest)}</dd></div>
<div><dt>Candidate digest</dt><dd>${escapeHtml(reviewProposalBinding(evidence.proposal).candidate.digest)}</dd></div>
</dl></section>
<section><h3>Proposal record</h3><dl class="technical-facts">
<div><dt>Queue ID</dt><dd>${escapeHtml(summary.queueId)}</dd></div>
<div><dt>Proposal ID</dt><dd>${escapeHtml(summary.proposalId)}</dd></div>
<div><dt>Proposal digest</dt><dd>${escapeHtml(summary.proposalDigest)}</dd></div>
<div><dt>Review evidence</dt><dd>${escapeHtml(summary.reviewEvidenceDigest)}</dd></div>
<div><dt>Received</dt><dd>${escapeHtml(summary.receivedAt)}</dd></div>
<div><dt>Expires</dt><dd>${escapeHtml(summary.expiresAt)}</dd></div>
${submitter ? `<div><dt>Submitter ID</dt><dd>${escapeHtml(submitter.id)}</dd></div><div><dt>Submitter key ID</dt><dd>${escapeHtml(submitter.keyId)}</dd></div>` : ''}
</dl></section>
<section><h3>Trust classification</h3><dl class="technical-facts">
<div><dt>Tier</dt><dd>${escapeHtml(summary.tier)}</dd></div>
<div><dt>Lane</dt><dd>${escapeHtml(summary.lane)}</dd></div>
<div><dt>Route</dt><dd>${escapeHtml(summary.route)}</dd></div>
<div><dt>Verified subject</dt><dd>${escapeHtml(verifiedSubject?.author ?? 'none')}${verifiedSubject?.authorType ? ` (${escapeHtml(verifiedSubject.authorType)})` : ''}</dd></div>
<div><dt>Policy status</dt><dd>${escapeHtml(evidence.classification.policyStatus)}</dd></div>
<div><dt>Policy digest</dt><dd>${escapeHtml(evidence.classification.policyDigest ?? 'none')}</dd></div>
</dl><h4>Reason codes</h4>${trustReasons}</section>
${decisionFacts}
</div>`;
  return disclosure ? `<details class="technical-evidence"><summary>${escapeHtml(title)}</summary>${report}</details>` : report;
}

function proposalTitle(entry, display) {
  const heading = display?.tracked?.rows.find((row) => !row.hidden && !row.deleted && row.block?.kind === 'heading');
  const projected = heading?.block.tokens.map((token) => token.text).join('').trim();
  const source = entry.document?.baseText ?? '';
  const withoutHidden = hasHiddenProposalSource(source) ? '' : source;
  const firstHeading = /^#{1,6}[^\S\r\n]+([^\r\n]+)$/mu.exec(withoutHidden)?.[1]?.replace(/\s+#+\s*$/u, '').trim();
  const filename = path.posix.basename(entry.summary.source.path).replace(/\.md$/iu, '').replace(/[-_]+/gu, ' ').trim();
  return projected || firstHeading || (filename ? filename[0].toUpperCase() + filename.slice(1) : 'Proposed change');
}

function proposalSender(entry, { link = true } = {}) {
  const origin = forgeOrigin(entry);
  if (origin !== null) return link ? forgeOriginHtml(origin) : `From pull request #${origin.number} on your forge`;
  const carrier = entry.evidence.carrier;
  if (carrier?.lane !== 'lane-signed') return link ? 'From <b>a visitor</b>, not signed in.' : 'From a visitor';
  const { label, kind } = carrier.metadata.submitter;
  const whose = kind === 'agent' ? 'one of your agents' : 'one of your devices';
  return link ? `From <b>${escapeHtml(label)}</b>, ${whose}.` : `From ${escapeHtml(label)}, ${whose}`;
}

function contributorReferences(entry) {
  const { rationale, evidence } = entry.evidence.proposal.submission;
  const fullNote = rationale.length > 180 ? `<blockquote>${escapeHtml(rationale)}</blockquote>` : '';
  const links = evidence.length === 0 ? '' : `<p class="identity-references">References: ${evidence.map((url, index) => `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(new URL(url).hostname)}${evidence.length > 1 ? ` (${index + 1})` : ''}</a>`).join(', ')}</p>`;
  return fullNote + links;
}

// The pinned note, its exact operations, and what each one means to the owner.
function reviewDisplay(entry) {
  const view = proposalView(entry);
  const document = entry.document ?? null;
  const operations = view.operations.map(({ start, end, expected, replacement }) => ({
    path: view.path, start, end, oldText: expected, replacementText: replacement,
  }));
  const display = document?.reason === null ? proposalDisplay({ path: view.path, ...document, operations }) : null;
  const hiddenUnavailable = document?.reason === 'hidden-content' || (!display?.available
    && [document?.baseText, document?.candidateText].some((text) => typeof text === 'string' && hasHiddenProposalSource(text)));
  const model = reviewModel({ operations, display, document, hiddenUnavailable });
  const title = proposalTitle(entry, display);
  const firstBody = display?.tracked?.rows.find((row) => row.block?.kind !== 'frontmatter');
  // A plain, unchanged opening heading already appears as the page title.
  const repeatedTitle = firstBody?.block?.kind === 'heading' && firstBody.block.level === 1 && !firstBody.changed && !firstBody.hidden
    && firstBody.block.uninterpreted?.length === 0 && firstBody.block.tokens.every((token) => token.type === 'text')
    && firstBody.block.tokens.map((token) => token.text).join('') === title ? firstBody : null;
  return { view, document, operations, display, hiddenUnavailable, model, title, repeatedTitle };
}

function reviewFramePage(entry, appearance) {
  const { document, display, hiddenUnavailable, model, title, repeatedTitle } = reviewDisplay(entry);
  const note = hiddenUnavailable ? 'Hidden content · source not shown'
    : document?.reason ? `This page can’t be shown here: ${document.reason}. Every change is listed in the panel.`
      : display && !display.available ? 'This page can’t be shown here. Every change is listed in the panel.' : null;
  return frameDocument({ model, display, document, title, sourcePath: entry.summary.source.path,
    colorScheme: appearance.colorScheme, repeatedTitle, note });
}

function frameResponse(body, status = 200, csp = FRAME_CSP) {
  return response(body, status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
    'X-Frame-Options': 'SAMEORIGIN',
  });
}

function reviewPage({ title, body, script = null, appearance, receipt = false }) {
  return pageShell({ title, body, script, stylesheet: '/owner/assets/review.css',
    bodyClass: `rv-doc rv-scheme-${appearance.colorScheme}${receipt ? ' rv-doc-receipt' : ''}` });
}

function reviewDetailPage({ entry, csrfToken, mode = REVIEW_MODE_KEYS[0], appearance, detailsOpen = false, siteReason = null }) {
  const { model, title, hiddenUnavailable, operations, display } = reviewDisplay(entry);
  const hasHidden = hiddenUnavailable || display?.hasHidden || operations.some((op) => hasHiddenProposalSource(op.oldText + op.replacementText));
  const hiddenOperations = hiddenUnavailable ? new Set(operations.map((_, index) => index + 1)) : display?.hiddenOperations;
  // One quiet line when the note is not shown on the site's own page.
  const siteNote = siteReason === null ? '' : `<p class="rv-note rv-site-note">${escapeReviewHtml(SITE_REVIEW_REASONS[siteReason])}</p>`;
  const details = `<section id="publication-review-details">${siteNote}${changeInspection(entry, { hasHidden, hiddenOperations })}${contributorReferences(entry)}
${technicalEvidence(entry, { disclosure: false })}
${display?.available && !hasHidden ? `<details${mode === 'changes' ? '' : ' open'}><summary>Compare full versions</summary>${comparisonPanel(entry, mode)}</details>` : ''}</section>`;
  const advisory = entry.summary.route === 'reject' ? '<p class="rv-note">Your policy recommends rejecting this one.</p>' : '';
  return reviewPage({ title: `${title} · Proposal`, appearance, script: '/owner/assets/review.js',
    body: reviewShell({ model, entry, title, siteTitle: appearance.siteTitle, senderHtml: proposalSender(entry),
      frameUrl: `/owner/review/${encodeURIComponent(entry.summary.queueId)}/page`, csrfToken,
      maxReasonBytes: OWNER_DECISION_REASON_MAX_BYTES, version: proposalView(entry).version, advisory, detailsHtml: details, detailsOpen }) });
}

// The server's half of "must see before Approve": a proposal with changes the
// page cannot show is approved only with an explicit acknowledgement.
function requiresAcknowledgement(entry) {
  return reviewDisplay(entry).model.mustSee.length > 0;
}

const STALE_REASON_COPY = Object.freeze({
  'source-changed': 'The page changed after you reviewed this suggestion, so the exact change no longer fits.',
  'source-missing': 'The page no longer exists at that path.',
  'revision-unreachable': 'The version of the page this suggestion was written against is no longer on your branch.',
  'trust-policy-changed': 'Your trust policy changed after the review. Look at the suggestion again before applying it.',
  'checkout-moved': 'The page changed just now. Reload this screen and try again.',
});
const UNAPPLICABLE_REASON_COPY = Object.freeze({
  'frontmatter-change': 'The change touches the metadata block at the top of the page, which the page pipeline does not edit yet.',
  'page-not-rendered': 'The page is not part of the published site, so there would be no live page to check after publishing.',
  'path-not-editable': 'The page is outside the paths your policy allows edits on.',
  'source-not-lf-only': 'The page uses line endings the page pipeline does not accept.',
  'source-too-large': 'The page is larger than your policy allows for one save.',
  'changed-bytes-limit': 'The change is larger than your policy allows for one save.',
  'replacement-limit': 'The new text is longer than your policy allows for one save.',
  'changed-lines-limit': 'The change spans more lines than your policy allows for one save.',
  'attempt-limit': 'Too many attempts have been made on this suggestion.',
  'derivation-failed': 'The change could not be prepared for the page pipeline.',
});
// After a decision, in the owner's words: what was decided, whether the
// change can go on the page now, why not, or how far along it is.
function applicationPanel({ application, summary, csrfToken, entry = null }) {
  const sourcePath = escapeHtml(summary.source.path);
  const jobLink = (attempt) => `<a class="rv-link application-job-link" href="/owner/jobs/${encodeURIComponent(attempt.jobId)}">Follow it</a>`;
  const note = (text) => `<p class="rv-note">${text}</p>`;
  if (application === null) {
    return `<h1 id="application-heading">Approved</h1>${note('The page has not changed. Putting it on the page isn’t available in this setup.')}`;
  }
  const { state } = application;
  if (state === 'applied') {
    const latest = application.latest;
    const live = latest.jobState === 'completed';
    const origin = entry === null ? null : forgeOrigin(entry);
    const forgeFollowUp = origin === null ? ''
      : note(`<a href="${escapeHtml(origin.url)}" rel="noopener noreferrer">Pull request #${origin.number}</a> on your forge is still open. Close it there; this app never writes to your forge.`);
    return `<h1 id="application-heading">${live ? 'Live on the page' : 'Applying'}</h1>
<p class="rv-note application-stage"><strong>${escapeHtml(jobStageCopy(latest.jobState))}</strong> ${jobLink(latest)}</p>
<p class="rv-meta">Applied ${reviewTime(latest.appliedAt)}${latest.attempt > 1 ? ` · attempt ${latest.attempt}` : ''}</p>${forgeFollowUp}`;
  }
  const earlier = application.attempts.length === 0 ? ''
    : note(`An earlier attempt stopped before changing the page. ${jobLink(application.attempts.at(-1))}`);
  if (state === 'stale' || state === 'unapplicable') {
    const copy = state === 'stale'
      ? STALE_REASON_COPY[application.reason] ?? 'The page is no longer exactly what you reviewed.'
      : UNAPPLICABLE_REASON_COPY[application.reason] ?? 'The change could not be prepared for the page pipeline.';
    return `<h1 id="application-heading" class="rv-blocked">${state === 'stale' ? 'Approved, but the page has moved on' : 'Approved, but it can’t be applied'}</h1>
${note(escapeHtml(copy))}${note('Your approval stays recorded. To make this change now, edit the page yourself.')}${earlier}`;
  }
  if (state === 'eligible') {
    return `<h1 id="application-heading">Approved</h1>
${note('The page has not changed. Applying is a separate step.')}
<div class="rv-act"><button type="button" class="rv-pri" data-apply>Apply to page</button></div>
<noscript><p class="rv-note">Applying needs scripting enabled in this browser.</p></noscript>${earlier}
<dialog id="decision-dialog" aria-labelledby="apply-dialog-title">
<form id="apply-form" class="decision-sheet" data-queue-id="${escapeHtml(summary.queueId)}" data-csrf="${escapeHtml(csrfToken)}">
<h2 id="apply-dialog-title">Apply to the page?</h2>
<p class="dialog-suggestion"><span>${sourcePath}</span></p>
<p id="apply-status" class="status" role="status" aria-live="polite" tabindex="-1"></p>
<p class="decision-boundary">This changes the page, commits and pushes it, and publishes it, the same way your own saves do. The next screen follows it step by step.</p>
<div class="dialog-actions"><button type="button" class="dialog-back" data-dialog-cancel>Cancel</button><button type="button" id="apply-confirm" class="rv-pri">Apply to page</button></div>
</form>
</dialog>`;
  }
  return `<h1 id="application-heading">Approved</h1>${note(`The page has not changed. Couldn’t check whether it can be applied just now${application.reason ? ` (${escapeHtml(application.reason)})` : ''}. Reload to try again.`)}`;
}

// A decided proposal, with the pinned page text while the queue still holds it
// (display only; the decision record itself never keeps page text).
function decidedEntry({ decision, summary, document = null }) {
  const entry = decisionEntry(decision, summary);
  return document === null ? entry : Object.freeze({ ...entry, document });
}

function decisionDetailPage({ decision, summary, queueRetained, application = null, csrfToken = '', appearance, firstAnchor = null }) {
  const entry = decisionEntry(decision, summary);
  const title = proposalTitle(entry);
  const approved = decision.action === 'approve';
  const panel = approved
    ? applicationPanel({ application, summary, csrfToken, entry })
    : '<h1 id="application-heading">Rejected</h1><p class="rv-note">Nothing changed. The page is exactly as it was.</p>';
  const note = `<p class="rv-meta">${approved ? 'Approved' : 'Rejected'} ${reviewTime(decision.decidedAt)}. Your note: <q class="decision-note">${escapeHtml(decision.reason)}</q></p>`;
  return reviewPage({ title: approved ? 'Proposal approved' : 'Proposal rejected', appearance, receipt: true,
    script: ['/owner/assets/review.js', ...(application?.state === 'eligible' ? ['/owner/assets/apply.js'] : [])],
    body: receiptShell({ siteTitle: appearance.siteTitle, title,
      frameUrl: `/owner/decisions/${encodeURIComponent(summary.queueId)}/page`, firstAnchor,
      senderHtml: proposalSender(entry), panelHtml: `${panel}${note}`,
      detailsHtml: `${changeInspection(entry)}${contributorReferences(entry)}${technicalEvidence(entry, { decision, queueRetained, disclosure: false })}` }) });
}

function decisionFramePage({ decision, summary, document = null }, appearance) {
  const entry = decisionEntry(decision, summary);
  return excerptDocument({ operations: proposalView(entry).operations, title: proposalTitle(entry),
    sourcePath: summary.source.path, colorScheme: appearance.colorScheme,
    baseText: document?.reason === null && typeof document.baseText === 'string' ? document.baseText : null });
}

function optionalQueryObject(url, allowed) {
  const found = new Map();
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || found.has(key)) return null;
    found.set(key, value);
  }
  return Object.fromEntries(found);
}

function queryObject(url, required) {
  const found = new Map();
  for (const [key, value] of url.searchParams) {
    if (!required.includes(key) || found.has(key)) return null;
    found.set(key, value);
  }
  if (found.size !== required.length || required.some((key) => !found.has(key))) return null;
  return Object.fromEntries(found);
}

function parseBootstrapBody(text) {
  const value = JSON.parse(text);
  // A single string-valued member cannot hide duplicate (including escaped)
  // keys. JSON.parse first validates string escapes and JSON whitespace.
  if (!/^[\t\n\r ]*\{[\t\n\r ]*"(?:[^"\\]|\\[\s\S])*"[\t\n\r ]*:[\t\n\r ]*"(?:[^"\\]|\\[\s\S])*"[\t\n\r ]*\}[\t\n\r ]*$/u.test(text)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'token')
    || !exactToken(value.token)
    || Buffer.from(value.token, 'base64url').toString('base64url') !== value.token) {
    throw new Error('bootstrap-body');
  }
  return value;
}

async function readBoundedJson(request, maximum, parse = JSON.parse, mediaType = 'application/json') {
  const contentType = request.headers.get('content-type');
  if ((mediaType === 'application/json' ? contentType : contentType?.split(';')[0]) !== mediaType) throw Object.assign(new Error('content-type'), { status: 415 });
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) throw Object.assign(new Error('length'), { status: 400 });
    if (Number(declared) > maximum) throw Object.assign(new Error('large'), { status: 413 });
  }
  if (request.body === null) throw Object.assign(new Error('body'), { status: 400 });

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw Object.assign(new Error('large'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parse(text);
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error('json'), { status: 400 });
  }
}

function validateSaveBody(value, maximumEditedBytes) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['editSessionId', 'editedText', 'csrf'].every((key) => keys.includes(key))) return null;
  if (!exactToken(value.editSessionId) || !exactToken(value.csrf) || typeof value.editedText !== 'string') return null;
  if (Buffer.byteLength(value.editedText, 'utf8') > maximumEditedBytes) return null;
  return value;
}

function reviewQueueId(encoded) {
  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
    return validateQueueId(decoded);
  } catch {
    return null;
  }
}

function validateDecisionBody(value, routeQueueId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const required = ['queueId', 'reviewEvidenceDigest', 'action', 'reason', 'csrf'];
  // The one optional field: an explicit "I've seen the changes the page can't show".
  const keys = Object.keys(value).filter((key) => key !== 'acknowledgedInvisible');
  if (keys.length !== required.length || !required.every((key) => keys.includes(key))) return null;
  if (Object.hasOwn(value, 'acknowledgedInvisible') && (value.acknowledgedInvisible !== true || value.action !== 'approve')) return null;
  if (value.queueId !== routeQueueId
    || !['approve', 'reject'].includes(value.action)
    || !exactToken(value.csrf)
    || typeof value.reason !== 'string'
    || value.reason.length === 0
    || value.reason.trim() !== value.reason
    || /\p{Cc}/u.test(value.reason)
    || Buffer.byteLength(value.reason, 'utf8') > OWNER_DECISION_REASON_MAX_BYTES) return null;
  try {
    validateDigest(value.reviewEvidenceDigest, 'reviewEvidenceDigest');
  } catch {
    return null;
  }
  return value;
}

function validateApplyBody(value, routeQueueId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'csrf' || keys[1] !== 'queueId') return null;
  if (value.queueId !== routeQueueId || !exactToken(value.csrf)) return null;
  return { queueId: value.queueId, csrf: value.csrf };
}

function reviewErrorStatus(error) {
  const code = error instanceof OwnerAlphaError ? error.code : 'review-failed';
  if (code === 'lock-busy'
    || code === 'decision-already-recorded'
    || code === 'decision-evidence-mismatch'
    || code === 'decision-evidence-conflict'
    || code === 'review-ipc-invalid-cursor') return 409;
  if (code === 'review-expired' || code === 'decision-expired') return 410;
  if (code === 'review-ipc-not-found' || code === 'review-ipc-queue-entry-not-found') return 404;
  if (code === 'review-source-timeout' || code === 'review-ipc-timeout') return 504;
  if (code === 'review-source-unavailable'
    || code === 'review-ipc-busy'
    || code === 'review-ipc-internal-error') return 503;
  if (code.startsWith('invalid-')
    || code.startsWith('review-before-')
    || code === 'review-not-actionable') return 400;
  return 500;
}

function safePathSegments(encodedPath, { directoryIndex = true } = {}) {
  let candidate = encodedPath;
  let wantsIndex = false;
  if (directoryIndex && (candidate === '' || candidate.endsWith('/'))) {
    wantsIndex = true;
    candidate = candidate.replace(/\/+$/u, '');
  }
  if (candidate === '') return ['index.html'];

  const segments = candidate.split('/').map((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw Object.assign(new Error('path'), { status: 400 });
    }
    if (decoded === ''
      || decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || /\p{Cc}/u.test(decoded)) {
      throw Object.assign(new Error('path'), { status: 400 });
    }
    return decoded;
  });
  if (wantsIndex) segments.push('index.html');
  return segments;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readSafeStatic(rootInput, encodedPath, { directoryIndex = true } = {}) {
  const root = path.resolve(rootInput);
  const segments = safePathSegments(encodedPath, { directoryIndex });
  let rootReal;
  try {
    const rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return { status: 404 };
    rootReal = await realpath(root);
  } catch {
    return { status: 404 };
  }
  if (rootReal !== root) return { status: 404 };

  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 404 };
      return { status: 500 };
    }
    if (metadata.isSymbolicLink()) return { status: 404 };
  }

  let candidateReal;
  try {
    candidateReal = await realpath(current);
  } catch {
    return { status: 404 };
  }
  if (candidateReal !== current || !contained(rootReal, candidateReal)) return { status: 404 };

  let handle;
  try {
    handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) return { status: 404 };
    if (metadata.size > MAX_STATIC_BYTES) return { status: 413 };
    const realMetadata = await stat(candidateReal);
    if (metadata.dev !== realMetadata.dev || metadata.ino !== realMetadata.ino) return { status: 404 };
    return {
      status: 200,
      bytes: await handle.readFile(),
      contentType: CONTENT_TYPES[path.extname(current).toLowerCase()] ?? 'application/octet-stream',
    };
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'ENOENT') return { status: 404 };
    return { status: 500 };
  } finally {
    await handle?.close();
  }
}

async function staticResponse(root, encodedPath, request, options = {}) {
  let result;
  try {
    result = await readSafeStatic(root, encodedPath, options);
    if (result.status === 404
      && options.cleanHtml === true
      && encodedPath !== ''
      && !encodedPath.endsWith('/')) {
      const segments = safePathSegments(encodedPath, { directoryIndex: false });
      const last = segments.at(-1);
      if (last && path.extname(last) === '') {
        result = await readSafeStatic(root, `${encodedPath}.html`, {
          ...options,
          directoryIndex: false,
        });
      }
    }
  } catch (error) {
    return errorResponse(error?.status ?? 400, 'invalid-static-path');
  }
  if (result.status !== 200) return errorResponse(result.status, result.status === 404 ? 'not-found' : 'static-unavailable');
  const bytes = result.bytes;
  const csp = options.csp ?? (options.reader === true ? READER_CSP : OWNER_CSP);
  const headers = securityHeaders({ cache: 'private, max-age=0, must-revalidate', csp });
  headers.set('Content-Type', result.contentType);
  headers.set('Content-Length', String(bytes.length));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

export function createReaderHandler({
  config: configInput,
  projectRoot = PROJECT_ROOT,
  siteRoot,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const expectedHost = `${config.listen.host}:${config.listen.readerPort}`;
  const expectedOrigin = `http://${expectedHost}`;
  const resolvedSiteRoot = siteRoot ?? path.resolve(projectRoot, config.workspace.site);
  const csp = readerCsp(config);

  return async function ownerAlphaReaderFetch(request) {
    if (!(request instanceof Request)) return errorResponse(400, 'invalid-request');
    if (request.headers.get('host') !== expectedHost) return errorResponse(421, 'invalid-host');
    if (!['GET', 'HEAD'].includes(request.method)) {
      return response(null, 405, { Allow: 'GET, HEAD' });
    }
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, 'invalid-url');
    }
    if (url.origin !== expectedOrigin) return errorResponse(421, 'invalid-host');
    const redirect = (location) => {
      const headers = securityHeaders({ csp });
      headers.set('Location', location);
      return new Response(null, { status: 308, headers });
    };
    const notFound = () => {
      const acceptsHtml = request.headers.get('accept')?.split(',').some((range) => {
        const [type, ...parameters] = range.trim().toLowerCase().split(';');
        return type.trim() === 'text/html' && !parameters.some((parameter) => /^q\s*=\s*0(?:\.0*)?\s*$/u.test(parameter.trim()));
      });
      if (!acceptsHtml) return errorResponse(404, 'not-found');
      const headers = securityHeaders({ csp });
      headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(request.method === 'HEAD' ? null : '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title><main><h1>Page not found</h1><p>This page is not available. <a href="/cyberbase/">Go to the site home</a>.</p></main></html>', { status: 404, headers });
    };
    if (url.pathname === '/') return response(null, 302, { Location: '/cyberbase/' });
    if (url.pathname === '/cyberbase') {
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      return redirect('/cyberbase/');
    }
    if (!url.pathname.startsWith('/cyberbase/')) return notFound();
    if (url.search !== '') return errorResponse(400, 'unexpected-query');
    const encodedPath = url.pathname.slice('/cyberbase/'.length);
    const options = { cleanHtml: true, reader: true, csp };
    const original = await staticResponse(resolvedSiteRoot, encodedPath, request, options);
    if (original.status !== 404) return original;
    // Some chat clients escape existing percent signs. Try exactly one extra
    // layer, only after a miss, with the same segment and filesystem checks.
    if (/%25/iu.test(encodedPath)) {
      try {
        const decodedPath = decodeURIComponent(encodedPath);
        const directory = decodedPath.endsWith('/');
        const segments = safePathSegments(directory ? decodedPath.slice(0, -1) : decodedPath, { directoryIndex: false });
        const canonicalPath = segments.map((segment) => encodeURIComponent(segment)).join('/') + (directory ? '/' : '');
        if (canonicalPath !== encodedPath) {
          const recovered = await staticResponse(resolvedSiteRoot, canonicalPath, request, options);
          if (recovered.status === 200) return redirect(`/cyberbase/${canonicalPath}`);
        }
      } catch {
        // Unsafe or malformed extra encodings remain a miss, never a redirect.
      }
    }
    return notFound();
  };
}

// The publication runtime predates the command seam and returns an owner
// route for unchanged captures. Translate it here, not in the command core.
function bindPublication(runtime) {
  if (runtime === null) return null;
  return {
    get publishAvailable() { return runtime.publishAvailable; },
    async prepare(input) {
      const result = await runtime.prepare(input);
      if (result.outcome !== 'unchanged') return result;
      const match = typeof result.reviewUrl === 'string' && /^\/owner\/publication\/current\/([0-9a-f]{64})$/u.exec(result.reviewUrl);
      if (!match) fail('publication-prepare-failed', 'invalid unchanged publication review');
      return { outcome: 'unchanged', viewId: match[1] };
    },
    publish: (input) => runtime.publish(input),
    load: (input) => runtime.load(input),
    loadCurrent: (input) => runtime.loadCurrent(input),
    readJob: (jobId) => runtime.readJob(jobId),
  };
}

function commandGate(commands, grant, principal) {
  try {
    commands.requireGrant(grant, principal);
    return null;
  } catch (error) {
    if (!(error instanceof OwnerAlphaError)) throw error;
    return errorResponse(['invalid-session', 'publication-read-only'].includes(error.code) ? 403 : 404, error.code);
  }
}

// How the owner's site looks, for the review frame and its site line: only a
// title and a colour scheme. Anything else falls back to the quiet default.
const REVIEW_SCHEMES = Object.freeze(['light', 'dark', 'system']);
function validReviewAppearance(value, config) {
  const fallbackTitle = path.posix.basename(new URL(config.repository.remote.url).pathname).replace(/\.git$/u, '') || 'Your site';
  const siteTitle = typeof value?.siteTitle === 'string' && value.siteTitle.trim().length > 0 && value.siteTitle.length <= 80
    && !/\p{Cc}/u.test(value.siteTitle) ? value.siteTitle.trim() : fallbackTitle[0].toUpperCase() + fallbackTitle.slice(1);
  const colorScheme = REVIEW_SCHEMES.includes(value?.colorScheme) ? value.colorScheme : 'light';
  return Object.freeze({ siteTitle, colorScheme });
}

/** The vault's own `.cyberbaser/site.yml` title and colour scheme, when it is a regular file. */
export async function readReviewAppearance(config) {
  try {
    const file = path.join(config.repository.checkout, '.cyberbaser', 'site.yml');
    const info = await lstat(file);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text;
    try { text = await handle.readFile('utf8'); } finally { await handle.close(); }
    const parsed = Bun.YAML.parse(text);
    return { siteTitle: parsed?.site?.title, colorScheme: parsed?.appearance?.colorScheme };
  } catch {
    return null;
  }
}

const KIND_LABELS = Object.freeze({ agent: 'Agent', 'owner-device': 'Phone or computer' });
const ACCESS_LABELS = Object.freeze({ propose: 'Suggest changes', review: 'Review and suggest', full: 'Everything you can do' });

function grantSummary(kind, grants) {
  const set = new Set(grants);
  if (set.size === 1 && set.has('propose')) return 'Suggests changes for you to review';
  if (['read', 'review', 'propose'].every((grant) => set.has(grant)) && set.size === 3) return 'Reviews and suggests changes';
  if (set.size === 7) return 'Everything you can do';
  return grants.join(', ');
}

function deviceRow(device) {
  const kind = KIND_LABELS[device.kind] ?? device.kind;
  return `<li class="device-row${device.revoked ? ' is-revoked' : ''}" data-key-id="${escapeHtml(device.keyId)}">
<div class="device-name"><strong>${escapeHtml(device.label)}</strong><span>${escapeHtml(kind)} · ${escapeHtml(grantSummary(device.kind, device.grants))}</span></div>
${device.revoked ? '<span class="device-state">Revoked</span>' : `<button type="button" class="quiet-danger" data-revoke="${escapeHtml(device.keyId)}">Revoke</button>`}
</li>`;
}

function segmented(name, legend, options, checked) {
  return `<fieldset class="segmented" data-field="${name}"><legend>${escapeHtml(legend)}</legend><div class="segmented-track">${options.map(([value, label]) => `<label class="segment"><input type="radio" name="${name}" value="${escapeHtml(value)}"${value === checked ? ' checked' : ''}><span>${escapeHtml(label)}</span></label>`).join('')}</div></fieldset>`;
}

// The pairing form shared by Devices and first-run setup. A fixed kind
// renders as a hidden field, so setup asks only what matters for that step.
// `access` is the preselected choice for a phone or computer.
export function pairFormHtml({ kind = null, label = 'My agent', access = null } = {}) {
  const kindField = kind === null
    ? segmented('kind', 'What is it?', [['agent', 'Agent'], ['owner-device', 'Phone or computer']], 'agent')
    : `<input type="hidden" name="kind" value="${escapeHtml(kind)}">`;
  const accessField = kind === 'agent'
    ? '<input type="hidden" name="access" value="propose">'
    : segmented('access', 'What may it do?', Object.entries(ACCESS_LABELS), access ?? (kind === 'owner-device' ? 'review' : 'propose'));
  return `<form id="pair-form" class="pair-form">
${kindField}
${accessField}
<p class="access-note" id="access-note"${kind === 'owner-device' ? ' hidden' : ''}>Agents can only suggest changes. You review each one.</p>
<label class="field" for="pair-label">Name<input id="pair-label" name="label" maxlength="64" autocomplete="off" value="${escapeHtml(label)}" required></label>
<div class="pair-actions"><button type="submit">${kind === 'agent' ? 'Get pairing line' : kind === 'owner-device' ? 'Show QR code' : 'Get pairing code'}</button></div>
<p class="status" id="pair-status" role="status" aria-live="polite"></p>
</form>
<div id="pair-live" class="pair-live" hidden aria-live="polite"></div>`;
}

function devicesPage({ csrfToken, devices, reachable, linking = false }) {
  const active = devices.filter((device) => !device.revoked);
  const revoked = devices.filter((device) => device.revoked);
  const list = active.length === 0
    ? '<p class="devices-empty">Nothing paired yet. Pair an agent or phone below.</p>'
    : `<ul class="device-list" id="device-list">${active.map(deviceRow).join('')}</ul>`;
  return pageShell({
    title: 'Devices and agents',
    script: '/owner/assets/devices.js',
    bodyClass: 'devices-page',
    body: `<main class="owner-shell devices-shell" id="devices" data-csrf="${escapeHtml(csrfToken)}">
<header class="owner-header"><h1>Devices and agents</h1><p class="lede">Each one can do only what you picked when you paired it. Revoke takes effect at once.</p></header>
<section class="devices-section" aria-labelledby="paired-heading"><h2 id="paired-heading">Paired</h2><div id="device-list-slot">${list}</div>
${revoked.length ? `<details class="revoked-list"><summary>Revoked (${revoked.length})</summary><ul class="device-list">${revoked.map(deviceRow).join('')}</ul></details>` : ''}</section>
<section class="devices-section" aria-labelledby="pair-heading"><h2 id="pair-heading">Pair a new one</h2>
${reachable ? pairFormHtml() : '<p class="devices-empty">Pairing needs Iroh reach turned on for this node.</p>'}
<noscript><p>Pairing and Revoke need scripting enabled in this browser.</p></noscript>
</section>
${linking ? `<section class="devices-section" id="link-notes" aria-labelledby="link-heading" hidden><h2 id="link-heading">Notes to link</h2>
<p class="section-note">A device sent a note this node could not place in your vault. Pick the vault file it belongs to. It links only if both texts match.</p>
<div id="link-list"></div><datalist id="vault-paths"></datalist></section>` : ''}
</main>`,
  });
}

function parseDevicesBody(fields) {
  return (text) => {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...fields, 'csrf'].sort().join(',') || !exactToken(value.csrf)) throw new Error('fields');
    return value;
  };
}

/**
 * Routes under /owner/devices, shared by the owner app and first-run setup.
 * Returns null for any other path. `page` renders the full Devices page.
 */
export async function handleDeviceRoutes({ request, url, csrfToken, devices, page = true }) {
  if (url.pathname !== '/owner/devices' && !url.pathname.startsWith('/owner/devices/')) return null;
  if (devices === null) return errorResponse(404, 'devices-unavailable');
  const { store, pairing } = devices;
  if (url.search !== '') return errorResponse(400, 'unexpected-query');
  if (url.pathname === '/owner/devices') {
    if (!page) return errorResponse(404, 'not-found');
    if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
    return html(request.method === 'HEAD' ? null : devicesPage({ csrfToken, devices: store.list(), reachable: pairing.available(),
      linking: Boolean(devices.links) }));
  }
  if (url.pathname === '/owner/devices/state') {
    if (request.method !== 'GET') return response(null, 405, { Allow: 'GET' });
    return json({ devices: store.list(), pairings: pairing.list() });
  }
  if (url.pathname === '/owner/devices/links') {
    // Owner session only: paths the devices reported and the published
    // vault paths to pick from. Never note text.
    if (request.method !== 'GET') return response(null, 405, { Allow: 'GET' });
    if (!devices.links) return errorResponse(404, 'not-found');
    let paths = [];
    try { paths = await devices.noteStatus.publishedPaths(); } catch { /* picker stays empty */ }
    return json({ requests: devices.links.list(), paths });
  }
  const action = { '/owner/devices/pair': ['kind', 'access', 'label'], '/owner/devices/confirm': ['enrollmentId', 'words'],
    '/owner/devices/cancel': ['enrollmentId'], '/owner/devices/revoke': ['keyId'],
    ...(devices.links ? { '/owner/devices/link': ['requestId', 'vaultPath'], '/owner/devices/link-dismiss': ['requestId'] } : {}) }[url.pathname];
  if (!action) return errorResponse(404, 'not-found');
  if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
  let body;
  try { body = await readBoundedJson(request, 2048, parseDevicesBody(action)); }
  catch (error) { return errorResponse(error?.status ?? 400, 'invalid-devices-body'); }
  if (!sameSecret(body.csrf, csrfToken)) return errorResponse(403, 'invalid-csrf');
  try {
    if (url.pathname === '/owner/devices/pair') {
      const started = pairing.start({ kind: body.kind, access: body.access, label: typeof body.label === 'string' ? body.label.trim() : null });
      // A phone camera opens obsidian://cyberbaser-pair?code=… straight into pairing.
      const link = `obsidian://cyberbaser-pair?code=${encodeURIComponent(started.code)}`;
      const matrix = qrMatrix(link);
      return json({ ok: true, ...started, link, qr: { size: matrix.size + 8, path: qrPath(matrix) } });
    }
    if (url.pathname === '/owner/devices/link') {
      try { return json({ ok: true, ...(await devices.links.confirm({ requestId: body.requestId, vaultPath: body.vaultPath })) }); }
      catch (error) { return json({ ok: false, reason: error instanceof OwnerAlphaError ? error.code : 'link-refused' }, 409); }
    }
    if (url.pathname === '/owner/devices/link-dismiss') { devices.links.dismiss(body.requestId); return json({ ok: true }); }
    if (url.pathname === '/owner/devices/confirm') return json({ ok: true, ...(await pairing.confirm({ enrollmentId: body.enrollmentId, words: body.words })) });
    if (url.pathname === '/owner/devices/cancel') { pairing.cancel(body.enrollmentId); return json({ ok: true }); }
    await store.revoke(body.keyId);
    return json({ ok: true });
  } catch { return errorResponse(409, 'devices-refused'); }
}

export function createOwnerAlphaHandler({
  config: configInput,
  projectRoot = PROJECT_ROOT,
  siteRoot,
  publicRoot = PUBLIC_ROOT,
  createEditSession = createSourceEditSession,
  editSessions = createMemoryEditSessionStore(),
  handoffs = createOwnerHandoffStore({ createId: token }),
  directEdits = createMemoryEditSessionStore(),
  saveEdit,
  lookupJob,
  proposalReview = null,
  ownerPublication = null,
  createToken = token,
  createJobId = () => `OA-${randomUUID()}`,
  reviewAppearance = null,
  // The owner-private site build whose pages a proposal is shown on. Null
  // shows every proposal on the simplified rendering.
  reviewSiteRoot = null,
  // New pages from bundles on the site's own design (bundle-preview.js). By
  // default only with a configured renderer; null keeps the simplified page.
  bundlePreview = undefined,
  // { store, pairing } when Iroh reach is on: the Devices and agents page.
  devices = null,
  // Publishing to GitHub: relays to the publisher's forge control, never a credential.
  forgeSetup = null,
  // { sessionToken, csrfToken } the first-run setup in this same process
  // already gave the owner's browser, so setup ends signed in. Never on disk.
  adoptSession = null,
  // { current() -> { state: 'reachable' | 'unreachable' | 'unknown' } }: whether
  // the publisher last reached GitHub. Shown quietly where publishing needs it.
  upstream = null,
  // () -> false, or 'running' / 'failed' while startup job recovery has not
  // settled cleanly. Owner actions that
  // could conflict with a recovering job are refused until it settles; signing
  // in and reading stay available.
  recovering = () => false,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (typeof recovering !== 'function') throw new TypeError('recovering must be a function');
  const appearance = validReviewAppearance(reviewAppearance, config);
  const previewBundle = bundlePreview === undefined ? createBundlePreview({ config, projectRoot }) : bundlePreview;
  if (previewBundle !== null && typeof previewBundle !== 'function') throw new TypeError('bundlePreview must be null or a function');
  if (reviewSiteRoot !== null && (typeof reviewSiteRoot !== 'string' || !path.isAbsolute(reviewSiteRoot))) {
    throw new TypeError('reviewSiteRoot must be null or one absolute path');
  }
  // The site page with its changes, or why the simplified rendering is shown.
  async function siteReview(entry) {
    if (reviewSiteRoot === null) return { html: null, reason: null };
    const { document, operations, model } = reviewDisplay(entry);
    return siteReviewFrame({ siteRoot: reviewSiteRoot, sourcePath: entry.summary.source.path, revision: entry.summary.source.revision,
      document, operations, model, colorScheme: appearance.colorScheme, rendererName: rendererIdentity(config).name });
  }
  if (typeof createEditSession !== 'function'
    || typeof saveEdit !== 'function'
    || typeof lookupJob !== 'function'
    || typeof createJobId !== 'function') {
    throw new TypeError('createEditSession, saveEdit, lookupJob, and createJobId dependencies are required');
  }
  if (!editSessions || typeof editSessions.create !== 'function' || typeof editSessions.get !== 'function' || typeof editSessions.delete !== 'function') {
    throw new TypeError('editSessions must provide create, get, and delete');
  }
  if (config.proposalReview.enabled
    && (!proposalReview
      || typeof proposalReview.list !== 'function'
      || typeof proposalReview.load !== 'function'
      || typeof proposalReview.loadDecision !== 'function'
      || typeof proposalReview.record !== 'function')) {
    throw new TypeError('enabled proposal review requires list, load, loadDecision, and record dependencies');
  }
  if (config.ownerPublication.enabled
    && ['prepare', 'load', 'loadCurrent', 'publish', 'readJob'].some((key) => typeof ownerPublication?.[key] !== 'function')) {
    throw new TypeError('enabled owner publication requires prepare, load, loadCurrent, publish, and readJob dependencies');
  }
  const principalAdapter = createBootstrapPrincipalAdapter();
  const commands = createOwnerCommands({
    config, projectRoot, principalAdapter, createEditSession, editSessions, handoffs, directEdits,
    saveEdit, lookupJob, createJobId, proposalReview, publication: bindPublication(ownerPublication),
    bundleDesk: devices?.bundleDesk ?? null,
  });
  // Each consumed bootstrap capability becomes one device session with its own
  // cookie and CSRF token, so one captured device secret is not every device's
  // secret. Only local console authority can mint a new capability.
  const sessions = new Map();
  const issuedTokens = new Set();
  let outstanding = null;

  function createBootstrapCapability() {
    if (sessions.size >= MAX_OWNER_SESSIONS) {
      fail('owner-session-capacity', 'active owner sessions are at capacity; restart the server to reset sessions');
    }
    // Generation order (session, CSRF, bootstrap) is part of the deterministic
    // token-factory contract used by fixtures.
    const sessionToken = createToken();
    const csrfToken = createToken();
    const capability = {
      sessionToken,
      csrfToken,
      bootstrapToken: createToken(),
    };
    const tokens = Object.values(capability);
    if (tokens.some((value) => !exactToken(value) || issuedTokens.has(value))
      || new Set(tokens).size !== 3) {
      throw new TypeError('process token factory must return distinct unseen 32-byte base64url tokens');
    }
    for (const value of tokens) issuedTokens.add(value);
    return capability;
  }

  function issueBootstrap() {
    outstanding = createBootstrapCapability();
    return outstanding.bootstrapToken;
  }

  function consumeBootstrap(value) {
    if (outstanding === null || !sameSecret(value, outstanding.bootstrapToken)) return null;
    const consumed = outstanding;
    outstanding = null;
    const principal = principalAdapter.fromSession({
      id: config.owner.identity, sessionId: randomUUID(), authenticatedAt: Date.now(),
    });
    sessions.set(consumed.sessionToken, { csrfToken: consumed.csrfToken, principal });
    return consumed.sessionToken;
  }

  function resolveSession(cookieValue) {
    if (!exactToken(cookieValue)) return null;
    // Constant-time scan; the map is bounded by MAX_OWNER_SESSIONS.
    let found = null;
    for (const [sessionToken, record] of sessions) {
      if (sameSecret(cookieValue, sessionToken)) found = record;
    }
    return found;
  }

  if (adoptSession !== null) {
    const { sessionToken, csrfToken } = adoptSession ?? {};
    if (!exactToken(sessionToken) || !exactToken(csrfToken) || sessionToken === csrfToken) {
      throw new TypeError('adoptSession needs two distinct 32-byte base64url tokens');
    }
    issuedTokens.add(sessionToken);
    issuedTokens.add(csrfToken);
    sessions.set(sessionToken, { csrfToken, principal: principalAdapter.fromSession({
      id: config.owner.identity, sessionId: randomUUID(), authenticatedAt: Date.now() }) });
  }
  issueBootstrap();
  const initialBootstrapToken = outstanding.bootstrapToken;
  const expectedHost = `${config.listen.host}:${config.listen.port}`;
  const expectedOrigin = `http://${expectedHost}`;
  const readerOrigin = `http://${config.listen.host}:${config.listen.readerPort}`;
  const maximumBodyBytes = Math.min(
    config.limits.maxArtifactBytes,
    config.limits.maxSourceBytes + 16 * 1024,
  );

  const handler = async function ownerAlphaFetch(request) {
    if (!(request instanceof Request)) return errorResponse(400, 'invalid-request');
    if (request.headers.get('host') !== expectedHost) return errorResponse(421, 'invalid-host');
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      return response(null, 405, { Allow: 'GET, HEAD, POST' });
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, 'invalid-url');
    }
    if (url.origin !== expectedOrigin) return errorResponse(421, 'invalid-host');

    if (url.pathname === '/owner/sign-in') {
      if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      return html(request.method === 'HEAD' ? null : signInPage());
    }
    const signInAsset = {
      '/owner/assets/bootstrap.js': 'bootstrap.js',
      '/owner/assets/owner.css': 'owner.css',
    }[url.pathname];
    if (signInAsset) {
      if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      const assetResponse = await staticResponse(publicRoot, signInAsset, request, { directoryIndex: false });
      assetResponse.headers.set('Cache-Control', 'no-store');
      assetResponse.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      return assetResponse;
    }

    if (url.pathname === '/owner/bootstrap') {
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== expectedOrigin) return errorResponse(403, 'invalid-origin');
        if (url.search !== '') return errorResponse(400, 'unexpected-query');
        let body;
        try { body = await readBoundedJson(request, 256, parseBootstrapBody); }
        catch (error) { return errorResponse(error?.status ?? 400, 'invalid-bootstrap-body'); }
        const sessionToken = consumeBootstrap(body.token);
        body.token = null;
        if (sessionToken === null) return errorResponse(403, 'invalid-bootstrap');
        return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(sessionToken) });
      }
      if (request.method !== 'GET') return response(null, 405, { Allow: 'GET, POST' });
      const query = queryObject(url, ['token']);
      const sessionToken = query ? consumeBootstrap(query.token) : null;
      if (sessionToken === null) return errorResponse(403, 'invalid-bootstrap');
      return response(null, 303, {
        Location: config.ownerPublication.enabled ? '/owner/publication' : `${readerOrigin}/cyberbase/`,
        'Set-Cookie': cookieHeader(sessionToken),
      });
    }

    // Inert cross-origin handoff only. No cookie, CSRF, edit session, durable
    // authorization, job or source write is created here. Even a hostile reader
    // can do no more than ask the owner to inspect an expiring bounded draft.
    if (url.pathname === '/owner/stage') {
      if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
      if (url.search) return errorResponse(400, 'unexpected-query');
      try {
        const handoff = await readBoundedJson(request, 800 * 1024, text => {
          const fields = new URLSearchParams(text);
          if ([...fields.keys()].join(',') !== 'changeSet') throw Error('invalid fields');
          return JSON.parse(fields.get('changeSet'));
        }, 'application/x-www-form-urlencoded');
        const { stageId } = await commands.stageOwnerDirect({ handoff });
        return response(null, 303, { Location: `/owner/staged/${stageId}` });
      } catch (error) { return errorResponse(error?.status ?? (error?.code === 'owner-handoff-capacity' ? 503 : 400), error?.code ?? 'invalid-owner-handoff'); }
    }

    const deviceSession = resolveSession(requestCookie(request));
    if (deviceSession === null && url.pathname === '/owner/in-place' && ['GET', 'HEAD'].includes(request.method)) {
      // The shared Edit control: anyone not signed in as owner returns to the
      // same reader page in visitor mode. Fixed reader origin, so no open redirect.
      const query = queryObject(url, ['relativePath', 'slug']);
      if (query && typeof query.slug === 'string' && query.slug.length > 0 && query.slug.length <= 1024 && !query.slug.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        return response(null, 303, { Location: `${liveUrlForSlug(`${readerOrigin}/cyberbase/`, query.slug)}#edit` });
      }
    }
    if (deviceSession === null) {
      return errorResponse(403, 'invalid-session');
    }
    const { csrfToken, principal } = deviceSession;
    if (request.method === 'POST' && request.headers.get('origin') !== expectedOrigin) {
      return errorResponse(403, 'invalid-origin');
    }
    // Every signed-in owner POST starts or records an owner act. While an
    // earlier job is still being resumed, none may run beside it.
    if (request.method === 'POST') {
      const recovery = recovering();
      if (recovery) return recoveryRefusal(recovery);
    }

    if (url.pathname === '/') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      return response(null, 302, { Location: config.ownerPublication.enabled ? '/owner/publication' : `${readerOrigin}/cyberbase/` });
    }

    const asset = {
      '/owner/assets/editor.js': 'editor.js',
      '/owner/assets/direct.js': 'direct.js',
      '/owner/assets/job.js': 'job.js',
      '/owner/assets/review.js': 'review.js',
      '/owner/assets/apply.js': 'apply.js',
      '/owner/assets/publication.js': 'publication.js',
      '/owner/assets/devices.js': 'devices.js',
      '/owner/assets/github.js': 'github.js',
      '/owner/assets/owner.css': 'owner.css',
      '/owner/assets/review.css': 'review.css',
    }[url.pathname];
    if (asset) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      return staticResponse(publicRoot, asset, request, { directoryIndex: false });
    }

    const forgeResponse = await handleForgeSetup({ request, url, csrfToken, setup: forgeSetup,
      tools: { html, json, errorResponse, response, pageShell, readBoundedJson, sameSecret } });
    if (forgeResponse !== null) return forgeResponse;

    const devicesResponse = await handleDeviceRoutes({ request, url, csrfToken, devices });
    if (devicesResponse !== null) return devicesResponse;

    if (url.pathname === '/owner/publication' || url.pathname.startsWith('/owner/publication/')
      || url.pathname.startsWith('/api/publication/')) {
      const denied = commandGate(commands, 'publication', principal);
      if (denied) return denied;
      if (url.pathname === '/owner/publication') {
        if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
        if (url.search) return errorResponse(400, 'invalid-publication-query');
        return html(request.method === 'HEAD' ? null : publicationLanding(config, csrfToken, readerOrigin));
      }
      const current = /^\/owner\/publication\/current\/([0-9a-f]{64})$/u.exec(url.pathname);
      if (current) {
        if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
        if (url.search) return errorResponse(400, 'invalid-publication-query');
        try {
          const view = await commands.readPublicationCurrent({ viewId: current[1] }, principal);
          return html(request.method === 'HEAD' ? null : publicationCurrentPage(view));
        } catch { return errorResponse(409, 'publication-review-unavailable'); }
      }
      const review = /^\/owner\/publication\/([0-9a-f]{64})$/u.exec(url.pathname);
      if (review) {
        if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
        const query = optionalQueryObject(url, ['mode']);
        if (!query || (query.mode !== undefined && !REVIEW_MODE_KEYS.includes(query.mode))) return errorResponse(400, 'invalid-publication-query');
        try {
          const { draft, job, publishAvailable } = await commands.readPublicationReview({ draftId: review[1] }, principal);
          return html(request.method === 'HEAD' ? null : publicationReviewPage(draft, job, query.mode ?? 'changes', csrfToken, publishAvailable));
        } catch { return errorResponse(409, 'publication-review-unavailable'); }
      }
      const action = url.pathname === '/api/publication/prepare' ? 'prepare'
        : url.pathname === '/api/publication/publish' ? 'publish' : null;
      if (action === null) return errorResponse(404, 'not-found');
      if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
      if (action === 'publish') {
        const publishDenied = commandGate(commands, 'publish', principal);
        if (publishDenied) return publishDenied;
      }
      if (url.search) return errorResponse(400, 'invalid-publication-query');
      let body;
      try { body = await readBoundedJson(request, Math.min(maximumBodyBytes, 4096)); }
      catch (error) { return errorResponse(error.status ?? 400, error.code ?? 'invalid-json'); }
      const key = action === 'prepare' ? 'mappingId' : 'draftId';
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== `${key},csrf`.split(',').sort().join(',')
        || typeof body[key] !== 'string'
        || (key === 'draftId' ? !/^[0-9a-f]{64}$/u.test(body[key]) : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(body[key]))) {
        return errorResponse(400, 'invalid-publication-body');
      }
      if (!sameSecret(body.csrf, csrfToken)) return errorResponse(403, 'invalid-csrf');
      try {
        if (action === 'prepare') {
          const result = await commands.preparePublication({ mappingId: body.mappingId }, principal);
          if (result.outcome === 'unchanged') {
            return json({ outcome: 'unchanged', reviewUrl: `/owner/publication/current/${result.viewId}` }, 201);
          }
          return json({ draftId: result.summary.draftId, jobId: result.summary.jobId,
            capturedVersion: result.summary.capturedVersion, candidateDigest: result.summary.candidateDigest,
            reviewUrl: `/owner/publication/${result.summary.draftId}` }, 201);
        }
        const result = await commands.publish({ draftId: body.draftId }, principal);
        return json({ draftId: result.draftId, jobId: result.jobId, state: result.state,
          capturedVersion: result.capturedVersion, replayed: result.replayed,
          statusUrl: `/owner/jobs/${result.jobId}` }, 202);
      } catch {
        // Do not project arbitrary dependency codes/messages or private references.
        return errorResponse(409, action === 'prepare' ? 'publication-prepare-failed' : 'publication-publish-refused');
      }
    }

    // Route C for new pages and images (core/bundle-desk.js).
    const bundleMatch = /^\/owner\/bundles(?:\/(bundle-[0-9a-f-]{36})(?:\/(page|image|approve|decline)(?:\/(\d))?)?)?$/u.exec(url.pathname);
    if (bundleMatch && devices?.bundleDesk) {
      const denied = commandGate(commands, 'review', principal);
      if (denied) return denied;
      const desk = devices.bundleDesk;
      const [, bundleId, part, index] = bundleMatch;
      try {
        if (bundleId === undefined) {
          if (request.method !== 'GET') return response(null, 405, { Allow: 'GET' });
          return html(bundleListPage({ records: await desk.list() }));
        }
        if (part === 'approve' || part === 'decline') {
          if (request.method !== 'POST' || index !== undefined) return response(null, 405, { Allow: 'POST' });
          const body = await readBoundedJson(request, 4096, (text) => Object.fromEntries(new URLSearchParams(text)), 'application/x-www-form-urlencoded');
          if (!sameSecret(body.csrf ?? '', csrfToken)) return errorResponse(403, 'invalid-csrf');
          await commands[part === 'approve' ? 'approveBundle' : 'declineBundle']({ bundleId }, principal);
          return response(null, 303, { Location: `/owner/bundles/${bundleId}` });
        }
        if (request.method !== 'GET') return response(null, 405, { Allow: 'GET' });
        const record = await desk.load(bundleId);
        if (part === undefined) return html(bundleShellPage({ record, csrfToken, colorScheme: appearance.colorScheme }), 200, { 'Content-Security-Policy': REVIEW_SHELL_CSP });
        if (index === undefined) return errorResponse(404, 'bundle-not-found');
        const bundle = parsePageBundle(record.bundleText);
        if (part === 'image') {
          const image = record.images[Number(index)];
          if (!image) return errorResponse(404, 'bundle-not-found');
          const { bytes } = await desk.readImage(bundleId, image.path);
          const type = sniffedImageType(bytes);
          if (type === null || type !== image.mediaType) return errorResponse(415, 'asset-type-refused');
          return response(bytes, 200, { ...BUNDLE_IMAGE_HEADERS, 'Content-Type': type });
        }
        const addition = record.publicAdditions[Number(index)];
        const note = addition && bundle.files.find((file) => file.path === addition.path && file.kind === 'create');
        if (!note) return errorResponse(404, 'bundle-not-found');
        if (previewBundle !== null) {
          const site = await previewBundle({ bundleId, index: Number(index), bundle, record, colorScheme: appearance.colorScheme,
            readImage: (imagePath) => desk.readImage(bundleId, imagePath) });
          if (typeof site === 'string') return frameResponse(site, 200, SITE_FRAME_CSP);
        }
        const images = new Map();
        for (const image of record.images) images.set(image.path, await desk.readImage(bundleId, image.path));
        return frameResponse(bundleFramePage({ path: note.path, text: note.text, address: addition.address, images }), 200, BUNDLE_FRAME_CSP);
      } catch (error) {
        if (error?.status) return errorResponse(error.status, 'invalid-request-body');
        return errorResponse(error?.code === 'bundle-not-found' ? 404 : 409, error instanceof OwnerAlphaError ? error.code : 'bundle-failed');
      }
    }

    if (url.pathname === '/owner/review' || url.pathname === '/api/review') {
      const denied = commandGate(commands, 'review', principal);
      if (denied) return denied;
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      const query = optionalQueryObject(url, ['cursor']);
      if (query === null
        || (query.cursor !== undefined
          && (query.cursor.length === 0
            || Buffer.byteLength(query.cursor, 'utf8') > 1024
            || /\p{Cc}/u.test(query.cursor)))) {
        return errorResponse(400, 'invalid-review-query');
      }
      let review;
      try {
        review = await commands.listProposals({ cursor: query.cursor ?? null }, principal);
      } catch (error) {
        return errorResponse(reviewErrorStatus(error), error instanceof OwnerAlphaError ? error.code : 'review-list-failed');
      }
      if (url.pathname === '/api/review') {
        if (request.method === 'HEAD') return json(null);
        return json({
          actionable: review.actionable.map((entry) => ({
            summary: entry.summary,
            sourceVerification: entry.sourceVerification,
          })),
          history: review.history.map((entry) => ({ summary: entry.summary, application: entry.application ?? null })),
          historyTruncated: review.historyTruncated,
          nextCursor: review.nextCursor,
        });
      }
      if (request.method === 'HEAD') return html(null);
      return html(reviewListPage({ overlay: review, nextCursor: review.nextCursor, upstream }));
    }

    const reviewDecisionMatch = url.pathname.match(/^\/api\/review\/([^/]+)\/decision$/u);
    if (reviewDecisionMatch) {
      const denied = commandGate(commands, 'review', principal);
      if (denied) return denied;
      if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      const queueId = reviewQueueId(reviewDecisionMatch[1]);
      if (queueId === null) return errorResponse(400, 'invalid-queue-id');
      let body;
      try {
        body = await readBoundedJson(request, MAX_REVIEW_DECISION_BODY_BYTES);
      } catch (error) {
        return errorResponse(error?.status ?? 400, 'invalid-request-body');
      }
      const intent = validateDecisionBody(body, queueId);
      if (intent === null) return errorResponse(400, 'invalid-decision-request');
      if (!sameSecret(intent.csrf, csrfToken)) return errorResponse(403, 'invalid-csrf');
      if (intent.action === 'approve' && intent.acknowledgedInvisible !== true) {
        // Changes the page can't show must be seen before Approve. Recording
        // still reloads and checks the evidence exactly as before.
        let pending;
        try {
          pending = await commands.readProposal({ queueId }, principal);
        } catch (error) {
          return errorResponse(reviewErrorStatus(error), error instanceof OwnerAlphaError ? error.code : 'decision-record-failed');
        }
        if (pending.decision === null && pending.entry && requiresAcknowledgement(pending.entry)) {
          return errorResponse(409, 'unseen-changes-not-acknowledged');
        }
      }
      try {
        const recorded = await commands.recordDecision({
          queueId,
          reviewEvidenceDigest: intent.reviewEvidenceDigest,
          action: intent.action,
          reason: intent.reason,
        }, principal);
        return json({
          queueId,
          action: recorded.action,
          decidedAt: recorded.decidedAt,
          replayed: recorded.replayed,
          summary: recorded.summary,
          statusUrl: `/owner/decisions/${encodeURIComponent(queueId)}`,
          jsonUrl: `/api/decisions/${encodeURIComponent(queueId)}`,
        }, recorded.replayed ? 200 : 201);
      } catch (error) {
        return errorResponse(reviewErrorStatus(error), error instanceof OwnerAlphaError ? error.code : 'decision-record-failed');
      }
    }

    const reviewApplyMatch = url.pathname.match(/^\/api\/review\/([^/]+)\/apply$/u);
    if (reviewApplyMatch) {
      const denied = commandGate(commands, 'review', principal);
      if (denied) return denied;
      if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      const queueId = reviewQueueId(reviewApplyMatch[1]);
      if (queueId === null) return errorResponse(400, 'invalid-queue-id');
      const applyDenied = commandGate(commands, 'apply', principal);
      if (applyDenied) return applyDenied;
      let body;
      try {
        body = await readBoundedJson(request, MAX_REVIEW_DECISION_BODY_BYTES);
      } catch (error) {
        return errorResponse(error?.status ?? 400, 'invalid-request-body');
      }
      const intent = validateApplyBody(body, queueId);
      if (intent === null) return errorResponse(400, 'invalid-apply-request');
      if (!sameSecret(intent.csrf, csrfToken)) return errorResponse(403, 'invalid-csrf');
      try {
        const result = await commands.applyProposal({ queueId }, principal);
        if (!result.applied) {
          return json({
            error: { code: `application-${result.status.state}`, reason: result.status.reason },
            status: result.status,
            statusUrl: `/owner/decisions/${encodeURIComponent(queueId)}`,
          }, result.status.state === 'applied' ? 409 : 422);
        }
        return json({
          queueId,
          attempt: result.event.attempt,
          jobId: result.job.jobId,
          state: result.job.state,
          statusUrl: `/owner/jobs/${encodeURIComponent(result.job.jobId)}`,
          jsonUrl: `/api/jobs/${encodeURIComponent(result.job.jobId)}`,
        }, 202);
      } catch (error) {
        return errorResponse(reviewErrorStatus(error), error instanceof OwnerAlphaError ? error.code : 'application-failed');
      }
    }

    const reviewFrameMatch = url.pathname.match(/^\/owner\/(review|decisions)\/([^/]+)\/page$/u);
    if (reviewFrameMatch) {
      const denied = commandGate(commands, 'review', principal);
      if (denied) return denied;
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      const queueId = reviewQueueId(reviewFrameMatch[2]);
      if (queueId === null) return errorResponse(400, 'invalid-queue-id');
      const unavailable = (status) => frameResponse(request.method === 'HEAD' ? null
        : '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not available</title><p>This page isn’t available.</p></html>\n', status);
      try {
        if (reviewFrameMatch[1] === 'review') {
          const loaded = await commands.readProposal({ queueId }, principal);
          if (loaded.decision !== null || !loaded.entry) return unavailable(409);
          const site = await siteReview(loaded.entry);
          if (site.html !== null) return frameResponse(request.method === 'HEAD' ? null : site.html, 200, SITE_FRAME_CSP);
          return frameResponse(request.method === 'HEAD' ? null : reviewFramePage(loaded.entry, appearance));
        }
        const history = await commands.readDecision({ queueId }, principal);
        // While the queue still holds the page text and the private build
        // matches, the decided proposal stays on the site's own page, read-only.
        if (history.document) {
          const site = await siteReview(decidedEntry(history));
          if (site.html !== null) return frameResponse(request.method === 'HEAD' ? null : site.html, 200, SITE_FRAME_CSP);
        }
        return frameResponse(request.method === 'HEAD' ? null : decisionFramePage(history, appearance));
      } catch (error) {
        return unavailable(error instanceof OwnerCommandPrecondition && error.code === 'decision-not-found' ? 404 : reviewErrorStatus(error));
      }
    }

    const reviewDetailMatch = url.pathname.match(/^\/(owner\/review|api\/review)\/([^/]+)$/u);
    if (reviewDetailMatch) {
      const denied = commandGate(commands, 'review', principal);
      if (denied) return denied;
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      let reviewMode = REVIEW_MODE_KEYS[0];
      if (url.search !== '') {
        const query = queryObject(url, ['mode']);
        if (!query || !REVIEW_MODE_KEYS.includes(query.mode) || reviewDetailMatch[1] !== 'owner/review') {
          return errorResponse(400, 'unexpected-query');
        }
        reviewMode = query.mode;
      }
      const queueId = reviewQueueId(reviewDetailMatch[2]);
      if (queueId === null) return errorResponse(400, 'invalid-queue-id');
      let loaded;
      try {
        loaded = await commands.readProposal({ queueId }, principal);
      } catch (error) {
        const code = error instanceof OwnerAlphaError ? error.code : 'review-load-failed';
        const status = reviewErrorStatus(error);
        if (reviewDetailMatch[1] === 'owner/review' && ['review-expired', 'review-revision-unreachable'].includes(code)) {
          const expired = code === 'review-expired';
          const title = expired ? 'This proposal expired' : 'This proposal’s base is no longer available';
          const message = expired
            ? 'It can no longer be approved or rejected. If the change is still wanted, the sender can propose it again.'
            : 'The version it was written against is no longer on your branch, so it can’t be reviewed as it is. A new proposal must use the current page.';
          return html(request.method === 'HEAD' ? null : reviewPage({ title, appearance,
            body: noticeShell({ siteTitle: appearance.siteTitle, heading: title, message }) }), status, { 'Content-Security-Policy': REVIEW_SHELL_CSP });
        }
        return errorResponse(status, code);
      }
      if (loaded.decision !== null) {
        if (reviewDetailMatch[1] === 'owner/review') {
          return response(null, 303, { Location: `/owner/decisions/${encodeURIComponent(queueId)}` });
        }
        return json({
          error: { code: 'decision-already-recorded' },
          statusUrl: `/owner/decisions/${encodeURIComponent(queueId)}`,
        }, 409);
      }
      if (reviewDetailMatch[1] === 'api/review') {
        if (request.method === 'HEAD') return json(null);
        const { document: _reviewDocument, ...apiEntry } = loaded.entry;
        return json(apiEntry);
      }
      if (request.method === 'HEAD') return html(null);
      // Choosing a comparison mode reopens Details where the owner left it.
      const site = await siteReview(loaded.entry);
      return html(reviewDetailPage({ entry: loaded.entry, csrfToken, mode: reviewMode, appearance, detailsOpen: url.search !== '', siteReason: site.reason }), 200,
        { 'Content-Security-Policy': REVIEW_SHELL_CSP });
    }

    const decisionDetailMatch = url.pathname.match(/^\/(owner\/decisions|api\/decisions)\/([^/]+)$/u);
    if (decisionDetailMatch) {
      const denied = commandGate(commands, 'review', principal);
      if (denied) return denied;
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      const queueId = reviewQueueId(decisionDetailMatch[2]);
      if (queueId === null) return errorResponse(400, 'invalid-queue-id');
      let history;
      try {
        history = await commands.readDecision({ queueId }, principal);
      } catch (error) {
        if (error instanceof OwnerCommandPrecondition && error.code === 'decision-not-found') return errorResponse(404, error.code);
        return errorResponse(reviewErrorStatus(error), error instanceof OwnerAlphaError ? error.code : 'decision-load-failed');
      }
      if (decisionDetailMatch[1] === 'api/decisions') {
        if (request.method === 'HEAD') return json(null);
        const { document: _decidedDocument, ...apiHistory } = history;
        return json(apiHistory);
      }
      if (request.method === 'HEAD') return html(null);
      let firstAnchor = proposalView(decisionEntry(history.decision, history.summary)).operations.length > 0 ? 1 : null;
      if (history.document) {
        const entry = decidedEntry(history);
        if ((await siteReview(entry)).html !== null) firstAnchor = reviewDisplay(entry).model.anchors[0] ?? null;
      }
      return html(decisionDetailPage({ ...history, csrfToken, appearance, firstAnchor }), 200, { 'Content-Security-Policy': REVIEW_SHELL_CSP });
    }

    if (url.pathname === '/owner/in-place') {
      if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
      const query = queryObject(url, ['relativePath', 'slug']);
      if (!query) return errorResponse(400, 'invalid-edit-query');
      try {
        const session = await commands.readPageSource(query, principal);
        const target = liveUrlForSlug(`${readerOrigin}/cyberbase/`, session.slug);
        return response(null, 303, { Location: `${target}#owner-edit` });
      } catch (error) { return errorResponse(400, error?.code ?? 'edit-session-failed'); }
    }

    const staged = /^\/owner\/staged\/([A-Za-z0-9_-]{43})$/u.exec(url.pathname);
    if (staged) {
      if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search) return errorResponse(400, 'unexpected-query');
      try {
        const { session, operation, editId, operationCount } = await commands.inspectOwnerDirect({ stageId: staged[1] }, principal);
        const back = `${liveUrlForSlug(`${readerOrigin}/cyberbase/`, session.slug)}#owner-edit`;
        const cards = operation.proposal.changeSet.files[0].operations.map((op, index) => {
          const base = Buffer.from(session.source.bytesBase64, 'base64');
          // Escaped text only. No source HTML or reader scripts enter this origin.
          // Show the change within its own line only, trimmed at word boundaries.
          const lineBefore = base.subarray(0, op.start).toString('utf8').split('\n').at(-1);
          const lineAfter = base.subarray(op.end).toString('utf8').split('\n')[0];
          const before = lineBefore.length > 80 ? `…${lineBefore.slice(-80).replace(/^\S*\s/u, '')}` : lineBefore;
          const after = lineAfter.length > 80 ? `${lineAfter.slice(0, 80).replace(/\s\S*$/u, '')}…` : lineAfter;
          return `<section class="direct-change"><p>${escapeHtml(before)}<del>${escapeHtml(op.expected)}</del><ins>${escapeHtml(op.replacement)}</ins>${escapeHtml(after)}</p></section>`;
        }).join('');
        return html(request.method === 'HEAD' ? null : pageShell({ title: 'Save your changes', script: '/owner/assets/direct.js', body: `<main class="owner-shell direct-review" id="owner-direct" data-edit-id="${escapeHtml(editId)}" data-csrf="${escapeHtml(csrfToken)}"><header class="owner-header"><p class="eyebrow">Save changes to</p><h1>${escapeHtml(session.relativePath.split('/').at(-1).replace(/\.md$/u, ''))}</h1></header>${cards}<p class="direct-raw"><a href="/owner/edit?relativePath=${encodeURIComponent(session.relativePath)}&amp;slug=${encodeURIComponent(session.slug)}">Edit whole file as Markdown</a></p><form id="direct-form"><div class="owner-finish"><a href="${escapeHtml(back)}" aria-label="Back to editing">Back</a><button type="submit">Save · ${operationCount}</button></div><p id="form-status" role="status"></p></form></main>` }));
      } catch (error) {
        if (error instanceof OwnerCommandPrecondition && error.code === 'owner-handoff-expired') return errorResponse(410, error.code);
        return errorResponse(409, error?.code ?? 'owner-handoff-unavailable');
      }
    }

    if (url.pathname === '/api/owner-direct') {
      if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
      if (url.search) return errorResponse(400, 'unexpected-query');
      let body;
      try { body = await readBoundedJson(request, 4096); }
      catch (error) { return errorResponse(error?.status ?? 400, 'invalid-request-body'); }
      if (!body || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'csrf,editId' || !exactToken(body.editId)) return errorResponse(400, 'invalid-owner-save');
      if (!sameSecret(body.csrf, csrfToken)) return errorResponse(403, 'invalid-csrf');
      try {
        const { jobId } = await commands.saveOwnerDirect({ editId: body.editId }, principal);
        return json({ jobId, state: 'accepted', statusUrl: `/owner/jobs/${encodeURIComponent(jobId)}` }, 202);
      } catch (error) {
        if (error instanceof OwnerCommandPrecondition && error.code === 'owner-handoff-expired') return errorResponse(410, error.code);
        return errorResponse(409, error?.code ?? 'owner-save-failed');
      }
    }

    if (url.pathname === '/owner/edit') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      const query = queryObject(url, ['relativePath', 'slug']);
      if (!query) return errorResponse(400, 'invalid-edit-query');
      try {
        const { session, editSessionId } = await commands.openRawEdit({ relativePath: query.relativePath, slug: query.slug }, principal);
        const body = editPage({
          editSessionId,
          csrfToken,
          session,
          reviewEnabled: config.proposalReview.enabled,
          publicationEnabled: config.ownerPublication.enabled,
        });
        if (request.method === 'HEAD') return html(null, 200);
        return html(body);
      } catch (error) {
        if (error instanceof OwnerCommandPrecondition && error.code === 'invalid-edit-session') return errorResponse(500, error.code);
        const code = error instanceof OwnerAlphaError ? error.code : 'edit-session-failed';
        return errorResponse(code === 'edit-session-capacity' ? 503 : 400, code);
      }
    }

    if (url.pathname === '/api/edits') {
      if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
      let body;
      try {
        body = await readBoundedJson(request, maximumBodyBytes);
      } catch (error) {
        return errorResponse(error?.status ?? 400, 'invalid-request-body');
      }
      const save = validateSaveBody(body, config.limits.maxSourceBytes);
      if (!save) return errorResponse(400, 'invalid-save-request');
      if (!sameSecret(save.csrf, csrfToken)) return errorResponse(403, 'invalid-csrf');
      let accepted;
      try {
        accepted = await commands.saveRawEdit({ editSessionId: save.editSessionId, editedText: save.editedText }, principal);
      } catch (error) {
        if (error instanceof OwnerCommandPrecondition) {
          if (error.code === 'edit-session-expired') return errorResponse(410, error.code);
          if (error.code === 'save-in-progress') return errorResponse(409, error.code);
          if (error.code === 'save-failed') return errorResponse(500, error.code);
        }
        if (error instanceof OwnerAlphaError) {
          return errorResponse(error.code === 'lock-busy' ? 409 : 400, error.code);
        }
        return errorResponse(500, 'save-failed');
      }
      const { jobId, state } = accepted;
      return json({
        jobId,
        state,
        statusUrl: `/owner/jobs/${encodeURIComponent(jobId)}`,
        jsonUrl: `/api/jobs/${encodeURIComponent(jobId)}`,
      }, 202);
    }

    const jobMatch = url.pathname.match(/^\/(owner\/jobs|api\/jobs)\/([^/]+)$/u);
    if (jobMatch) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      let jobId;
      try {
        jobId = validateJobId(decodeURIComponent(jobMatch[2]));
      } catch {
        return errorResponse(400, 'invalid-job-id');
      }
      let job;
      try {
        job = await commands.readJob({ jobId }, principal);
      } catch (error) {
        if (error instanceof OwnerAlphaError && error.code === 'job-not-found') {
          return errorResponse(404, 'job-not-found');
        }
        return errorResponse(500, 'job-lookup-failed');
      }
      if (jobMatch[1] === 'api/jobs') {
        if (request.method === 'HEAD') return json(null, 200);
        return json(publicJob(job));
      }
      if (request.method === 'HEAD') return html(null);
      return html(jobPage(job, readerOrigin, appearance));
    }

    return errorResponse(404, 'not-found');
  };
  Object.defineProperties(handler, {
    bootstrapToken: { value: initialBootstrapToken, enumerable: false },
    issueBootstrap: { value: issueBootstrap, enumerable: false },
    ownerOrigin: { value: expectedOrigin, enumerable: false },
    readerOrigin: { value: readerOrigin, enumerable: false },
  });
  return handler;
}

export function startOwnerAlphaServer({ config: configInput, fetch, serve = Bun.serve } = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (typeof fetch !== 'function' || typeof serve !== 'function') throw new TypeError('fetch and serve are required');
  // Bind exactly the validated private address; if the host does not own it,
  // startup must fail rather than fall back to a wildcard bind.
  return serve({
    hostname: config.listen.host,
    port: config.listen.port,
    fetch,
  });
}

export function startReaderServer({ config: configInput, fetch, serve = Bun.serve } = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (typeof fetch !== 'function' || typeof serve !== 'function') throw new TypeError('fetch and serve are required');
  return serve({
    hostname: config.listen.host,
    port: config.listen.readerPort,
    fetch,
  });
}

export function startOwnerAlphaServers({
  config: configInput,
  ownerFetch,
  readerFetch,
  serve = Bun.serve,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const owner = startOwnerAlphaServer({ config, fetch: ownerFetch, serve });
  let reader;
  try {
    reader = startReaderServer({ config, fetch: readerFetch, serve });
  } catch (error) {
    owner.stop?.();
    throw error;
  }
  return Object.freeze({
    owner,
    reader,
    ownerOrigin: `http://${config.listen.host}:${config.listen.port}`,
    readerOrigin: `http://${config.listen.host}:${config.listen.readerPort}`,
    bootstrapToken: ownerFetch.bootstrapToken,
    issueBootstrap: ownerFetch.issueBootstrap,
    stop(closeActiveConnections) {
      reader.stop?.(closeActiveConnections);
      owner.stop?.(closeActiveConnections);
    },
  });
}

async function loadPipelineAdapter(options) {
  const pipeline = await import('./pipeline.js');
  if (typeof pipeline.createSaveHandler !== 'function') {
    throw new TypeError('pipeline.js must export createSaveHandler(options)');
  }
  const created = await pipeline.createSaveHandler(options);
  if (typeof created === 'function') {
    return {
      saveEdit: created,
      startEdit: typeof created.startEdit === 'function' ? created.startEdit : null,
      resumeJob: typeof created.resumeJob === 'function' ? created.resumeJob : null,
      getJob: typeof created.getJob === 'function' ? created.getJob : null,
    };
  }
  if (!created || typeof created.saveEdit !== 'function') {
    throw new TypeError('createSaveHandler(options) must return saveEdit({ session, editedText })');
  }
  return {
    saveEdit: created.saveEdit,
    startEdit: typeof created.startEdit === 'function' ? created.startEdit : null,
    resumeJob: typeof created.resumeJob === 'function' ? created.resumeJob : null,
    getJob: typeof created.getJob === 'function' ? created.getJob : null,
  };
}

export async function recoverOwnerAlphaJobs({
  config: configInput,
  context,
  pipeline,
  listJobs = listDurableJobs,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (!context || typeof listJobs !== 'function') {
    throw new TypeError('recovery requires a store context and job enumerator');
  }
  const jobs = await listJobs(context, { maxBytes: config.limits.maxArtifactBytes });
  const resumable = jobs.filter((job) => job.recovery?.automatic === true);
  if (resumable.length > 0 && typeof pipeline?.resumeJob !== 'function') {
    throw new OwnerAlphaError('automatic-recovery-unavailable', 'durable jobs require automatic recovery but the pipeline has no resume adapter');
  }
  const results = [];
  for (const job of resumable) {
    results.push(await pipeline.resumeJob({ jobId: job.jobId }));
  }
  return Object.freeze(results);
}

export async function runOwnerAlphaServer({
  configFile = new URL('../owner-alpha.local.json', import.meta.url),
  projectRoot = PROJECT_ROOT,
  serve = Bun.serve,
  rebuildSite = ensureOwnerSite,
  loadPipeline = loadPipelineAdapter,
  createHandler = createOwnerAlphaHandler,
  createReader = createReaderHandler,
  startServers = startOwnerAlphaServers,
  listJobs = listDurableJobs,
  recoverJobs = recoverOwnerAlphaJobs,
  createReviewClient = createProposalReviewClient,
  createReviewSource = createOwnerProposalReviewSource,
  createReviewService = createOwnerProposalReviewService,
  recoverDecisions = recoverProposalDecisions,
  recordDecision = recordProposalDecision,
  startSuggestions = startSuggestionIntake,
  readAuthoringNote,
  createPublication = createOwnerPublicationRuntime,
  adoptSession = null,
  createUpstreamStatus = createUpstream,
  // The publisher's signing verbs ({ challenge, enroll }) relayed to paired
  // signing devices. Null until the publisher offers them: devices then get
  // a plain "signing-unavailable".
  publisherSigning = null,
  // The starter publish.yml commit first-run setup prepared, handed over in
  // the same process; kept on disk until the owner's device approves it.
  pendingStarter = null,
} = {}) {
  if (typeof rebuildSite !== 'function'
    || typeof loadPipeline !== 'function'
    || typeof createHandler !== 'function'
    || typeof createReader !== 'function'
    || typeof startServers !== 'function'
    || typeof listJobs !== 'function'
    || typeof recoverJobs !== 'function'
    || typeof createReviewClient !== 'function'
    || typeof createReviewSource !== 'function'
    || typeof createReviewService !== 'function'
    || typeof recoverDecisions !== 'function'
    || typeof recordDecision !== 'function'
    || typeof startSuggestions !== 'function') {
    throw new TypeError('site, pipeline, handlers, servers, review, recovery, and suggestion dependencies are required');
  }
  const config = await loadOwnerAlphaConfig(configFile);
  const loaded = await loadDeviceKeyRegistry(config, { withInput: true });
  let registry = loaded.registry;
  let devices = null;
  if (config.iroh?.enabled) {
    // Paired devices live in an owner-only directory outside the vault and
    // change at runtime; both carriers verify against the same live registry.
    try {
      await assertOutsideVault(config, config.iroh.stateDirectory);
      const store = await openDeviceStore({ directory: path.join(config.iroh.stateDirectory, 'devices'),
        ownerId: config.owner.identity, staticInput: loaded.input, parentDirectory: config.iroh.stateDirectory });
      registry = store.registry;
      devices = { store, pairing: createPairingManager({ ownerId: config.owner.identity, store }) };
    } catch {
      fail('iroh-state-invalid', 'Iroh state must be an owner-only directory outside the vault holding valid device records.');
    }
  }
  const storeContext = storeContextFromConfig(config, projectRoot);
  await prepareStore(storeContext);
  // With a publisher mirror: ask the publisher for GitHub's latest and bring a
  // clean checkout up to it. Unreachable GitHub is a state, not a failure.
  const upstream = config.publisher?.mirror ? createUpstreamStatus({ config }) : null;
  await upstream?.refresh();
  // Later checks only ask the publisher, so the quiet notice clears when GitHub is back.
  const upstreamTimer = upstream === null ? null : setInterval(() => { upstream.refresh({ sync: false }).catch(() => {}); }, 5 * 60_000);
  upstreamTimer?.unref?.();
  // The site build retains the publication binding the form needs, so the
  // intake starts after it and before anything reads the review socket.
  // A vault that publishes nothing yet (no publish.yml, or setup's starter
  // still waiting for the owner's phone) has no preview to build. The node
  // starts anyway: sign-in, devices and the phone's approvals need it. The
  // preview is built once the starter lands, or by the next job.
  try {
    await rebuildSite({ config, projectRoot });
  } catch (error) {
    if (!(error instanceof OwnerAlphaError) || error.code !== 'site-publication-empty') throw error;
    console.error('Owner alpha: nothing is published yet, so the private preview waits until publish.yml lists notes.');
  }
  const suggestions = await startSuggestions({ config, projectRoot });
  let pipeline;
  try {
    // Install even when currently disabled: recovered publication jobs must not
    // silently become ordinary edits if a reader or config is no longer present.
    const publicationGuard = createPublicationSourceGuard({ config, context: storeContext, readNote: readAuthoringNote });
    pipeline = await loadPipeline({ config, projectRoot, context: storeContext,
      dependencies: { revalidateSource: publicationGuard } });
  } catch (error) {
    await suggestions?.close().catch(() => {});
    throw error;
  }
  // Startup recovery runs in the background so the owner can sign in at once.
  // Until it settles, every entry that starts an owner act (Save, Apply,
  // Publish, decisions; from the browser, a paired device or the signed
  // socket) is refused with one plain message. Recovery itself uses
  // pipeline.resumeJob and recoverDecisions, which are not gated. A failed
  // recovery keeps the gate closed: earlier the whole app stopped instead.
  const recoveryGate = createRecoveryGate();
  const { recovering } = recoveryGate;
  const gate = recoveryGate.wrapAsync;
  const recoveringPipeline = pipeline;
  pipeline = Object.freeze({ ...recoveringPipeline, saveEdit: gate(recoveringPipeline.saveEdit?.bind(recoveringPipeline)),
    ...(typeof recoveringPipeline.startEdit === 'function' ? { startEdit: recoveryGate.wrapSync(recoveringPipeline.startEdit.bind(recoveringPipeline)) } : {}) });
  const lookupJob = pipeline.getJob ?? ((jobId) => loadDurableJob(storeContext, jobId, {
    maxBytes: config.limits.maxArtifactBytes,
  }));
  let proposalReview = null;
  if (config.proposalReview.enabled) {
    const client = createReviewClient({
      socketPath: config.proposalReview.socketPath,
      requestTimeoutMs: config.proposalReview.requestTimeoutMs,
    });
    const source = createReviewSource({ config, client });
    proposalReview = createReviewService({
      config,
      context: storeContext,
      source,
      recoverDecisions,
      recordDecision: gate(recordDecision),
      application: {
        saveEdit: pipeline.saveEdit,
        createJobId: () => `OA-${randomUUID()}`,
        siteRoot: path.resolve(projectRoot, config.workspace.site),
        ownerOrigin: `http://${config.listen.host}:${config.listen.port}`,
      },
    });
  }
  // One publication runtime: the owner pages and paired devices see the same
  // drafts, views and publish lock.
  const ownerPublication = config.ownerPublication.enabled
    ? createPublication({ config, context: storeContext, readNote: readAuthoringNote, pipeline }) : null;
  // In memory only: a restart drops waiting approvals, as the publisher's nonces.
  // The publisher's owner-control socket when one is configured; a test or
  // rehearsal may pass its own. Jobs waiting for approval are offered on demand.
  const signingPublisher = publisherSigning ?? (config.publisher
    ? publisherSigningFromSocket({ socketPath: config.publisher.socketPath, ownerRequest }) : null);
  const starterFile = devices === null ? null : pendingStarterFile(config.iroh.stateDirectory);
  if (starterFile !== null && pendingStarter !== null) await starterFile.save(pendingStarter);
  // New notes and images: bundles wait here for review or for the signature.
  const bundleGitRunner = bundleGit(config.repository.checkout);
  const bundleDesk = devices === null ? null : await openBundleDesk({ config, git: bundleGitRunner,
    directory: path.join(config.iroh.stateDirectory, 'bundles'),
    branchHead: async () => (await bundleGitRunner(['rev-parse', '--verify', `refs/heads/${config.repository.branch}^{commit}`])).toString('utf8').trim() });
  if (devices !== null) devices.bundleDesk = bundleDesk;
  const jobApprovals = devices === null ? null : createJobApprovals({ config, context: storeContext, pipeline: recoveringPipeline,
    bundles: bundleDesk,
    publishBundle: config.publisher ? ({ commit, record }) => ownerRequest({ socketPath: config.publisher.socketPath,
      op: 'publish-bundle', commit, record }) : null,
    log: (line) => console.error(`Owner alpha: ${line}`), starter: starterFile,
    afterStarter: () => rebuildSite({ config, projectRoot }),
    publishStarter: config.publisher ? ({ commit, record }) => ownerRequest({ socketPath: config.publisher.socketPath,
      op: 'publish-starter', commit, record }) : null });
  const approvals = devices === null ? null : createApprovalRelay({ publisher: signingPublisher,
    refresh: () => jobApprovals.refresh(approvals) });
  if (devices !== null) {
    // Status for every note the site publishes, and the owner's note links.
    devices.noteStatus = createNoteStatus({ config, context: storeContext });
    devices.links = await openNoteLinks({ directory: config.iroh.stateDirectory, config, noteStatus: devices.noteStatus,
      publication: ownerPublication, readMappingNote: typeof readAuthoringNote === 'function' ? readAuthoringNote : null });
  }
  const ownerFetch = createHandler({
    config,
    projectRoot,
    saveEdit: pipeline.saveEdit,
    lookupJob,
    proposalReview,
    reviewAppearance: config.proposalReview.enabled ? await readReviewAppearance(config) : null,
    reviewSiteRoot: path.resolve(projectRoot, config.workspace.site),
    ownerPublication,
    devices,
    forgeSetup: createForgeSetup({ config, configFile: configFile instanceof URL ? fileURLToPath(configFile) : configFile }),
    ...(adoptSession === null ? {} : { adoptSession }),
    upstream,
    recovering,
  });
  const readerFetch = createReader({ config, projectRoot });
  let runtime;
  let signed;
  let iroh;
  try {
    runtime = startServers({ config, ownerFetch, readerFetch, serve });
    if (config.signedRequestSocket !== undefined) {
      const socketPath = config.signedRequestSocket;
      const verifier = createDevicePrincipalAdapter({ registry, audience: signedSocketAudience(socketPath) });
      const commands = createOwnerCommands({ config, projectRoot, devicePrincipalAdapter: verifier, proposalReview });
      signed = await startSignedRequestSocket({ socketPath, commands, verifier });
    }
    if (devices !== null) {
      const secretKey = await loadNodeSecret(config.iroh.stateDirectory);
      const endpoint = await bindEndpoint({ secretKey, relay: config.iroh.relay, bindAddress: config.iroh.bindAddress ?? null,
        alpns: [CMD_ALPN, PAIR_ALPN] });
      secretKey.fill(0);
      const nodeId = endpoint.id().toString();
      const verifier = createDevicePrincipalAdapter({ registry, audience: irohAudience(nodeId), requireChannelBinding: true });
      const commands = createOwnerCommands({ config, projectRoot, devicePrincipalAdapter: verifier, proposalReview,
        publication: ownerPublication, noteStatus: devices.noteStatus, noteLinks: devices.links, approvals, bundleDesk });
      iroh = startIrohCarrier({ endpoint, commands, verifier, pairing: devices.pairing, relay: config.iroh.relay });
      devices.store.setRevokeListener((key) => { if (key.irohNodeId) iroh.closePeer(key.irohNodeId); });
      devices.pairing.attachNode({ nodeId, ticket: iroh.ticket });
    }
  } catch (error) {
    await iroh?.close().catch(() => {});
    await signed?.close().catch(() => {});
    runtime?.stop(true);
    await suggestions?.close().catch(() => {});
    throw error;
  }
  const recovery = Promise.resolve().then(async () => {
    await recoverDecisions(storeContext);
    return recoverJobs({
      config,
      context: storeContext,
      pipeline: recoveringPipeline,
      listJobs,
    });
  }).then((results) => { recoveryGate.settle(true); return results; },
    (error) => { recoveryGate.settle(false); throw error; });
  return Object.freeze({
    ...runtime,
    suggestions: suggestions === null
      ? null
      : Object.freeze({ formOrigin: suggestions.formOrigin, forge: suggestions.forge }),
    recovery,
    iroh: iroh === undefined ? null : Object.freeze({ nodeId: iroh.nodeId, ticket: iroh.ticket }),
    // request({ intent, files, askedBy }) for the publish path; null without Iroh.
    approvals,
    upstream,
    stop(closeActiveConnections) {
      if (upstreamTimer !== null) clearInterval(upstreamTimer);
      runtime.stop?.(closeActiveConnections);
      const carriers = [signed, iroh].filter(Boolean);
      return carriers.length === 0
        ? suggestions?.close() ?? Promise.resolve(null)
        : Promise.allSettled(carriers.map((carrier) => carrier.close())).then(() => suggestions?.close() ?? null);
    },
  });
}

export const OWNER_ALPHA_READY_CONTENT = 'owner-alpha-ready-v1\n';

export async function writeOwnerAlphaReadyMarker(file) {
  if (typeof file !== 'string'
    || !path.isAbsolute(file)
    || path.normalize(file) !== file
    || file === path.parse(file).root) {
    throw new TypeError('ready marker must be one normalized absolute file path');
  }
  const parent = path.dirname(file);
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink()
    || !parentMetadata.isDirectory()
    || await realpath(parent) !== parent
    || (typeof process.getuid === 'function' && parentMetadata.uid !== process.getuid())
    || (typeof process.getgid === 'function' && parentMetadata.gid !== process.getgid())
    || (parentMetadata.mode & 0o777) !== 0o700) {
    throw new OwnerAlphaError('ready-directory-invalid', 'ready marker parent must be a private runtime-owned real directory');
  }
  const temporary = path.join(parent, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(OWNER_ALPHA_READY_CONTENT, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const metadata = await stat(file);
    if (!metadata.isFile()
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (typeof process.getgid === 'function' && metadata.gid !== process.getgid())) {
      throw new OwnerAlphaError('ready-marker-invalid', 'ready marker did not retain private runtime ownership');
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function removeOwnerAlphaReadyMarker(file) {
  if (typeof file === 'string' && file.length > 0) await rm(file, { force: true });
}

if (import.meta.main) {
  const { startBootstrapConsole, formatBootstrapUrl } = await import('./bootstrap-console.js');
  const configFile = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const readyFile = process.env.OWNER_ALPHA_READY_FILE;
  let runtime;
  let disposeConsole;
  let stopping = false;

  const stop = async (exitCode) => {
    if (stopping) return;
    stopping = true;
    disposeConsole?.();
    await runtime?.stop(true);
    try {
      await removeOwnerAlphaReadyMarker(readyFile);
    } finally {
      process.exitCode = exitCode;
    }
  };

  const stopForSignal = async () => {
    await stop(0);
    process.exit(0);
  };
  process.once('SIGTERM', () => { void stopForSignal(); });
  process.once('SIGINT', () => { void stopForSignal(); });

  try {
    runtime = await runOwnerAlphaServer({ configFile });
    if (runtime.upstream?.current().state === 'unreachable') console.log('GitHub: cannot reach it now; serving your notes as last copied.');
    // The sign-in link is printed before job recovery finishes: a job waiting
    // on a deployment check can take 15 minutes offline. Owner acts that would
    // conflict are refused by the runtime until recovery settles. The ready
    // marker (the container health check) still waits for recovery.
    console.log(`Owner alpha reader: ${runtime.readerOrigin}/cyberbase/`);
    if (runtime.suggestions === null) {
      console.log('Suggestions: off (turn them on under "suggestions" in the owner config)');
    } else {
      console.log(runtime.suggestions.formOrigin === null
        ? 'Suggestions: form off'
        : `Suggestions: form on for pages served from ${runtime.readerOrigin}/cyberbase/`);
      console.log(runtime.suggestions.forge === null
        ? 'Suggestions: no forge watched'
        : `Suggestions: watching ${runtime.suggestions.forge} for pull requests`);
    }
    console.log(`Owner alpha bootstrap: ${formatBootstrapUrl(runtime.ownerOrigin, runtime.bootstrapToken)}`);
    if (typeof runtime.issueBootstrap === 'function' && process.stdin.readable) {
      console.log("Enter 'b' for a one-time sign-in link for another device.");
      disposeConsole = startBootstrapConsole({
        input: process.stdin,
        output: process.stdout,
        ownerOrigin: runtime.ownerOrigin,
        issueBootstrap: runtime.issueBootstrap,
      });
    }
    runtime.recovery.then(async () => {
      if (readyFile) await writeOwnerAlphaReadyMarker(readyFile);
    }, () => {
      console.error('Owner alpha: an earlier publish could not be finished. Owner actions stay paused; restart to try again.');
    }).catch((error) => {
      console.error(`Owner alpha ready marker failed: ${error instanceof OwnerAlphaError ? error.code : 'unexpected-error'}`);
      void stop(1);
    });
  } catch (error) {
    await stop(1);
    const reason = error instanceof OwnerAlphaError ? error.code : 'unexpected-error';
    const detail = ['device-registry-invalid', 'signed-socket-unsafe', 'signed-socket-requires-review-and-keys',
      'signed-socket-path-conflict'].includes(reason) ? `: ${error.message}` : '';
    console.error(`Owner alpha startup failed: ${reason}${detail}`);
  }
}
