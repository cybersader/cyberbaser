import { TextDecoder } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyCorrection } from '@cyberbaser/correction';
import { checkSite } from '@cyberbaser/linkcheck';
import { checkChange } from '@cyberbaser/ofm';
import { project, verifyProjection } from '@cyberbaser/projection';
import { select } from '@cyberbaser/publish';
import { classify, parseConfig } from '@cyberbaser/trust';
import { fail, OwnerAlphaError } from './errors.js';
import { deepFreeze } from './json.js';
import { renderPinnedQuartz } from './quartz-renderer.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const COPY_IGNORES = new Set(['.git', '.obsidian', '.trash', '.workspace', 'node_modules']);
const BROKEN_TUPLE = Object.freeze(['page', 'href', 'decoded', 'class']);
export const MAX_VISIBLE_WITNESS_CHARS = 240;

function exactBytes(value, name) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  fail('invalid-check-input', `${name} must be a Buffer or Uint8Array`);
}

function decodeUtf8(bytes, name) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail('invalid-utf8', `${name} must be exact UTF-8 bytes`);
  }
}

function sourcePathValue(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid-source-path', 'sourcePath must be one repository-relative POSIX path');
  }
  return value;
}

function mappedFile(root, relativePath) {
  const sourcePath = sourcePathValue(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...sourcePath.split('/'));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail('source-path-outside-checkout', 'sourcePath escaped the isolated checkout');
  }
  return resolved;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTrustPolicy(value) {
  return typeof value === 'string' ? parseConfig(value) : value;
}

function allowedList(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string')) {
    fail('invalid-check-policy', `${name} must be a non-empty array of exact strings`);
  }
  return value;
}

function canonicalBase64Bytes(value, name) {
  if (typeof value !== 'string'
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail('invalid-operation-bytes', `${name} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('invalid-operation-bytes', `${name} must be canonical base64`);
  return bytes;
}

function correctionFromOperation(operation) {
  if (operation && Object.hasOwn(operation, 'replacementBytes')) {
    return {
      correction: operation,
      expectedOldBytes: exactBytes(operation.expectedOldBytes, 'operation.expectedOldBytes'),
      replacementBytes: exactBytes(operation.replacementBytes, 'operation.replacementBytes'),
    };
  }
  const expectedOldBytes = canonicalBase64Bytes(
    operation?.expectedOldBytesBase64,
    'operation.expectedOldBytesBase64',
  );
  const replacementBytes = canonicalBase64Bytes(
    operation?.replacementBytesBase64,
    'operation.replacementBytesBase64',
  );
  return {
    expectedOldBytes,
    replacementBytes,
    correction: {
      operationType: 'offset',
      baseByteLength: operation?.baseByteLength,
      baseDigest: operation?.baseDigest,
      start: operation?.start,
      end: operation?.end,
      expectedOldBytes,
      replacementBytes,
      candidateByteLength: operation?.candidateByteLength,
      candidateDigest: operation?.candidateDigest,
    },
  };
}

/** Run the checks that need only the bound base, operation, candidate and owner policy. */
export function runImmediateChecks({
  baseBytes,
  candidateBytes,
  operation,
  sourcePath,
  config,
  trustPolicy,
  trustSubject,
}) {
  const base = exactBytes(baseBytes, 'baseBytes');
  const candidate = exactBytes(candidateBytes, 'candidateBytes');
  const relativePath = sourcePathValue(sourcePath ?? operation?.source?.relativePath);
  const normalizedOperation = correctionFromOperation(operation);
  let reproduced;
  try {
    reproduced = applyCorrection(base, normalizedOperation.correction);
  } catch (error) {
    fail('operation-reproduction-failed', 'the bound operation could not be applied to the supplied base', {
      cause: error?.code ?? error?.name ?? 'unknown',
    });
  }
  if (!reproduced.equals(candidate)) {
    fail('operation-candidate-mismatch', 'the bound operation does not reproduce the exact candidate bytes');
  }

  const start = operation?.start;
  const end = operation?.end;
  const replacement = normalizedOperation.replacementBytes;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > base.length) {
    fail('invalid-operation-range', 'operation.start and operation.end must bound one exact base byte range');
  }
  const candidateSuffixStart = start + replacement.length;
  const prefixIdentical = base.subarray(0, start).equals(candidate.subarray(0, start));
  const suffixIdentical = base.subarray(end).equals(candidate.subarray(candidateSuffixStart));
  if (!prefixIdentical || !suffixIdentical) {
    fail('outside-operation-bytes-changed', 'candidate bytes outside the declared operation are not identical');
  }

  const before = decodeUtf8(base, 'baseBytes');
  const after = decodeUtf8(candidate, 'candidateBytes');
  const ofm = checkChange(before, after);
  const allowedOfmVerdicts = allowedList(config?.checks?.allowedOfmVerdicts, 'config.checks.allowedOfmVerdicts');
  if (!allowedOfmVerdicts.includes(ofm.verdict)) {
    fail('ofm-verdict-not-allowed', `OFM verdict ${ofm.verdict} is not allowed by owner policy`, {
      verdict: ofm.verdict,
      allowed: [...allowedOfmVerdicts],
      findings: ofm.findings.slice(0, 20),
    });
  }

  const subject = trustSubject ?? {
    author: config?.owner?.identity,
    authorType: 'human',
  };
  const trust = classify({
    author: subject?.author,
    authorType: subject?.authorType,
    files: [{ path: relativePath, before, after, status: 'modified' }],
    meta: { ownerAlpha: true },
  }, normalizeTrustPolicy(trustPolicy));
  const allowedTrustRoutes = allowedList(config?.owner?.allowedTrustRoutes, 'config.owner.allowedTrustRoutes');
  if (!allowedTrustRoutes.includes(trust.route)) {
    fail('trust-route-not-allowed', `trust route ${trust.route} is not allowed by owner policy`, {
      route: trust.route,
      allowed: [...allowedTrustRoutes],
      tier: trust.tier,
      reasons: trust.reasons,
    });
  }

  return deepFreeze({
    ok: true,
    operation: {
      reproducesCandidate: true,
      outsideBytesIdentical: true,
      start,
      end,
      oldByteLength: end - start,
      replacementByteLength: replacement.length,
    },
    ofm: plain(ofm),
    trust: plain(trust),
  });
}

function summarizeVerification(verification) {
  return {
    ok: verification.ok,
    checked: plain(verification.checked),
    unexpected: verification.unexpected.slice(0, 20),
    missing: verification.missing.slice(0, 20),
    deniedPresent: verification.deniedPresent.slice(0, 20),
    titleMatchCount: verification.titleMatchCount,
  };
}

/** Select, project and explicitly verify one isolated baseline or candidate vault. */
export async function runPublicationChecks({ vaultDir, outputDir, sourcePath }) {
  const relativePath = sourcePathValue(sourcePath);
  const selection = select(vaultDir, { audience: 'public' });
  if (!selection.published.includes(relativePath)) {
    fail('source-not-published', 'the edited source is not selected by the public publication boundary', {
      sourcePath: relativePath,
      errors: selection.errors.slice(0, 20),
    });
  }

  const projection = project(vaultDir, outputDir, {
    audience: 'public',
    selectResult: selection,
    lowercase: false,
    verify: true,
    writeReport: false,
  });
  if (!projection.ok) {
    fail('projection-failed', 'the isolated publication projection failed', {
      failures: projection.failures.slice(0, 20),
    });
  }

  const verification = verifyProjection(vaultDir, outputDir, selection, { lowercase: false });
  if (!verification.ok) {
    fail('projection-verification-failed', 'explicit post-copy publication verification failed', {
      unexpected: verification.unexpected.slice(0, 20),
      missing: verification.missing.slice(0, 20),
      deniedPresent: verification.deniedPresent.slice(0, 20),
    });
  }

  const source = await readFile(mappedFile(vaultDir, relativePath));
  const projected = await readFile(mappedFile(outputDir, relativePath));
  if (!source.equals(projected)) {
    fail('projected-source-bytes-changed', 'the selected source was not projected byte-for-byte');
  }

  return deepFreeze({
    ok: true,
    sourcePublished: true,
    published: [...selection.published].sort(),
    selection: {
      counts: plain(selection.report.counts),
      errors: selection.errors.slice(0, 20).map(plain),
    },
    projection: {
      ok: true,
      counts: plain(projection.counts),
      warningCount: projection.warnings.length,
      warnings: projection.warnings.slice(0, 20).map(plain),
    },
    verification: summarizeVerification(verification),
    sourceBytesIdentical: true,
  });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBroken(left, right) {
  return compareText(left.page, right.page)
    || compareText(left.href, right.href)
    || compareText(left.decoded, right.decoded)
    || compareText(left.class, right.class);
}

function brokenKey(item) {
  return JSON.stringify(BROKEN_TUPLE.map((key) => item[key]));
}

/** Stable set difference over the public @cyberbaser/linkcheck finding tuple. */
export function candidateOnlyBrokenLinks(baselineCheck, candidateCheck) {
  const baseline = [...(baselineCheck?.broken ?? [])].sort(compareBroken);
  const candidate = [...(candidateCheck?.broken ?? [])].sort(compareBroken);
  const baselineKeys = new Set(baseline.map(brokenKey));
  const candidateKeys = new Set(candidate.map(brokenKey));
  const candidateOnly = candidate.filter((item) => !baselineKeys.has(brokenKey(item)));
  const baselineOnly = baseline.filter((item) => !candidateKeys.has(brokenKey(item)));
  const unchanged = candidate.filter((item) => baselineKeys.has(brokenKey(item))).length;
  return deepFreeze({
    tuple: [...BROKEN_TUPLE],
    candidateOnly: candidateOnly.map(plain),
    baselineOnly: baselineOnly.map(plain),
    unchanged,
    counts: {
      baseline: baseline.length,
      candidate: candidate.length,
      candidateOnly: candidateOnly.length,
      baselineOnly: baselineOnly.length,
      unchanged,
    },
  });
}

const ENTITY_NAMES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’',
});

function decodeEntities(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/giu, (whole, entity) => {
    if (entity[0] !== '#') return ENTITY_NAMES[entity.toLowerCase()] ?? whole;
    const hex = entity[1]?.toLowerCase() === 'x';
    const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isSafeInteger(number) || number < 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) {
      return whole;
    }
    return String.fromCodePoint(number);
  });
}

/** Extract normalized body text while excluding attributes, metadata and non-visible script/style payloads. */
export function extractVisibleText(html) {
  let text = String(html ?? '');
  const body = text.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/iu);
  if (body) text = body[1];
  text = text
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(?:script|style|template|noscript|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript|svg)\s*>/giu, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/giu, ' ')
    .replace(/<\/(?:address|article|aside|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)\s*>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ');
  return decodeEntities(text).replace(/\s+/gu, ' ').trim();
}

function occurrenceCount(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}

function commonVisibleChange(baseline, candidate) {
  const left = Array.from(baseline);
  const right = Array.from(candidate);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > prefix && rightEnd > prefix && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  return { left, right, prefix, leftEnd, rightEnd };
}

/** Derive the shortest bounded pair that is unique in its own page and absent in the other. */
export function deriveVisibleWitnesses(baselineText, candidateText, { maxChars = MAX_VISIBLE_WITNESS_CHARS } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1024) {
    fail('invalid-witness-limit', 'maxChars must be a positive integer no greater than 1024');
  }
  const baseline = String(baselineText ?? '').replace(/\s+/gu, ' ').trim();
  const candidate = String(candidateText ?? '').replace(/\s+/gu, ' ').trim();
  if (baseline === candidate) {
    fail('rendered-visible-text-unchanged', 'the target page visible text did not change');
  }

  const change = commonVisibleChange(baseline, candidate);
  const oldCoreLength = change.leftEnd - change.prefix;
  const newCoreLength = change.rightEnd - change.prefix;
  if (oldCoreLength > maxChars || newCoreLength > maxChars) {
    fail('rendered-change-too-wide', 'the visible target-page change exceeds the bounded witness limit', {
      oldCoreLength,
      newCoreLength,
      maxChars,
    });
  }

  const suffixAvailable = Math.min(
    change.left.length - change.leftEnd,
    change.right.length - change.rightEnd,
  );
  const maximumContext = maxChars - Math.max(oldCoreLength, newCoreLength);
  for (let total = 0; total <= maximumContext; total += 1) {
    const maxLeft = Math.min(total, change.prefix);
    for (let leftContext = 0; leftContext <= maxLeft; leftContext += 1) {
      const rightContext = total - leftContext;
      if (rightContext > suffixAvailable) continue;
      const oldWitness = change.left
        .slice(change.prefix - leftContext, change.leftEnd + rightContext)
        .join('');
      const newWitness = change.right
        .slice(change.prefix - leftContext, change.rightEnd + rightContext)
        .join('');
      if (oldWitness.length === 0 || newWitness.length === 0) continue;

      const counts = {
        baselineOld: occurrenceCount(baseline, oldWitness),
        baselineNew: occurrenceCount(baseline, newWitness),
        candidateOld: occurrenceCount(candidate, oldWitness),
        candidateNew: occurrenceCount(candidate, newWitness),
      };
      if (counts.baselineOld === 1
        && counts.baselineNew === 0
        && counts.candidateOld === 0
        && counts.candidateNew === 1) {
        return deepFreeze({
          old: oldWitness,
          new: newWitness,
          counts,
          maxChars,
          oldCharacters: Array.from(oldWitness).length,
          newCharacters: Array.from(newWitness).length,
        });
      }
    }
  }

  fail('rendered-witness-not-unique', 'no bounded unique old/new visible-text witness could be derived', {
    maxChars,
  });
}

function shortestAnchoredWitness(ownText, otherText, seed, maxChars) {
  const own = Array.from(ownText);
  const normalizedSeed = String(seed ?? '').replace(/\s+/gu, ' ').trim();
  const seedLength = Array.from(normalizedSeed).length;
  if (seedLength === 0 || seedLength > maxChars) return null;
  const starts = [];
  let offset = 0;
  while (true) {
    const found = ownText.indexOf(normalizedSeed, offset);
    if (found < 0) break;
    starts.push(Array.from(ownText.slice(0, found)).length);
    offset = found + normalizedSeed.length;
  }
  if (starts.length === 0) return null;

  for (let total = 0; total <= maxChars - seedLength; total += 1) {
    for (const start of starts) {
      const maxLeft = Math.min(total, start);
      for (let leftContext = 0; leftContext <= maxLeft; leftContext += 1) {
        const rightContext = total - leftContext;
        if (start + seedLength + rightContext > own.length) continue;
        const witness = own
          .slice(start - leftContext, start + seedLength + rightContext)
          .join('');
        if (occurrenceCount(ownText, witness) === 1 && occurrenceCount(otherText, witness) === 0) {
          return witness;
        }
      }
    }
  }
  return null;
}

function deriveAnchoredVisibleWitnesses(
  baselineText,
  candidateText,
  { oldText, newText, maxChars },
) {
  const baseline = String(baselineText ?? '').replace(/\s+/gu, ' ').trim();
  const candidate = String(candidateText ?? '').replace(/\s+/gu, ' ').trim();
  const oldWitness = shortestAnchoredWitness(baseline, candidate, oldText, maxChars);
  const newWitness = shortestAnchoredWitness(candidate, baseline, newText, maxChars);
  if (oldWitness === null || newWitness === null) return null;
  return deepFreeze({
    old: oldWitness,
    new: newWitness,
    counts: {
      baselineOld: occurrenceCount(baseline, oldWitness),
      baselineNew: occurrenceCount(baseline, newWitness),
      candidateOld: occurrenceCount(candidate, oldWitness),
      candidateNew: occurrenceCount(candidate, newWitness),
    },
    maxChars,
    oldCharacters: Array.from(oldWitness).length,
    newCharacters: Array.from(newWitness).length,
  });
}

function renderedPagePath(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid-rendered-target', 'targetPage must be one exact relative HTML path');
  }
  if (!value.toLowerCase().endsWith('.html')) {
    fail('invalid-rendered-target', 'targetPage must end in .html');
  }
  return value;
}

export function targetPageForSlug(slug) {
  if (slug === '') return 'index.html';
  if (typeof slug !== 'string'
    || slug.includes('\\')
    || slug.startsWith('/')
    || slug.includes('?')
    || slug.includes('#')
    || slug.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid-rendered-slug', 'targetSlug must be one exact renderer-issued relative slug');
  }
  return renderedPagePath(`${slug}.html`);
}

function siteSummary(check) {
  return {
    total: check.total,
    ok: check.ok,
    occurrences: check.occurrences,
    pages: check.pages,
    broken: check.broken.length,
    byClass: plain(check.byClass),
  };
}

/** Check exact target-page visible text plus the candidate-only internal-link delta. */
export async function runRenderChecks({
  baselineSiteDir,
  candidateSiteDir,
  targetPage,
  basePath = '',
  oldText,
  newText,
  maxWitnessChars = MAX_VISIBLE_WITNESS_CHARS,
}) {
  const page = renderedPagePath(targetPage);
  let baselineHtml;
  let candidateHtml;
  try {
    [baselineHtml, candidateHtml] = await Promise.all([
      readFile(mappedFile(baselineSiteDir, page), 'utf8'),
      readFile(mappedFile(candidateSiteDir, page), 'utf8'),
    ]);
  } catch (error) {
    fail('rendered-target-missing', 'the exact target page is missing from a rendered lane', {
      targetPage: page,
      cause: error?.code ?? 'unknown',
    });
  }

  const baselineCheck = checkSite(baselineSiteDir, { basePath });
  const candidateCheck = checkSite(candidateSiteDir, { basePath });
  const linkDelta = candidateOnlyBrokenLinks(baselineCheck, candidateCheck);
  if (linkDelta.counts.candidateOnly !== 0) {
    fail('candidate-broken-links-added', 'the candidate render introduced broken internal links', {
      candidateOnly: linkDelta.candidateOnly.slice(0, 20),
    });
  }

  const baselineVisible = extractVisibleText(baselineHtml);
  const candidateVisible = extractVisibleText(candidateHtml);
  const hasNonEmptyAnchors = typeof oldText === 'string'
    && typeof newText === 'string'
    && oldText.replace(/\s+/gu, ' ').trim() !== ''
    && newText.replace(/\s+/gu, ' ').trim() !== '';
  const anchored = hasNonEmptyAnchors
    ? deriveAnchoredVisibleWitnesses(baselineVisible, candidateVisible, {
      oldText,
      newText,
      maxChars: maxWitnessChars,
    })
    : null;
  if (hasNonEmptyAnchors && anchored === null) {
    fail('rendered-operation-witness-missing', 'the exact old/new operation text could not produce bounded visible witnesses');
  }
  const witnesses = anchored ?? deriveVisibleWitnesses(baselineVisible, candidateVisible, {
    maxChars: maxWitnessChars,
  });

  return deepFreeze({
    ok: true,
    targetPage: page,
    sameExactTargetPage: true,
    witnesses,
    links: {
      baseline: siteSummary(baselineCheck),
      candidate: siteSummary(candidateCheck),
      delta: linkDelta,
    },
  });
}

async function assertNoSymlinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (COPY_IGNORES.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail('checkout-symlink-rejected', 'the checkout contains a symbolic link in the copied tree', {
          path: path.relative(root, target).split(path.sep).join('/'),
        });
      }
      if (entry.isDirectory()) pending.push(target);
    }
  }
}

async function copyCheckout(sourceDir, destinationDir) {
  const sourceRoot = await realpath(sourceDir);
  const metadata = await lstat(sourceRoot);
  if (!metadata.isDirectory()) fail('checkout-not-directory', 'checkoutDir must be a directory');
  await assertNoSymlinks(sourceRoot);
  await mkdir(path.dirname(destinationDir), { recursive: true });
  await cp(sourceRoot, destinationDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (relative === '') return true;
      return !relative.split(path.sep).some((segment) => COPY_IGNORES.has(segment));
    },
  });
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function basePathFromConfig(config) {
  try {
    return new URL(config?.live?.baseUrl).pathname.replace(/^\/+|\/+$/gu, '');
  } catch {
    fail('invalid-check-policy', 'config.live.baseUrl must be an absolute URL');
  }
}

async function defaultTrustPolicy(checkoutDir) {
  try {
    return await readFile(path.join(checkoutDir, '.cyberbaser', 'trust.yml'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function rendererFunction(renderer) {
  if (typeof renderer === 'function') return renderer;
  if (renderer && typeof renderer.render === 'function') return renderer.render.bind(renderer);
  fail('invalid-renderer', 'renderer must be an injected function or object with render()');
}

/**
 * Run every automatic pre-apply check against isolated baseline/candidate copies.
 * No write targets the supplied checkout, and temporary workspaces are removed in finally.
 */
export async function runPreApplyChecks({
  config,
  checkoutDir = config?.repository?.checkout,
  session,
  sourcePath,
  baseBytes,
  candidateBytes,
  operation,
  trustPolicy,
  trustSubject,
  targetPage,
  targetSlug,
  renderer = renderPinnedQuartz,
  maxWitnessChars = MAX_VISIBLE_WITNESS_CHARS,
}, dependencyOverrides = {}) {
  const relativePath = sourcePathValue(
    sourcePath ?? session?.relativePath ?? operation?.source?.relativePath,
  );
  const base = baseBytes === undefined
    ? canonicalBase64Bytes(session?.source?.bytesBase64, 'session.source.bytesBase64')
    : exactBytes(baseBytes, 'baseBytes');
  const normalizedOperation = correctionFromOperation(operation);
  let candidate;
  if (candidateBytes === undefined) {
    try {
      candidate = applyCorrection(base, normalizedOperation.correction);
    } catch (error) {
      fail('operation-reproduction-failed', 'the bound operation could not produce candidate bytes', {
        cause: error?.code ?? error?.name ?? 'unknown',
      });
    }
  } else {
    candidate = exactBytes(candidateBytes, 'candidateBytes');
  }
  const effectiveSlug = targetSlug ?? session?.slug ?? operation?.source?.slug;
  const exactTargetPage = targetPage === undefined
    ? targetPageForSlug(effectiveSlug)
    : renderedPagePath(targetPage);
  const createTemporaryRoot = dependencyOverrides.createTemporaryRoot
    ?? (() => mkdtemp(path.join(os.tmpdir(), 'cyberbaser-owner-alpha-checks-')));
  const cleanupTemporaryRoot = dependencyOverrides.cleanupTemporaryRoot
    ?? ((root) => rm(root, { recursive: true, force: true }));
  const copy = dependencyOverrides.copyCheckout ?? copyCheckout;
  const render = rendererFunction(renderer);

  let temporaryRoot = null;
  let sourceSnapshot = null;
  let result = null;
  let primaryError = null;
  let sourceStateError = null;
  let cleanupError = null;

  try {
    const checkoutRoot = await realpath(checkoutDir);
    const sourceFile = mappedFile(checkoutRoot, relativePath);
    sourceSnapshot = await readFile(sourceFile);
    if (!sourceSnapshot.equals(base)) {
      fail('source-base-mismatch', 'the real checkout source no longer equals the bound base bytes');
    }
    const effectiveTrustPolicy = trustPolicy === undefined
      ? await defaultTrustPolicy(checkoutRoot)
      : trustPolicy;
    const immediate = runImmediateChecks({
      baseBytes: base,
      candidateBytes: candidate,
      operation,
      sourcePath: relativePath,
      config,
      trustPolicy: effectiveTrustPolicy,
      trustSubject,
    });

    temporaryRoot = await createTemporaryRoot();
    const baselineVault = path.join(temporaryRoot, 'baseline', 'vault');
    const candidateVault = path.join(temporaryRoot, 'candidate', 'vault');
    const baselineProjection = path.join(temporaryRoot, 'baseline', 'projection');
    const candidateProjection = path.join(temporaryRoot, 'candidate', 'projection');
    const baselineRenderer = path.join(temporaryRoot, 'baseline', 'renderer');
    const candidateRenderer = path.join(temporaryRoot, 'candidate', 'renderer');
    const baselineSite = path.join(temporaryRoot, 'baseline', 'site');
    const candidateSite = path.join(temporaryRoot, 'candidate', 'site');

    await copy(checkoutRoot, baselineVault);
    await copy(checkoutRoot, candidateVault);
    const baselineSource = mappedFile(baselineVault, relativePath);
    const candidateSource = mappedFile(candidateVault, relativePath);
    const [baselineCopy, candidateCopy] = await Promise.all([
      readFile(baselineSource),
      readFile(candidateSource),
    ]);
    if (!baselineCopy.equals(base) || !candidateCopy.equals(base)) {
      fail('isolated-copy-mismatch', 'baseline and candidate copies must begin byte-identical to the bound base');
    }
    await writeFile(candidateSource, candidate);
    if (!(await readFile(baselineSource)).equals(base)) {
      fail('baseline-copy-changed', 'the isolated baseline source changed while preparing the candidate');
    }

    const baselinePublication = await runPublicationChecks({
      vaultDir: baselineVault,
      outputDir: baselineProjection,
      sourcePath: relativePath,
    });
    const candidatePublication = await runPublicationChecks({
      vaultDir: candidateVault,
      outputDir: candidateProjection,
      sourcePath: relativePath,
    });
    if (!sameStrings(baselinePublication.published, candidatePublication.published)) {
      fail('published-set-changed', 'the candidate changed the selected publication file set');
    }

    const baselineRender = await render({
      lane: 'baseline',
      contentDir: baselineProjection,
      outputDir: baselineSite,
      workspaceDir: baselineRenderer,
      ownerOrigin: `http://${config.listen.host}:${config.listen.port}`,
      targetPage: exactTargetPage,
    });
    const candidateRender = await render({
      lane: 'candidate',
      contentDir: candidateProjection,
      outputDir: candidateSite,
      workspaceDir: candidateRenderer,
      ownerOrigin: `http://${config.listen.host}:${config.listen.port}`,
      targetPage: exactTargetPage,
    });
    const rendered = await runRenderChecks({
      baselineSiteDir: baselineSite,
      candidateSiteDir: candidateSite,
      targetPage: exactTargetPage,
      basePath: basePathFromConfig(config),
      oldText: decodeUtf8(normalizedOperation.expectedOldBytes, 'operation expected old bytes'),
      newText: decodeUtf8(normalizedOperation.replacementBytes, 'operation replacement bytes'),
      maxWitnessChars,
    });

    result = {
      ok: true,
      immediate,
      publication: {
        baseline: baselinePublication,
        candidate: candidatePublication,
        selectedSetUnchanged: true,
      },
      renderer: {
        baseline: plain(baselineRender ?? {}),
        candidate: plain(candidateRender ?? {}),
        isolatedWorkspaces: true,
      },
      rendered,
      sourceCheckout: {
        sourceBytesUnchanged: true,
        writePerformed: false,
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (sourceSnapshot !== null) {
      try {
        const current = await readFile(mappedFile(await realpath(checkoutDir), relativePath));
        if (!current.equals(sourceSnapshot)) {
          sourceStateError = new OwnerAlphaError(
            'source-checkout-changed',
            'the real checkout source changed during pre-apply checks',
          );
        }
      } catch (error) {
        sourceStateError = error instanceof OwnerAlphaError
          ? error
          : new OwnerAlphaError('source-recheck-failed', 'the real checkout source could not be rechecked', {
            cause: error?.code ?? 'unknown',
          });
      }
    }
    if (temporaryRoot !== null) {
      try {
        await cleanupTemporaryRoot(temporaryRoot);
      } catch (error) {
        cleanupError = new OwnerAlphaError(
          'temporary-cleanup-failed',
          'isolated pre-apply workspaces could not be removed',
          { cause: error?.message ?? 'unknown' },
        );
      }
    }
  }

  if (sourceStateError) throw sourceStateError;
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  result.cleanup = { completed: true, temporaryWorkspacesRetained: false };
  return deepFreeze(result);
}
