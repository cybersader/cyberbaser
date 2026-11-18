// Test-only helpers. Display diagnostics are closed labels/booleans/counters.
// Exact owned fixture/process identity stays in a separate private recovery file.
import { open, lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export async function recordRehearsalOwnership(fixture, captureDir, label) {
  try {
    if (!['main', 'broad', 'table', 'sourceOnly', 'removedBlock'].includes(label)) throw new Error();
    const root = fixture.root;
    if (!path.isAbsolute(root) || path.dirname(root) !== await realpath(os.tmpdir())
      || !path.basename(root).startsWith('owner-publication-rehearsal-')) throw new Error();
    const metadata = await lstat(root, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== BigInt(process.getuid())
      || (metadata.mode & 0o777n) !== 0o700n || await realpath(root) !== root) throw new Error();
    if (fixture.projectRoot !== path.join(root, 'owner-runtime') || fixture.checkout !== path.join(root, 'delivery')
      || fixture.remote !== path.join(root, 'local-only.git')) throw new Error();
    const directory = await lstat(captureDir);
    if (!path.isAbsolute(captureDir) || !directory.isDirectory() || directory.isSymbolicLink()
      || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700
      || await realpath(captureDir) !== captureDir) throw new Error();
    const owner = new URL(fixture.ownerOrigin); const reader = new URL(fixture.readerOrigin);
    if ([owner, reader].some((url) => url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      || Number(owner.port) < 1024 || Number(owner.port) > 65534 || Number(reader.port) !== Number(owner.port) + 1) throw new Error();
    const stat = await readFile('/proc/self/stat', 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    if (Number(stat.slice(0, stat.indexOf(' '))) !== process.pid || !/^\d+$/u.test(fields[19])) throw new Error();
    const cgroup = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find((line) => line.startsWith('0::'))?.slice(3);
    if (!cgroup?.startsWith('/')) throw new Error();
    const record = { schemaVersion: 1, label, recordedUtc: new Date().toISOString(),
      fixture: { root, realpath: await realpath(root), device: metadata.dev.toString(), inode: metadata.ino.toString(),
        uid: Number(metadata.uid), mode: '0700', projectRoot: fixture.projectRoot, checkout: fixture.checkout, remote: fixture.remote },
      listeners: { host: '127.0.0.1', ownerPort: Number(owner.port), readerPort: Number(reader.port),
        binding: 'both fixture listeners bound before return; no pre-existing listener reused' },
      runner: { pid: process.pid, ppid: Number(fields[1]), startTicks: fields[19], cwd: await realpath('/proc/self/cwd'),
        executable: await realpath('/proc/self/exe'), cmdlineSha256: createHash('sha256').update(await readFile('/proc/self/cmdline')).digest('hex'),
        cgroup: { path: cgroup, classification: 'shared-or-unproven', stoppable: false } } };
    const file = path.join(captureDir, `ownership-${label}.json`); const bytes = `${JSON.stringify(record, null, 2)}\n`;
    const handle = await open(file, 'wx', 0o600);
    try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    const written = await lstat(file);
    if (!written.isFile() || written.isSymbolicLink() || written.uid !== process.getuid() || (written.mode & 0o777) !== 0o600) throw new Error();
    return { label, path: file, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { throw new Error('rehearsal-ownership-record-failed'); }
}
export const INLINE_CHECKPOINT_IDS = Object.freeze([
  'outside-inline-checkpoints', 'inline-text-verified', 'candidate-projection-derived',
  'clean-mode-selected', 'clean-projection-read', 'clean-projection-verified', 'clean-deletions-hidden',
  'clean-screenshot-captured', 'navigation-focus-observer-installed', 'navigation-restore-clicked',
  'navigation-restore-asserted', 'navigation-focus-observer-removed', 'monochrome-applied',
  'monochrome-cues-read', 'monochrome-thickness-asserted', 'monochrome-insertion-asserted',
  'monochrome-deletion-asserted', 'monochrome-screenshot-captured', 'monochrome-restored',
  'inline-proof-recorded', 'quiet-toolbar', 'details-open', 'details-focus',
  'details-resize', 'details-close', 'fallback-native', 'explicit-details', 'broad-details-limit',
]);
export const CHECKPOINT_FAILURE_CLASSES = Object.freeze([
  'execution-context-destroyed', 'target-closed', 'handle-disposed', 'assertion', 'other',
]);
// Read only in memory and emit ONE fixed label, never exception text or stack.
export function checkpointFailureClass(error) {
  try {
    if (error === null || typeof error !== 'object') return 'other';
    const message = typeof error.message === 'string' ? error.message : '';
    if (/Execution context was destroyed|Cannot find context with specified id/u.test(message)) return 'execution-context-destroyed';
    if (/Target page, context or browser has been closed|Target closed/u.test(message)) return 'target-closed';
    if (/JSHandle is disposed|handle (?:has been |is )disposed/iu.test(message)) return 'handle-disposed';
    if (error.name === 'AssertionError' || /^expect\(/u.test(message)) return 'assertion';
  } catch { /* Unknown objects/getters must not leak or replace the failure. */ }
  return 'other';
}
export function safeCheckpoints(evidence, persist) {
  evidence.checkpoints = []; evidence.failedCheckpointId = null; evidence.failedCheckpointClass = null;
  return async (id, operation) => {
    if (!INLINE_CHECKPOINT_IDS.includes(id)) throw new Error('invalid-rehearsal-checkpoint');
    const record = { id, ok: false }; evidence.checkpoints.push(record); evidence.diagnosticSubstage = id;
    await persist();
    try {
      const result = await operation(); record.ok = true; await persist(); return result;
    } catch (error) {
      record.failureClass = checkpointFailureClass(error);
      if (evidence.failedCheckpointId === null) {
        evidence.failedCheckpointId = id; evidence.failedCheckpointClass = record.failureClass;
      }
      await persist();
      // The assertion/operation still fails; never serialize its arbitrary error.
      throw new Error(`synthetic rehearsal checkpoint failed: ${id}`);
    }
  };
}
// Distinguish rejected evaluate (null result) from completed evaluation whose
// equality proof is false. Copy only the closed result schema into evidence.
export async function observeRestoration(evidence, evaluate) {
  evidence.cssomRestorationEvaluateCompleted = false;
  evidence.cssomColourRemovalRestored = null;
  evidence.cssomRestorationClauses = null;
  const result = await evaluate();
  evidence.cssomRestorationEvaluateCompleted = true;
  const booleans = ['ok', 'cssTextEqual', 'hasAttributeEqual', 'perPropertyEqual'];
  const counts = ['nodeCount', 'cssTextEqualCount', 'hasAttributeEqualCount', 'perPropertyEqualCount',
    'propertyCount', 'valueEqualCount', 'priorityEqualCount'];
  if (!result || booleans.some((key) => typeof result[key] !== 'boolean')
    || counts.some((key) => !Number.isSafeInteger(result[key]) || result[key] < 0)) throw new Error('invalid-restoration-result');
  evidence.cssomRestorationClauses = Object.fromEntries([...booleans, ...counts].map((key) => [key, result[key]]));
  evidence.cssomColourRemovalRestored = result.ok;
  return evidence.cssomRestorationClauses;
}
export const CSP_DIRECTIVE_NAMES = Object.freeze(['default-src', 'script-src', 'script-src-elem', 'script-src-attr',
  'style-src', 'style-src-elem', 'style-src-attr', 'img-src', 'font-src', 'connect-src', 'object-src',
  'base-uri', 'form-action', 'frame-ancestors', 'frame-src', 'worker-src', 'media-src', 'manifest-src']);
export function safeDirectiveCounts(input) {
  return Object.fromEntries(CSP_DIRECTIVE_NAMES.map((name) => [name,
    Number.isSafeInteger(input?.[name]) && input[name] >= 0 ? Math.min(input[name], 1000) : 0]));
}
// Self-contained functions below are serialized into the fresh fixture document.
// No URL, sample, source file, HTML, exception text or authentication data is read.
export function installCspCounter() {
  const names = ['default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem',
    'style-src-attr', 'img-src', 'font-src', 'connect-src', 'object-src', 'base-uri', 'form-action',
    'frame-ancestors', 'frame-src', 'worker-src', 'media-src', 'manifest-src'];
  const counts = Object.fromEntries(names.map((name) => [name, 0]));
  Object.defineProperty(globalThis, '__publicationRehearsalCspCounts', { configurable: true, value: counts });
  document.addEventListener('securitypolicyviolation', (event) => {
    const name = event.effectiveDirective;
    if (Object.hasOwn(counts, name)) counts[name] = Math.min(1000, counts[name] + 1);
  });
}
/** The JSHandle keeps exact node identities and snapshots in the browser only.
 * cssText snapshots preserve ALL declarations, including shorthand longhands and
 * priorities. Nothing is persisted; restore also preserves absent vs empty style.
 * This changes existing element CSSOM, never creates an inline stylesheet. */
export function colourlessScope(article) {
  const saved = [...article.querySelectorAll('ins,del')].map((node) => ({ node,
    hadStyle: node.hasAttribute('style'), cssText: node.style.cssText,
    properties: [...node.style].map((name) => ({ name, value: node.style.getPropertyValue(name), priority: node.style.getPropertyPriority(name) })) }));
  const restore = () => {
    for (const entry of saved) {
      entry.node.style.cssText = entry.cssText;
      if (entry.hadStyle) continue;
      // The style attribute is synchronized lazily from the inline declarations.
      // A removal issued while those declarations are still unsynchronized is
      // undone, because the pending state is serialized back into the attribute
      // afterwards. Reading the attribute forces that synchronization first, so
      // the removal then applies to a materialized attribute. The read-and-remove
      // is bounded and stops as soon as the attribute is genuinely absent.
      for (let attempt = 0; attempt < 2 && entry.node.hasAttribute('style'); attempt += 1) {
        entry.node.removeAttribute('style');
      }
    }
    // Evaluate EVERY original equality, retaining only fixed booleans/counts.
    const clauses = saved.map((entry) => ({
      cssTextEqual: entry.node.style.cssText === entry.cssText,
      hasAttributeEqual: entry.node.hasAttribute('style') === entry.hadStyle,
      properties: entry.properties.map((property) => ({
        valueEqual: entry.node.style.getPropertyValue(property.name) === property.value,
        priorityEqual: entry.node.style.getPropertyPriority(property.name) === property.priority,
      })),
    }));
    const cssTextEqualCount = clauses.filter((entry) => entry.cssTextEqual).length;
    const hasAttributeEqualCount = clauses.filter((entry) => entry.hasAttributeEqual).length;
    const perPropertyEqualCount = clauses.filter((entry) => entry.properties.every((property) => property.valueEqual && property.priorityEqual)).length;
    const properties = clauses.flatMap((entry) => entry.properties);
    const result = { nodeCount: saved.length, cssTextEqualCount, hasAttributeEqualCount, perPropertyEqualCount,
      propertyCount: properties.length, valueEqualCount: properties.filter((property) => property.valueEqual).length,
      priorityEqualCount: properties.filter((property) => property.priorityEqual).length,
      cssTextEqual: cssTextEqualCount === saved.length, hasAttributeEqual: hasAttributeEqualCount === saved.length,
      perPropertyEqual: perPropertyEqualCount === saved.length };
    return { ...result, ok: result.cssTextEqual && result.hasAttributeEqual && result.perPropertyEqual };
  };
  try {
    for (const { node } of saved) {
      node.style.setProperty('color', 'inherit', 'important');
      node.style.setProperty('background', 'none', 'important');
      node.style.setProperty('text-decoration-color', 'currentColor', 'important');
    }
  } catch { restore(); throw new Error('colourless-cssom-apply-failed'); }
  return { applied: saved.length > 0, restore,
    cues: () => saved.map(({ node }) => { const css = getComputedStyle(node);
      return { tag: node.tagName === 'INS' ? 'INS' : 'DEL', line: css.textDecorationLine, thickness: css.textDecorationThickness }; }) };
}
