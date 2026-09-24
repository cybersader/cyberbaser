import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER_DECISION_REASON_MAX_BYTES } from '@cyberbaser/proposal-review';
import { validateDigest, validateQueueId } from '@cyberbaser/proposal-queue';
import { loadOwnerAlphaConfig, validateOwnerAlphaConfig } from './config.js';
import {
  createProposalDecisionOverlay,
  recordProposalDecision,
  recoverProposalDecisions,
} from './proposal-decisions.js';
import { createProposalReviewClient } from './proposal-review-client.js';
import { createOwnerProposalReviewSource } from './proposal-review.js';
import { documentProjection, segmentsWithinSpan } from '@cyberbaser/review-projection';
import { fail, OwnerAlphaError } from './errors.js';
import { listDurableJobs, loadDurableJob, validateJobId } from './job-state.js';
import { ensureOwnerSite } from './site.js';
import { createEditSession as createSourceEditSession } from './source.js';
import { prepareStore, storeContextFromConfig } from './store.js';

const COOKIE_NAME = 'owner_alpha_session';
export const MAX_OWNER_SESSIONS = 64;
const DEFAULT_EDIT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_EDIT_SESSIONS = 64;
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

function pageShell({ title, body, script = null, bodyClass = null }) {
  const scriptTag = script ? `<script src="${script}" defer></script>` : '';
  const bodyAttribute = bodyClass === null ? '' : ` class="${escapeHtml(bodyClass)}"`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/owner/assets/owner.css">
${scriptTag}
</head>
<body${bodyAttribute}>
${body}
</body>
</html>
`;
}

function editPage({ editSessionId, csrfToken, session, reviewEnabled }) {
  return pageShell({
    title: 'Owner edit',
    script: '/owner/assets/editor.js',
    body: `<main class="owner-shell" id="owner-editor" data-edit-session-id="${escapeHtml(editSessionId)}" data-csrf="${escapeHtml(csrfToken)}">
<header class="owner-header review-detail-header">
<div><p class="eyebrow">Owner alpha</p>
<h1>Edit Markdown</h1>
<p class="lede">One bounded Save publishes through the configured owner-controlled pipeline.</p></div>
${reviewEnabled ? '<a href="/owner/review">Review proposals</a>' : ''}
</header>
<form id="edit-form">
<label for="edited-text">Markdown</label>
<textarea id="edited-text" name="editedText" spellcheck="false" autocomplete="off">${textareaText(session.source.text)}</textarea>
<div class="actions"><button type="submit" id="save-button">Save and publish</button></div>
<p id="form-status" class="status" role="status" aria-live="polite"></p>
</form>
</main>`,
  });
}

function publicJob(job) {
  const result = {
    jobId: job.jobId,
    state: job.state,
    revision: job.revision,
  };
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
  return result;
}

function jobPage(job, readerOrigin) {
  const safe = publicJob(job);
  return pageShell({
    title: `Owner job ${safe.jobId}`,
    script: '/owner/assets/job.js',
    body: `<main class="owner-shell" id="owner-job" data-job-id="${escapeHtml(safe.jobId)}">
<header class="owner-header">
<p class="eyebrow">Owner alpha</p>
<h1>Save job</h1>
<p class="lede">This page reports the durable pipeline state. It has no mutation controls.</p>
</header>
<section class="job-card" aria-live="polite">
<dl>
<div><dt>Job</dt><dd id="job-id">${escapeHtml(safe.jobId)}</dd></div>
<div><dt>State</dt><dd id="job-state">${escapeHtml(safe.state)}</dd></div>
<div><dt>Updated</dt><dd id="job-updated">${escapeHtml(safe.updatedAt ?? '')}</dd></div>
</dl>
<p id="job-recovery" class="status">${escapeHtml(safe.recovery?.instruction ?? '')}</p>
<p id="job-error" class="error" role="alert"></p>
</section>
<p><a href="${escapeHtml(readerOrigin)}/cyberbase/">Return to Cyberbase</a></p>
</main>`,
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

function reviewTime(value) {
  const instant = new Date(value);
  const visible = Number.isNaN(instant.getTime())
    ? value
    : `${new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(instant)} UTC`;
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(visible)}</time>`;
}

function proposalView(entry) {
  const operation = entry.evidence.proposal.operation;
  return Object.freeze({
    operation,
    oldText: proposalText(operation.expectedOldBytesBase64),
    replacementText: proposalText(operation.replacementBytesBase64),
    prefix: operation.selector?.prefix ?? '',
    suffix: operation.selector?.suffix ?? '',
    hasContext: operation.selector !== null,
  });
}

function changeName(view) {
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

function reviewSummaryCard(entry, href, decision = null) {
  const view = proposalView(entry);
  const rationale = compactReviewText(entry.evidence.proposal.submission.rationale, 180);
  const status = decision === null
    ? (entry.summary.route === 'reject' ? '<span class="attention-note">Policy recommends rejection</span>' : '')
    : `<span class="decision-label decision-${escapeHtml(decision.action)}">${decision.action === 'approve' ? 'Approved' : 'Rejected'}</span>`;
  const timing = decision === null
    ? `<span>Received ${reviewTime(entry.summary.receivedAt)}</span><span>Expires ${reviewTime(entry.summary.expiresAt)}</span>`
    : `<span>${reviewTime(decision.decidedAt)}</span><span>${escapeHtml(compactReviewText(decision.reason, 120))}</span>`;
  return `<article class="proposal-row">
<a class="proposal-row-link" href="${escapeHtml(href)}">
<span class="proposal-row-change">${proposalContext(view, 'proposed', { compact: true })}</span>
<span class="proposal-row-path">${escapeHtml(entry.summary.source.path)}</span>
<span class="proposal-row-rationale">${escapeHtml(rationale)}</span>
<span class="proposal-row-meta">${status}${timing}</span>
</a>
</article>`;
}

function reviewListPage({ overlay, nextCursor }) {
  const actionable = overlay.actionable.length === 0
    ? '<p class="empty-state">No proposals need your decision.</p>'
    : overlay.actionable.map((entry) => reviewSummaryCard(
        entry,
        `/owner/review/${encodeURIComponent(entry.summary.queueId)}`,
      )).join('\n');
  const history = overlay.history.length === 0
    ? '<p class="empty-state">No decisions have been recorded yet.</p>'
    : overlay.history.map(({ decision, summary }) => reviewSummaryCard(
        decisionEntry(decision, summary),
        `/owner/decisions/${encodeURIComponent(summary.queueId)}`,
        decision,
      )).join('\n');
  const next = nextCursor === null
    ? ''
    : `<p class="pagination"><a href="/owner/review?cursor=${encodeURIComponent(nextCursor)}">More proposals</a></p>`;
  return pageShell({
    title: 'Proposals',
    bodyClass: 'proposal-review-page',
    body: `<main class="owner-shell review-shell" id="owner-review-list">
<header class="owner-header review-list-header">
<p class="surface-label">Owner review</p>
<h1>Proposals</h1>
<p class="lede">Read each suggested change and record your decision. Approval records intent only; source remains unchanged.</p>
<nav class="review-jump-links" aria-label="Proposal review sections"><a href="#needs-review">Needs review</a><a href="#decided">Decided</a></nav>
</header>
<section class="review-section" id="needs-review" aria-labelledby="actionable-heading">
<div class="section-heading"><h2 id="actionable-heading">Needs review</h2><span class="section-count">${overlay.actionable.length} on this page</span></div>
<div class="proposal-list">${actionable}</div>
${next}
</section>
<section class="review-section decided-section" id="decided" aria-labelledby="history-heading">
<div class="section-heading"><h2 id="history-heading">Decided</h2><span class="section-count">${overlay.history.length} shown</span></div>
<div class="proposal-list">${history}</div>
${overlay.historyTruncated ? '<p class="status">Only the newest decisions within the configured review bound are shown here.</p>' : ''}
</section>
<p class="review-return"><a href="/">Return to Cyberbase</a></p>
</main>`,
  });
}

function evidenceLinks(urls) {
  if (urls.length === 0) return '<p class="empty-state">No references were supplied.</p>';
  return `<ul class="evidence-links">${urls.map((url, index) => {
    const host = new URL(url).hostname;
    return `<li><a href="${escapeHtml(url)}" rel="noopener noreferrer">Reference ${index + 1} · ${escapeHtml(host)}</a></li>`;
  }).join('')}</ul>`;
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
  const operation = entry.evidence.proposal.operation;
  const path = entry.summary.source.path;
  return documentProjection({
    files: [{
      path,
      exists: document.baseText !== null,
      baseText: document.baseText,
      candidateText: document.candidateText,
    }],
    operations: [{
      path,
      start: operation.start,
      end: operation.end,
      oldText: proposalText(operation.expectedOldBytesBase64),
      replacementText: proposalText(operation.replacementBytesBase64),
    }],
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
  const view = proposalView(entry);
  return `<div class="mode-unavailable">
<p class="section-kicker">Not derivable</p>
<p>${escapeHtml(reason)}</p>
<p class="context-note">This surface never invents a page it cannot derive from the pinned source and the declared exact change. The declared spans are shown instead.</p>
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
  const path = entry.summary.source.path;
  const readingNote = 'Approximate structural reading. Changed passages always show exact source. This is not the published page.';
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
<div class="reader-controls">
<p class="mark-legend"><span>Removed text is <del>struck through</del>.</span> <span>Added text is <ins>underlined</ins>.</span> <span>Every other byte is unchanged.</span></p>
<p class="projection-note">${escapeHtml(readingNote)}</p>
</div>
<p class="document-heading"><code class="document-path">${escapeHtml(path)}</code></p>
<div class="mode-panel mode-panel-${mode.key}">${panel}</div>
</section>`;
}

function rationalePanel(entry) {
  const proposal = entry.evidence.proposal;
  return `<section class="rationale-section" aria-labelledby="rationale-heading">
<p class="section-kicker">Contributor note</p>
<h2 id="rationale-heading">Why this change</h2>
<p class="contributor-rationale">${escapeHtml(proposal.submission.rationale).replaceAll('\n', '<br>')}</p>
<div class="references"><h3>References</h3>${evidenceLinks(proposal.submission.evidence)}</div>
</section>`;
}

function technicalEvidence(entry, { decision = null, queueRetained = null, title = 'Technical evidence' } = {}) {
  const { evidence, summary, sourceVerification } = entry;
  const trust = evidence.classification.classification;
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
  return `<details class="technical-evidence">
<summary>${escapeHtml(title)}</summary>
<div class="technical-evidence-body">
<section><h3>Source binding</h3><dl class="technical-facts">
<div><dt>Path</dt><dd>${escapeHtml(summary.source.path)}</dd></div>
<div><dt>Repository</dt><dd>${escapeHtml(summary.source.repository)}</dd></div>
<div><dt>Revision</dt><dd>${escapeHtml(summary.source.revision)}</dd></div>
<div><dt>Git blob</dt><dd>${escapeHtml(sourceVerification?.gitObjectId ?? 'embedded decision evidence')}</dd></div>
<div><dt>Base digest</dt><dd>${escapeHtml(evidence.proposal.operation.baseDigest)}</dd></div>
<div><dt>Candidate digest</dt><dd>${escapeHtml(evidence.proposal.operation.candidateDigest)}</dd></div>
</dl></section>
<section><h3>Proposal record</h3><dl class="technical-facts">
<div><dt>Queue ID</dt><dd>${escapeHtml(summary.queueId)}</dd></div>
<div><dt>Proposal ID</dt><dd>${escapeHtml(summary.proposalId)}</dd></div>
<div><dt>Proposal digest</dt><dd>${escapeHtml(summary.proposalDigest)}</dd></div>
<div><dt>Review evidence</dt><dd>${escapeHtml(summary.reviewEvidenceDigest)}</dd></div>
<div><dt>Received</dt><dd>${escapeHtml(summary.receivedAt)}</dd></div>
<div><dt>Expires</dt><dd>${escapeHtml(summary.expiresAt)}</dd></div>
</dl></section>
<section><h3>Trust classification</h3><dl class="technical-facts">
<div><dt>Tier</dt><dd>${escapeHtml(summary.tier)}</dd></div>
<div><dt>Lane</dt><dd>${escapeHtml(summary.lane)}</dd></div>
<div><dt>Route</dt><dd>${escapeHtml(summary.route)}</dd></div>
<div><dt>Verified subject</dt><dd>${escapeHtml(evidence.classification.verifiedSubject ?? 'none')}</dd></div>
<div><dt>Policy status</dt><dd>${escapeHtml(evidence.classification.policyStatus)}</dd></div>
<div><dt>Policy digest</dt><dd>${escapeHtml(evidence.classification.policyDigest ?? 'none')}</dd></div>
</dl><h4>Reason codes</h4>${trustReasons}</section>
${decisionFacts}
</div>
</details>`;
}

function reviewIdentityHeader(entry, view) {
  const { summary } = entry;
  const proposal = entry.evidence.proposal;
  const references = evidenceLinks(proposal.submission.evidence);
  return `<header class="owner-header review-detail-header">
<a class="back-link" href="/owner/review">Back to Proposals</a>
<p class="attention identity-attention">Needs your decision</p>
<h1>${escapeHtml(changeName(view))}</h1>
<p class="proposal-summary">${escapeHtml(compactReviewText(proposal.submission.rationale, 200))}</p>
<div class="identity-meta">
<strong>1 exact change in 1 page</strong>
<span>${escapeHtml(summary.source.path)}</span>
<span>Received ${reviewTime(summary.receivedAt)}</span>
<span>Expires ${reviewTime(summary.expiresAt)}</span>
</div>
<details class="identity-details">
<summary>Contributor note and references</summary>
<p class="contributor-rationale">${escapeHtml(proposal.submission.rationale).replaceAll('\n', '<br>')}</p>
${references}
</details>
</header>`;
}

function decisionDock({ entry, csrfToken, view }) {
  const { summary } = entry;
  const policyAdvisory = summary.route === 'reject'
    ? '<p class="policy-advisory"><strong>Policy recommends rejection.</strong> Review the wording and evidence before recording your decision.</p>'
    : '';
  return `<aside class="decision-dock" aria-label="Your decision">
<details id="decision-dock-details">
<summary class="dock-bar">
<span class="dock-summary"><span class="dock-attention">Owner action required</span><strong>1 exact change in 1 page</strong><span class="dock-labels">${escapeHtml(summary.tier)} \u00b7 ${escapeHtml(summary.route)}</span></span>
<span class="dock-toggle">Decide this proposal</span>
</summary>
<div class="dock-body">
${policyAdvisory}
<p class="decision-boundary-copy"><strong>Approval records intent only.</strong> The source and policy are checked again when you confirm. Source remains unchanged.</p>
<form id="review-decision-form" data-queue-id="${escapeHtml(summary.queueId)}" data-review-evidence-digest="${escapeHtml(summary.reviewEvidenceDigest)}" data-csrf="${escapeHtml(csrfToken)}" data-max-reason-bytes="${OWNER_DECISION_REASON_MAX_BYTES}" data-suggestion-label="${escapeHtml(changeName(view))}">
<label for="decision-reason">Decision note</label>
<p class="field-help" id="decision-note-help">Required. This note becomes part of the durable decision receipt.</p>
<textarea class="decision-reason" id="decision-reason" name="reason" maxlength="${OWNER_DECISION_REASON_MAX_BYTES}" aria-describedby="decision-note-help decision-byte-count" required></textarea>
<div class="decision-form-footer"><span id="decision-byte-count" class="byte-count">0 of ${OWNER_DECISION_REASON_MAX_BYTES} UTF-8 bytes</span><div class="decision-actions">
<button type="button" data-action="reject" class="decision-reject">Reject</button>
<button type="button" data-action="approve" class="decision-approve">Approve</button>
</div></div>
<p id="decision-status" class="status" role="status" aria-live="polite" tabindex="-1"></p>
<dialog id="decision-dialog" aria-labelledby="decision-dialog-title" aria-describedby="decision-dialog-copy">
<div class="decision-dialog-sheet">
<p class="section-kicker" id="decision-dialog-kicker">Confirm decision</p>
<h2 id="decision-dialog-title">Confirm decision</h2>
<p class="dialog-suggestion" id="decision-dialog-suggestion"></p>
<p id="decision-dialog-copy">This decision is immutable. Source remains unchanged, and no application or publication begins.</p>
<div class="dialog-actions"><button type="button" class="dialog-back" data-dialog-cancel>Back</button><button type="button" id="decision-confirm">Confirm decision</button></div>
</div>
</dialog>
</form>
<ul class="no-effect-list">
<li>Records an immutable decision and nothing else.</li>
<li>Changes no queue lifecycle.</li>
<li>Starts no application or source write.</li>
<li>Creates no commit or push.</li>
<li>Starts no rebuild, deployment, or publication.</li>
</ul>
</div>
</details>
</aside>`;
}

function reviewDetailPage({ entry, csrfToken, mode = REVIEW_MODE_KEYS[0] }) {
  const view = proposalView(entry);
  return pageShell({
    title: `Review ${changeName(view)}`,
    script: '/owner/assets/review.js',
    bodyClass: 'proposal-review-page',
    body: `<main class="owner-shell review-shell" id="owner-review-detail">
${reviewIdentityHeader(entry, view)}
${comparisonPanel(entry, mode)}
${technicalEvidence(entry)}
</main>
${decisionDock({ entry, csrfToken, view })}`,
  });
}

function decisionDetailPage({ decision, summary, queueRetained }) {
  const entry = decisionEntry(decision, summary);
  const approved = decision.action === 'approve';
  return pageShell({
    title: approved ? 'Approval recorded' : 'Proposal rejected',
    bodyClass: 'proposal-review-page',
    body: `<main class="owner-shell review-shell" id="owner-decision-detail">
<header class="owner-header decision-receipt-header">
<a class="back-link" href="/owner/review">Back to Proposals</a>
<p class="surface-label">Decision receipt</p>
<h1>${approved ? 'Approval recorded' : 'Proposal rejected'}</h1>
<p class="decision-time">${reviewTime(decision.decidedAt)}</p>
</header>
<section class="decision-result ${approved ? 'decision-approved' : 'decision-rejected'}" aria-labelledby="decision-result-heading">
<h2 id="decision-result-heading">${approved ? 'Approved' : 'Rejected'}</h2>
<blockquote>${escapeHtml(decision.reason)}</blockquote>
<div class="source-unchanged"><strong>Source unchanged</strong><span>No application, write, commit, push, rebuild, deployment, or publication started.</span></div>
</section>
<section class="reviewed-suggestion" aria-labelledby="reviewed-suggestion-heading">
<p class="section-kicker">Reviewed suggestion</p>
<h2 id="reviewed-suggestion-heading">${escapeHtml(changeName(proposalView(entry)))}</h2>
<p class="context-copy">${proposalContext(proposalView(entry), 'proposed')}</p>
<p class="receipt-path">${escapeHtml(summary.source.path)}</p>
</section>
${technicalEvidence(entry, {
  decision,
  queueRetained,
  title: 'Receipt and verification details',
})}
</main>`,
  });
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

async function readBoundedJson(request, maximum) {
  const contentType = request.headers.get('content-type');
  if (contentType !== 'application/json') throw Object.assign(new Error('content-type'), { status: 415 });
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
    return JSON.parse(text);
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
  const keys = Object.keys(value);
  if (keys.length !== required.length || !required.every((key) => keys.includes(key))) return null;
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

export function createOwnerProposalReviewService({
  config: configInput,
  context,
  source,
  decisionClock = () => new Date(),
  recoverDecisions = recoverProposalDecisions,
  recordDecision = recordProposalDecision,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (!config.proposalReview.enabled) return null;
  if (!context
    || !source
    || typeof source.list !== 'function'
    || typeof source.load !== 'function'
    || typeof decisionClock !== 'function'
    || typeof recoverDecisions !== 'function'
    || typeof recordDecision !== 'function') {
    throw new TypeError('enabled proposal review requires context, source, clock, recovery, and decision dependencies');
  }

  let cachedDecisions = null;
  let recoveryInFlight = null;

  async function recovered({ refresh = false } = {}) {
    if (refresh && recoveryInFlight !== null) await recoveryInFlight;
    if (!refresh && cachedDecisions !== null) return cachedDecisions;
    if (recoveryInFlight !== null) return recoveryInFlight;
    recoveryInFlight = Promise.resolve(recoverDecisions(context)).then((value) => {
      cachedDecisions = value;
      return value;
    });
    try {
      return await recoveryInFlight;
    } finally {
      recoveryInFlight = null;
    }
  }

  return Object.freeze({
    async list({ cursor = null } = {}) {
      const local = await recovered();
      const seenCursors = new Set();
      let filteredEntries = 0;
      let pageCursor = cursor;
      let page;
      let complete;

      while (true) {
        const cursorKey = pageCursor ?? '<first-page>';
        if (seenCursors.has(cursorKey)) {
          throw new OwnerAlphaError('review-ipc-invalid-cursor', 'proposal review pagination repeated a cursor');
        }
        seenCursors.add(cursorKey);
        page = await source.list({
          state: 'pending-review',
          cursor: pageCursor,
          limit: config.proposalReview.maxListEntries,
        });
        complete = createProposalDecisionOverlay({
          entries: page.entries,
          decisions: local.decisions,
        });
        if (complete.actionable.length > 0 || page.nextCursor === null) break;
        if (page.entries.length === 0 || page.nextCursor === pageCursor) {
          throw new OwnerAlphaError('review-ipc-invalid-cursor', 'proposal review pagination made no forward progress');
        }
        filteredEntries += page.entries.length;
        if (filteredEntries > local.decisions.length) {
          throw new OwnerAlphaError('review-ipc-invalid-cursor', 'proposal review pagination exceeded the local decision bound');
        }
        pageCursor = page.nextCursor;
      }

      const history = complete.history.slice(0, config.proposalReview.maxListEntries);
      return Object.freeze({
        actionable: complete.actionable,
        history: Object.freeze(history),
        historyTruncated: complete.history.length > history.length,
        nextCursor: page.nextCursor,
      });
    },
    async load(queueId) {
      const local = await recovered();
      const decision = local.decisions.find((entry) => entry.queueId === queueId) ?? null;
      if (decision !== null) return Object.freeze({ entry: null, decision });
      return Object.freeze({ entry: await source.load(queueId), decision: null });
    },
    async loadDecision(queueId) {
      const local = await recovered();
      const decision = local.decisions.find((entry) => entry.queueId === queueId) ?? null;
      if (decision === null) return null;
      let queueRetained = null;
      try {
        const current = await source.load(queueId);
        createProposalDecisionOverlay({ entries: [current], decisions: [decision] });
        queueRetained = true;
      } catch (error) {
        if (error instanceof OwnerAlphaError
          && ['review-ipc-not-found', 'review-ipc-queue-entry-not-found'].includes(error.code)) {
          queueRetained = false;
        } else if (error instanceof OwnerAlphaError
          && ['review-not-actionable', 'review-expired'].includes(error.code)) {
          queueRetained = true;
        } else if (!(error instanceof OwnerAlphaError)
          || !['review-source-unavailable', 'review-source-timeout'].includes(error.code)) {
          throw error;
        }
      }
      const overlay = createProposalDecisionOverlay({ entries: [], decisions: [decision] });
      return Object.freeze({ ...overlay.history[0], queueRetained });
    },
    async record(intent) {
      const result = await recordDecision({
        context,
        source,
        ownerIdentity: config.owner.identity,
        intent,
        clock: decisionClock,
      });
      await recovered({ refresh: true });
      return result;
    },
  });
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
  const csp = options.reader === true ? READER_CSP : OWNER_CSP;
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
    if (url.pathname === '/') return response(null, 302, { Location: '/cyberbase/' });
    if (!url.pathname.startsWith('/cyberbase/')) return errorResponse(404, 'not-found');
    if (url.search !== '') return errorResponse(400, 'unexpected-query');
    return staticResponse(resolvedSiteRoot, url.pathname.slice('/cyberbase/'.length), request, {
      cleanHtml: true,
      reader: true,
    });
  };
}

export function createMemoryEditSessionStore({
  ttlMs = DEFAULT_EDIT_SESSION_TTL_MS,
  maxEntries = DEFAULT_MAX_EDIT_SESSIONS,
  now = () => Date.now(),
  createToken = token,
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('edit session store limits must be positive integers');
  }
  const entries = new Map();

  function prune() {
    const current = now();
    for (const [id, entry] of entries) if (entry.expiresAt <= current) entries.delete(id);
  }

  return Object.freeze({
    create(value) {
      prune();
      if (entries.size >= maxEntries) throw new OwnerAlphaError('edit-session-capacity', 'too many active edit sessions');
      let id;
      do id = createToken(); while (entries.has(id));
      if (!exactToken(id)) throw new TypeError('edit session token factory returned an invalid token');
      const expiresAt = now() + ttlMs;
      entries.set(id, { value, expiresAt });
      return Object.freeze({ id, expiresAt });
    },
    get(id) {
      prune();
      return entries.get(id)?.value ?? null;
    },
    delete(id) {
      return entries.delete(id);
    },
  });
}

export function createOwnerAlphaHandler({
  config: configInput,
  projectRoot = PROJECT_ROOT,
  siteRoot,
  publicRoot = PUBLIC_ROOT,
  createEditSession = createSourceEditSession,
  editSessions = createMemoryEditSessionStore(),
  saveEdit,
  lookupJob,
  proposalReview = null,
  createToken = token,
  createJobId = () => `OA-${randomUUID()}`,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
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

  function resolveSession(cookieValue) {
    if (!exactToken(cookieValue)) return null;
    // Constant-time scan; the map is bounded by MAX_OWNER_SESSIONS.
    let found = null;
    for (const [sessionToken, record] of sessions) {
      if (sameSecret(cookieValue, sessionToken)) found = record;
    }
    return found;
  }

  issueBootstrap();
  const initialBootstrapToken = outstanding.bootstrapToken;
  const expectedHost = `${config.listen.host}:${config.listen.port}`;
  const expectedOrigin = `http://${expectedHost}`;
  const readerOrigin = `http://${config.listen.host}:${config.listen.readerPort}`;
  const inFlight = new Set();
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

    if (url.pathname === '/owner/bootstrap') {
      if (request.method !== 'GET') return response(null, 405, { Allow: 'GET' });
      const query = queryObject(url, ['token']);
      if (!query || outstanding === null || !sameSecret(query.token, outstanding.bootstrapToken)) {
        return errorResponse(403, 'invalid-bootstrap');
      }
      const consumed = outstanding;
      outstanding = null;
      sessions.set(consumed.sessionToken, { csrfToken: consumed.csrfToken });
      return response(null, 303, {
        Location: `${readerOrigin}/cyberbase/`,
        'Set-Cookie': cookieHeader(consumed.sessionToken),
      });
    }

    const deviceSession = resolveSession(requestCookie(request));
    if (deviceSession === null) {
      return errorResponse(403, 'invalid-session');
    }
    const csrfToken = deviceSession.csrfToken;
    if (request.method === 'POST' && request.headers.get('origin') !== expectedOrigin) {
      return errorResponse(403, 'invalid-origin');
    }

    if (url.pathname === '/') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      return response(null, 302, { Location: `${readerOrigin}/cyberbase/` });
    }

    const asset = {
      '/owner/assets/editor.js': 'editor.js',
      '/owner/assets/job.js': 'job.js',
      '/owner/assets/review.js': 'review.js',
      '/owner/assets/owner.css': 'owner.css',
    }[url.pathname];
    if (asset) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      return staticResponse(publicRoot, asset, request, { directoryIndex: false });
    }

    if (url.pathname === '/owner/review' || url.pathname === '/api/review') {
      if (!config.proposalReview.enabled) return errorResponse(404, 'proposal-review-disabled');
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
        review = await proposalReview.list({ cursor: query.cursor ?? null });
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
          history: review.history.map((entry) => ({ summary: entry.summary })),
          historyTruncated: review.historyTruncated,
          nextCursor: review.nextCursor,
        });
      }
      if (request.method === 'HEAD') return html(null);
      return html(reviewListPage({ overlay: review, nextCursor: review.nextCursor }));
    }

    const reviewDecisionMatch = url.pathname.match(/^\/api\/review\/([^/]+)\/decision$/u);
    if (reviewDecisionMatch) {
      if (!config.proposalReview.enabled) return errorResponse(404, 'proposal-review-disabled');
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
      try {
        const recorded = await proposalReview.record({
          queueId,
          reviewEvidenceDigest: intent.reviewEvidenceDigest,
          action: intent.action,
          reason: intent.reason,
        });
        const summary = recorded.index.decisions.find((entry) => entry.queueId === queueId);
        if (!summary) throw new OwnerAlphaError('invalid-decision-result', 'decision index omitted its new immutable decision');
        return json({
          queueId,
          action: recorded.decision.action,
          decidedAt: recorded.decision.decidedAt,
          replayed: recorded.replayed,
          summary,
          statusUrl: `/owner/decisions/${encodeURIComponent(queueId)}`,
          jsonUrl: `/api/decisions/${encodeURIComponent(queueId)}`,
        }, recorded.replayed ? 200 : 201);
      } catch (error) {
        return errorResponse(reviewErrorStatus(error), error instanceof OwnerAlphaError ? error.code : 'decision-record-failed');
      }
    }

    const reviewDetailMatch = url.pathname.match(/^\/(owner\/review|api\/review)\/([^/]+)$/u);
    if (reviewDetailMatch) {
      if (!config.proposalReview.enabled) return errorResponse(404, 'proposal-review-disabled');
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
        loaded = await proposalReview.load(queueId);
      } catch (error) {
        return errorResponse(reviewErrorStatus(error), error instanceof OwnerAlphaError ? error.code : 'review-load-failed');
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
      return html(reviewDetailPage({ entry: loaded.entry, csrfToken, mode: reviewMode }));
    }

    const decisionDetailMatch = url.pathname.match(/^\/(owner\/decisions|api\/decisions)\/([^/]+)$/u);
    if (decisionDetailMatch) {
      if (!config.proposalReview.enabled) return errorResponse(404, 'proposal-review-disabled');
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      const queueId = reviewQueueId(decisionDetailMatch[2]);
      if (queueId === null) return errorResponse(400, 'invalid-queue-id');
      let history;
      try {
        history = await proposalReview.loadDecision(queueId);
      } catch (error) {
        return errorResponse(reviewErrorStatus(error), error instanceof OwnerAlphaError ? error.code : 'decision-load-failed');
      }
      if (history === null) return errorResponse(404, 'decision-not-found');
      if (decisionDetailMatch[1] === 'api/decisions') {
        if (request.method === 'HEAD') return json(null);
        return json(history);
      }
      if (request.method === 'HEAD') return html(null);
      return html(decisionDetailPage(history));
    }

    if (url.pathname === '/owner/edit') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      const query = queryObject(url, ['relativePath', 'slug']);
      if (!query) return errorResponse(400, 'invalid-edit-query');
      try {
        const session = await createEditSession({
          config,
          renderer: { relativePath: query.relativePath, slug: query.slug },
        });
        if (typeof session?.source?.text !== 'string') return errorResponse(500, 'invalid-edit-session');
        const stored = editSessions.create(session);
        const body = editPage({
          editSessionId: stored.id,
          csrfToken,
          session,
          reviewEnabled: config.proposalReview.enabled,
        });
        if (request.method === 'HEAD') return html(null, 200);
        return html(body);
      } catch (error) {
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
      const session = editSessions.get(save.editSessionId);
      if (session === null) return errorResponse(410, 'edit-session-expired');
      if (inFlight.has(save.editSessionId)) return errorResponse(409, 'save-in-progress');

      inFlight.add(save.editSessionId);
      let jobId;
      let started;
      try {
        jobId = validateJobId(createJobId());
        started = await saveEdit({ jobId, session, editedText: save.editedText });
        if (!started || started.jobId !== jobId || started.state !== 'accepted') {
          throw new OwnerAlphaError('invalid-save-acceptance', 'Save did not return exact durable acceptance');
        }
      } catch (error) {
        inFlight.delete(save.editSessionId);
        if (error instanceof OwnerAlphaError) {
          return errorResponse(error.code === 'lock-busy' ? 409 : 400, error.code);
        }
        return errorResponse(500, 'save-failed');
      }
      editSessions.delete(save.editSessionId);
      inFlight.delete(save.editSessionId);
      return json({
        jobId,
        state: started.state ?? 'accepted',
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
        job = await lookupJob(jobId);
      } catch (error) {
        if (error instanceof OwnerAlphaError && ['artifact-not-found', 'job-not-found'].includes(error.code)) {
          return errorResponse(404, 'job-not-found');
        }
        return errorResponse(500, 'job-lookup-failed');
      }
      if (!job || job.jobId !== jobId) return errorResponse(404, 'job-not-found');
      if (jobMatch[1] === 'api/jobs') {
        if (request.method === 'HEAD') return json(null, 200);
        return json(publicJob(job));
      }
      if (request.method === 'HEAD') return html(null);
      return html(jobPage(job, readerOrigin));
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
      resumeJob: typeof created.resumeJob === 'function' ? created.resumeJob : null,
      getJob: typeof created.getJob === 'function' ? created.getJob : null,
    };
  }
  if (!created || typeof created.saveEdit !== 'function') {
    throw new TypeError('createSaveHandler(options) must return saveEdit({ session, editedText })');
  }
  return {
    saveEdit: created.saveEdit,
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
    || typeof recordDecision !== 'function') {
    throw new TypeError('site, pipeline, handlers, servers, review, and recovery dependencies are required');
  }
  const config = await loadOwnerAlphaConfig(configFile);
  const storeContext = storeContextFromConfig(config, projectRoot);
  await prepareStore(storeContext);
  await rebuildSite({ config, projectRoot });
  const pipeline = await loadPipeline({ config, projectRoot, context: storeContext });
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
      recordDecision,
    });
  }
  const ownerFetch = createHandler({
    config,
    projectRoot,
    saveEdit: pipeline.saveEdit,
    lookupJob,
    proposalReview,
  });
  const readerFetch = createReader({ config, projectRoot });
  const runtime = startServers({ config, ownerFetch, readerFetch, serve });
  const recovery = Promise.resolve().then(async () => {
    await recoverDecisions(storeContext);
    return recoverJobs({
      config,
      context: storeContext,
      pipeline,
      listJobs,
    });
  });
  return Object.freeze({ ...runtime, recovery });
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
    runtime?.stop(true);
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
    await runtime.recovery;
    if (readyFile) await writeOwnerAlphaReadyMarker(readyFile);
    console.log(`Owner alpha reader: ${runtime.readerOrigin}/cyberbase/`);
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
  } catch (error) {
    await stop(1);
    console.error(`Owner alpha startup failed: ${error instanceof OwnerAlphaError ? error.code : 'unexpected-error'}`);
  }
}
