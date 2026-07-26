// The trust gate: turn a proposed change plus a trust policy into a review route.
//
// Rationale (research/option-space, Option 2): after the maintainer, the next
// contributor is the maintainer's own agents. For that class the moderation
// queue's job is verifying invariants, not judging intent, and every invariant
// here is mechanical: the OFM validator's verdict, diff size, file count,
// frontmatter keys, deletions, new-file location, and whether a source is cited.
// A human stranger still gets a human.
//
// Fail closed: an unknown author type, an unregistered agent, or a missing
// config never reaches auto-merge.
import { checkChange } from '@cyberbaser/ofm';
import yaml from 'js-yaml';

/** Routes, ordered least to most restrictive. Downgrades only ever move right. */
export const ROUTES = ['auto-merge', 'quick-review', 'full-review', 'reject'];

export const DEFAULT_CAPS = {
  lines: 60, // changed (added + removed) non-blank lines across the whole change
  files: 5,
  proseWords: 25, // net new prose words above which a source citation is expected
  typoLines: 6, // human typo-class ceiling
  typoWords: 10,
};

const worse = (a, b) => ROUTES[Math.max(ROUTES.indexOf(a), ROUTES.indexOf(b))];
const lower = (s) => String(s ?? '').toLowerCase();

/** Parse a `.cyberbaser/trust.yml` document. Returns null for anything unusable. */
export function parseConfig(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return normalizeConfig(yaml.load(text));
  } catch {
    return null;
  }
}

/** Fill in defaults. Returns null when the config is absent or not an object — the fail-closed path. */
export function normalizeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const list = (v) => (Array.isArray(v) ? v.map(lower) : []);
  return {
    trusted: list(config.trusted),
    agents: list(config.agents),
    caps: { ...DEFAULT_CAPS, ...(config.caps && typeof config.caps === 'object' ? config.caps : {}) },
    allowedNewFolders: Array.isArray(config.allowedNewFolders) ? config.allowedNewFolders.map(String) : [],
    frontmatterAllowlist: Array.isArray(config.frontmatterAllowlist) ? config.frontmatterAllowlist.map(String) : [],
  };
}

// --- line-level analysis -----------------------------------------------------

const splitLines = (s) => (typeof s === 'string' && s !== '' ? s.split('\n') : []);
const isFence = (l) => /^\s*(```|~~~)/.test(l);

/**
 * Multiset line diff, fence-aware. Order-insensitive on purpose: a moved line is
 * not a change, and this never has to reconstruct a patch — only measure one.
 */
function diffLines(before, after) {
  const pool = new Map();
  for (const l of splitLines(before)) pool.set(l, (pool.get(l) ?? 0) + 1);
  const added = [];
  let fence = false;
  for (const l of splitLines(after)) {
    if (isFence(l)) fence = !fence;
    const c = pool.get(l) ?? 0;
    if (c > 0) pool.set(l, c - 1);
    else added.push({ text: l, inFence: fence || isFence(l) });
  }
  const pool2 = new Map();
  for (const l of splitLines(after)) pool2.set(l, (pool2.get(l) ?? 0) + 1);
  const removed = [];
  fence = false;
  for (const l of splitLines(before)) {
    if (isFence(l)) fence = !fence;
    const c = pool2.get(l) ?? 0;
    if (c > 0) pool2.set(l, c - 1);
    else removed.push({ text: l, inFence: fence || isFence(l) });
  }
  return { added, removed };
}

const countable = (ls) => ls.filter((l) => l.text.trim() !== '');
const words = (ls) =>
  ls.filter((l) => !l.inFence && l.text.trim() !== '' && !/^\s*\|/.test(l.text))
    .reduce((n, l) => n + (l.text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length, 0);

// --- document-level analysis -------------------------------------------------

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

function frontmatter(src) {
  const m = typeof src === 'string' ? src.match(FM_RE) : null;
  if (!m) return { present: false, data: {}, ok: true };
  try {
    const data = yaml.load(m[1]);
    return { present: true, data: data && typeof data === 'object' ? data : {}, ok: true };
  } catch {
    return { present: false, data: {}, ok: false };
  }
}

/** Top-level frontmatter keys whose presence or value differs. */
function frontmatterChanges(before, after) {
  const b = frontmatter(before), a = frontmatter(after);
  if (!b.ok || !a.ok) return { keys: [], unparseable: true };
  const keys = new Set([...Object.keys(b.data), ...Object.keys(a.data)]);
  const changed = [];
  for (const k of keys) {
    if (JSON.stringify(b.data[k] ?? null) !== JSON.stringify(a.data[k] ?? null)) changed.push(k);
  }
  return { keys: changed, unparseable: false };
}

function headings(src) {
  const out = [];
  let fence = false;
  for (const l of splitLines(src)) {
    if (isFence(l)) { fence = !fence; continue; }
    if (!fence) {
      const m = l.match(/^(#{1,6})\s+(.*?)\s*$/);
      if (m) out.push(`${m[1].length}:${m[2]}`);
    }
  }
  return out.sort();
}

function linkTargets(src) {
  const s = typeof src === 'string' ? src : '';
  const out = [];
  for (const m of s.matchAll(/!?\[\[([^\]]+)\]\]/g)) out.push(`wiki:${m[1].split('|')[0].trim()}`);
  for (const m of s.matchAll(/\]\(([^)\s]+)/g)) out.push(`md:${m[1]}`);
  return out.sort();
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Minimal glob: `**` crosses separators, `*` and `?` do not. */
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (path, globs) => globs.some((g) => globToRe(g).test(path));

// --- the classifier ----------------------------------------------------------

/**
 * classify(change, config) -> { tier, route, reasons, checks }
 *
 * change: { author, authorType: 'human'|'agent'|'anonymous', files: [{ path, before, after, status }], meta }
 *   status: 'added' | 'modified' | 'removed' (falls back to inferring from before/after)
 * config: a parsed `.cyberbaser/trust.yml`, or null/undefined to exercise the fail-closed path.
 */
export function classify(change, config) {
  const cfg = normalizeConfig(config);
  if (!cfg) {
    return { tier: 'unknown', route: 'full-review', reasons: ['no-trust-config'], checks: {} };
  }

  const authorType = change?.authorType;
  const author = lower(change?.author);
  let tier;
  if (authorType === 'agent') tier = cfg.agents.includes(author) ? 'agent' : 'unregistered-agent';
  else if (authorType === 'human') tier = cfg.trusted.includes(author) ? 'trusted-human' : 'human';
  else if (authorType === 'anonymous') tier = 'anonymous';
  else tier = 'unknown';

  const files = Array.isArray(change?.files) ? change.files : [];
  if (files.length === 0) {
    return { tier, route: 'full-review', reasons: ['no-files-in-change'], checks: {} };
  }

  const checks = runChecks(files, cfg);
  const reasons = [];
  let route;

  if (tier === 'agent') {
    route = 'auto-merge';
    const down = (r, why) => { reasons.push(why); route = worse(route, r); };

    if (checks.ofm.verdict === 'damage') down('reject', 'ofm-damage');
    else if (checks.ofm.verdict === 'suspect') down('full-review', 'ofm-suspect');

    if (!checks.lines.ok) down('full-review', `diff-too-large:${checks.lines.changed}>${checks.lines.cap}`);
    if (!checks.files.ok) down('full-review', `too-many-files:${checks.files.count}>${checks.files.cap}`);
    if (checks.deletions.length) down('full-review', `file-deleted:${checks.deletions.length}`);
    if (checks.newFiles.disallowed.length) down('full-review', `new-file-outside-allowed-folders:${checks.newFiles.disallowed[0]}`);
    if (checks.frontmatter.unparseable) down('full-review', 'frontmatter-unparseable');
    for (const k of checks.frontmatter.disallowed) down('full-review', `frontmatter-key-not-allowlisted:${k}`);
    if (checks.structural.changed) down('quick-review', 'structural-change');
    // Soft gate: a factual-prose addition should cite something. Never a reject —
    // the classifier cannot tell a claim from a rewrite, only that prose arrived.
    if (checks.source.required && !checks.source.hasUrl) down('quick-review', 'no-source-cited');

    if (route === 'auto-merge') reasons.push('all-agent-gates-passed');
  } else if (tier === 'trusted-human') {
    route = checks.typoClass ? 'auto-merge' : 'quick-review';
    reasons.push(checks.typoClass ? 'trusted-typo-class' : 'trusted-contributor');
    if (checks.ofm.verdict === 'damage') { reasons.push('ofm-damage'); route = worse(route, 'full-review'); }
    else if (checks.ofm.verdict === 'suspect') { reasons.push('ofm-suspect'); route = worse(route, 'quick-review'); }
    if (checks.deletions.length) { reasons.push(`file-deleted:${checks.deletions.length}`); route = worse(route, 'full-review'); }
    if (checks.newFiles.disallowed.length) { reasons.push(`new-file-outside-allowed-folders:${checks.newFiles.disallowed[0]}`); route = worse(route, 'full-review'); }
  } else {
    route = 'full-review';
    reasons.push(
      tier === 'anonymous' ? 'anonymous-author'
        : tier === 'human' ? 'author-not-on-trusted-list'
          : tier === 'unregistered-agent' ? 'agent-not-registered'
            : 'unknown-author-type',
    );
    if (checks.ofm.verdict !== 'clean') reasons.push(`ofm-${checks.ofm.verdict}`);
  }

  return { tier, route, reasons, checks };
}

function runChecks(files, cfg) {
  const perFile = [];
  let changedLines = 0, addedWords = 0, removedWords = 0, hasUrl = false;
  const deletions = [], addedPaths = [], disallowedNew = [];
  const fmChanged = new Set(), fmDisallowed = new Set();
  let fmUnparseable = false, structural = false;
  const allow = cfg.frontmatterAllowlist.map(lower);

  for (const f of files) {
    const path = String(f?.path ?? '');
    const before = typeof f?.before === 'string' ? f.before : '';
    const after = typeof f?.after === 'string' ? f.after : '';
    const status = f?.status ?? (before === '' ? 'added' : after === '' ? 'removed' : 'modified');

    if (status === 'removed') { deletions.push(path); }
    if (status === 'added') {
      addedPaths.push(path);
      if (!matchesAny(path, cfg.allowedNewFolders)) disallowedNew.push(path);
    }

    const { added, removed } = diffLines(before, after);
    const nAdded = countable(added).length, nRemoved = countable(removed).length;
    changedLines += nAdded + nRemoved;
    addedWords += words(added);
    removedWords += words(removed);
    if (added.some((l) => /https?:\/\/\S/.test(l.text))) hasUrl = true;

    // The OFM verdict only means something for an edit to an existing document.
    let verdict = 'clean', findings = [];
    if (status === 'modified' && before !== '') {
      const r = checkChange(before, after);
      verdict = r.verdict;
      findings = r.findings;
    }

    const fm = frontmatterChanges(before, after);
    if (fm.unparseable) fmUnparseable = true;
    for (const k of fm.keys) {
      fmChanged.add(k);
      if (!allow.includes(lower(k))) fmDisallowed.add(k);
    }

    const headingsChanged = !sameList(headings(before), headings(after));
    const linksChanged = !sameList(linkTargets(before), linkTargets(after));
    if (status !== 'added' && (headingsChanged || linksChanged)) structural = true;

    perFile.push({ path, status, verdict, findings, added: nAdded, removed: nRemoved, headingsChanged, linksChanged });
  }

  const worstVerdict = perFile.some((f) => f.verdict === 'damage') ? 'damage'
    : perFile.some((f) => f.verdict === 'suspect') ? 'suspect' : 'clean';
  const netWords = Math.max(0, addedWords - removedWords);
  const caps = cfg.caps;

  const checks = {
    ofm: {
      verdict: worstVerdict,
      damaged: perFile.filter((f) => f.verdict === 'damage').map((f) => f.path),
      findings: perFile.flatMap((f) => f.findings.map((x) => ({ path: f.path, ...x }))).slice(0, 50),
    },
    lines: { changed: changedLines, cap: caps.lines, ok: changedLines <= caps.lines },
    files: { count: files.length, cap: caps.files, ok: files.length <= caps.files },
    deletions,
    newFiles: { added: addedPaths, disallowed: disallowedNew },
    frontmatter: { changed: [...fmChanged], disallowed: [...fmDisallowed], unparseable: fmUnparseable },
    structural: { changed: structural },
    source: { netWords, required: netWords >= caps.proseWords, hasUrl },
    perFile,
  };

  checks.typoClass =
    files.length === 1 &&
    perFile[0].status === 'modified' &&
    deletions.length === 0 &&
    addedPaths.length === 0 &&
    fmChanged.size === 0 &&
    !fmUnparseable &&
    !structural &&
    worstVerdict === 'clean' &&
    changedLines <= caps.typoLines &&
    netWords <= caps.typoWords;

  return checks;
}
