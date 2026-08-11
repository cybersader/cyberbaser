import { inspectProposalQueue } from '@cyberbaser/proposal-queue';
import { validateRuntimePaths } from './config.js';
import { createIntakeEvidenceContext } from './server.js';

function visible(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function decodedOperation(proposal) {
  return {
    oldText: Buffer.from(proposal.operation.expectedOldBytesBase64, 'base64').toString('utf8'),
    replacementText: Buffer.from(proposal.operation.replacementBytesBase64, 'base64').toString('utf8'),
  };
}

function htmlDocument(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5}body{max-width:72rem;margin:0 auto;padding:2rem}h1,h2{line-height:1.2}table{border-collapse:collapse;width:100%}th,td{border:1px solid currentColor;padding:.45rem;text-align:left;vertical-align:top}code,pre{font-family:ui-monospace,SFMono-Regular,monospace}pre{border:1px solid currentColor;padding:1rem;white-space:pre-wrap;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:minmax(9rem,14rem) minmax(0,1fr);gap:.4rem 1rem}.label{font-weight:700}.old{border-left:.4rem solid #a33}.new{border-left:.4rem solid #287a3d}@media(max-width:40rem){.grid{grid-template-columns:1fr}.label{margin-top:.7rem}}
</style>
</head>
<body>${body}</body>
</html>
`;
}

export function renderListText(entries) {
  if (entries.length === 0) return 'No retained proposals.\n';
  return `${entries.map((entry) => [
    entry.queueId,
    entry.state.state,
    entry.receipt.receivedAt,
    entry.classification.classification.route,
    visible(entry.proposal.source.path),
  ].join('\t')).join('\n')}\n`;
}

export function renderListHtml(entries) {
  const rows = entries.length === 0
    ? '<tr><td colspan="5">No retained proposals.</td></tr>'
    : entries.map((entry) => `<tr><td><code>${escapeHtml(entry.queueId)}</code></td><td>${escapeHtml(entry.state.state)}</td><td>${escapeHtml(entry.receipt.receivedAt)}</td><td>${escapeHtml(entry.classification.classification.route)}</td><td><code>${escapeHtml(entry.proposal.source.path)}</code></td></tr>`).join('');
  return htmlDocument('Account-free proposal queue', `<h1>Account-free proposal queue</h1><table><thead><tr><th>Queue ID</th><th>State</th><th>Received</th><th>Route</th><th>Source path</th></tr></thead><tbody>${rows}</tbody></table>`);
}

export function renderShowText(entry) {
  const { oldText, replacementText } = decodedOperation(entry.proposal);
  const evidence = entry.proposal.submission.evidence.length === 0
    ? '(none)'
    : entry.proposal.submission.evidence.map((url) => `- ${visible(url)}`).join('\n');
  return [
    `Queue ID: ${entry.queueId}`,
    `State: ${entry.state.state}`,
    `Received: ${entry.receipt.receivedAt}`,
    `Expires: ${entry.receipt.expiresAt}`,
    `Trust tier: ${entry.classification.classification.tier}`,
    `Review route: ${entry.classification.classification.route}`,
    `Repository: ${visible(entry.proposal.source.repository)}`,
    `Revision: ${visible(entry.proposal.source.revision)}`,
    `Path: ${visible(entry.proposal.source.path)}`,
    `Bytes: ${entry.proposal.operation.start}..${entry.proposal.operation.end}`,
    '',
    'Rationale:',
    visible(entry.proposal.submission.rationale),
    '',
    'Evidence:',
    evidence,
    '',
    'Exact old text:',
    visible(oldText),
    '',
    'Exact replacement text:',
    visible(replacementText),
    '',
  ].join('\n');
}

export function renderShowHtml(entry) {
  const { oldText, replacementText } = decodedOperation(entry.proposal);
  const evidence = entry.proposal.submission.evidence.length === 0
    ? '<p>None.</p>'
    : `<ul>${entry.proposal.submission.evidence.map((url) => `<li><code>${escapeHtml(url)}</code></li>`).join('')}</ul>`;
  const reasons = entry.classification.classification.reasons.length === 0
    ? '<p>None.</p>'
    : `<ul>${entry.classification.classification.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`;
  const details = [
    ['Queue ID', entry.queueId],
    ['State', entry.state.state],
    ['Received', entry.receipt.receivedAt],
    ['Expires', entry.receipt.expiresAt],
    ['Trust tier', entry.classification.classification.tier],
    ['Review route', entry.classification.classification.route],
    ['Repository', entry.proposal.source.repository],
    ['Revision', entry.proposal.source.revision],
    ['Path', entry.proposal.source.path],
    ['Byte range', `${entry.proposal.operation.start}..${entry.proposal.operation.end}`],
  ].map(([label, value]) => `<div class="label">${escapeHtml(label)}</div><div><code>${escapeHtml(value)}</code></div>`).join('');
  return htmlDocument(`Proposal ${entry.queueId}`, `<h1>Account-free proposal</h1><div class="grid">${details}</div><h2>Rationale</h2><pre>${escapeHtml(entry.proposal.submission.rationale)}</pre><h2>Evidence</h2>${evidence}<h2>Classification reasons</h2>${reasons}<h2>Exact old text</h2><pre class="old">${escapeHtml(oldText)}</pre><h2>Exact replacement text</h2><pre class="new">${escapeHtml(replacementText)}</pre>`);
}

export async function runReviewCommand({ config, command, queueId = null, format = 'text', state = null }) {
  if (!['text', 'html'].includes(format)) throw new Error('format must be text or html');
  if (!['list', 'show'].includes(command)) throw new Error('command must be list or show');
  await validateRuntimePaths(config);
  const evidenceContext = createIntakeEvidenceContext({ config });
  const queue = await inspectProposalQueue({
    config: config.queue,
    resolveEvidence: evidenceContext.resolveDurableEvidence,
  });
  try {
    if (command === 'list') {
      const entries = await queue.list({ state });
      return format === 'html' ? renderListHtml(entries) : renderListText(entries);
    }
    if (typeof queueId !== 'string') throw new Error('show requires a queue ID');
    const entry = await queue.load(queueId);
    return format === 'html' ? renderShowHtml(entry) : renderShowText(entry);
  } finally {
    await queue.close();
  }
}
