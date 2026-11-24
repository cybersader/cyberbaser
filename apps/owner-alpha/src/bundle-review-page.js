// Route C for page bundles: a new page shown in the simplified rendering with
// a "New page at /address" banner, its images taken from the bundle's own
// bytes. The shell lives on the owner origin; the page itself is a sandboxed
// frame that runs nothing and loads nothing (its images are inlined), so vault
// content can neither run nor reach the decision controls.
import { findFrontmatterInText } from '../../../packages/correction/src/frontmatter.js';
import { imageEmbeds, sniffImage } from '../../../packages/media-check/src/index.js';
import { escapeHtml } from './proposal-review-page.js';

// The frame policy: no scripts, no network, images only as data: URLs.
export const BUNDLE_FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'img-src data:',
  "style-src 'unsafe-inline'",
  'sandbox',
].join('; ');

// One image served on its own: the sniffed type, never rendered as a document.
export const BUNDLE_IMAGE_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

const SNIFFED = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });

/** The Content-Type for image bytes from their magic bytes, or null (refuse to serve). */
export function sniffedImageType(bytes) {
  return SNIFFED[sniffImage(new Uint8Array(bytes))] ?? null;
}

const STATE_TEXT = Object.freeze({
  review: 'Waiting for your review',
  signing: 'Waiting for your approval on your phone',
  published: 'Published',
  declined: 'Declined',
  stale: 'Your notes changed since this was sent. Ask for it again.',
});

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Which bundle image an embed target names: exact path, relative path, or a unique file name. */
export function resolveBundleImage(target, fromPath, imagePaths) {
  const clean = String(target ?? '').split('|')[0].split('#')[0].trim().replace(/^<|>$/gu, '');
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* keep */ }
  const relative = [dirOf(fromPath), decoded].filter(Boolean).join('/').split('/').reduce((parts, part) => {
    if (part === '..') parts.pop(); else if (part !== '.' && part !== '') parts.push(part);
    return parts;
  }, []).join('/');
  for (const candidate of [decoded, relative]) if (imagePaths.includes(candidate)) return candidate;
  const byName = imagePaths.filter((p) => p.split('/').at(-1) === decoded.split('/').at(-1));
  return byName.length === 1 ? byName[0] : null;
}

/**
 * The note in the simplified rendering: headings, paragraphs and lists as
 * plain text, properties as a short list, and each embedded bundle image
 * inline. images: Map path -> { bytes, mediaType } (already checked).
 */
export function bundleFramePage({ path, text, address, images }) {
  const found = findFrontmatterInText(text);
  const body = found.kind === 'block' ? text.slice(found.textRange.end) : text;
  const properties = found.kind === 'block' ? found.yamlText.split('\n').filter((line) => line.trim() !== '').slice(0, 20) : [];
  const imagePaths = [...images.keys()];
  const embeds = imageEmbeds(body);
  const parts = [];
  let cursor = 0;
  const inlineText = (value) => escapeHtml(value);
  for (const embed of embeds) {
    parts.push(inlineText(body.slice(cursor, embed.index)));
    const hit = resolveBundleImage(embed.target, path, imagePaths);
    const image = hit === null ? null : images.get(hit);
    const type = image === null ? null : sniffedImageType(image.bytes);
    parts.push(type === null ? `<span class="missing">${escapeHtml(embed.raw)}</span>`
      : `<img alt="${escapeHtml(hit.split('/').at(-1))}" src="data:${type};base64,${Buffer.from(image.bytes).toString('base64')}">`);
    cursor = embed.index + embed.raw.length;
  }
  parts.push(inlineText(body.slice(cursor)));
  const blocks = parts.join('').split(/\n{2,}/u).map((block) => {
    const heading = /^(#{1,6})\s+(.*)$/su.exec(block.trim());
    if (heading) return `<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`;
    return block.trim() === '' ? '' : `<p>${block.trim().replace(/\n/gu, '<br>')}</p>`;
  }).join('\n');
  const props = properties.length === 0 ? '' : `<details class="props"><summary>Properties</summary><ul>${properties.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></details>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(path)}</title><style>
body{font:17px/1.6 system-ui,sans-serif;margin:0 auto;max-width:44rem;padding:1.5rem;color:#1d2320;background:#f8f8f5}
.banner{border:1px solid #0b6b4b;border-radius:8px;padding:.6rem .8rem;margin-bottom:1rem;color:#0c4a33;background:#d9f0e2}
img{max-width:100%;height:auto;display:block;margin:.5rem 0}.missing{color:#8a2c22}.props{color:#55605a;font-size:.9em}
</style></head><body><div class="banner">New page at <strong>${escapeHtml(address)}</strong></div>${props}${blocks}</body></html>\n`;
}

/** The review shell: what the bundle adds, its sender, the page frame, and the decision controls. */
export function bundleShellPage({ record, csrfToken, colorScheme = 'light' }) {
  const id = encodeURIComponent(record.bundleId);
  const additions = record.publicAdditions.map((entry) => `<li>New page at <strong>${escapeHtml(entry.address)}</strong> <span class="rv-soft">(${escapeHtml(entry.path)})</span></li>`).join('');
  const images = record.images.map((image, index) => `<li><a href="/owner/bundles/${id}/image/${index}">${escapeHtml(image.path)}</a> <span class="rv-soft">${escapeHtml(image.mediaType)}, ${Math.ceil(image.byteLength / 1024)} KiB</span></li>`).join('');
  const sender = record.submitter ? escapeHtml(record.submitter.label) : 'Unknown';
  const actions = record.state !== 'review' ? '' : `<form method="post" action="/owner/bundles/${id}/approve"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><button type="submit">Approve, then sign on your phone</button></form>
<form method="post" action="/owner/bundles/${id}/decline"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><button type="submit">Decline</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New page</title><link rel="stylesheet" href="/owner/assets/review.css"></head>
<body class="rv-doc rv-bundle rv-scheme-${['dark', 'light', 'system'].includes(colorScheme) ? colorScheme : 'light'}"><main><h1>New page</h1><p>From ${sender}. ${escapeHtml(STATE_TEXT[record.state] ?? record.state)}${record.reason ? ` (${escapeHtml(record.reason)})` : ''}</p>
<ul>${additions}</ul>${images === '' ? '' : `<p>Images</p><ul>${images}</ul>`}
${record.publicAdditions.map((_, index) => `<iframe title="The new page" sandbox="" src="/owner/bundles/${id}/page/${index}"></iframe>`).join('')}
${actions}</main></body></html>\n`;
}

/** A plain list of bundles for the owner. */
export function bundleListPage({ records }) {
  const rows = records.map((record) => `<li><a href="/owner/bundles/${encodeURIComponent(record.bundleId)}">${escapeHtml(record.publicAdditions.map((entry) => entry.address).join(', ') || record.bundleId)}</a> <span class="rv-soft">${escapeHtml(STATE_TEXT[record.state] ?? record.state)}</span></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>New pages</title><link rel="stylesheet" href="/owner/assets/review.css"></head>
<body class="rv-doc"><main><h1>New pages</h1>${rows === '' ? '<p>Nothing is waiting.</p>' : `<ul>${rows}</ul>`}</main></body></html>\n`;
}
