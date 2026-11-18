import { expect, test } from 'bun:test';
import vm from 'node:vm';
import { readFile, mkdtemp, mkdir, rm, lstat, symlink, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { recordRehearsalOwnership, safeCheckpoints, safeDirectiveCounts, installCspCounter, colourlessScope, observeRestoration, checkpointFailureClass,
  CHECKPOINT_FAILURE_CLASSES, CSP_DIRECTIVE_NAMES, INLINE_CHECKPOINT_IDS } from './publication-rehearsal-harness.js';

test('closed checkpoints persist false before entry and true only after successful completion', async () => {
  const evidence = {}; const writes = []; const checkpoint = safeCheckpoints(evidence, async () => writes.push(structuredClone(evidence)));
  expect(await checkpoint('clean-projection-verified', async () => 45)).toBe(45);
  expect(writes[0].checkpoints).toEqual([{ id: 'clean-projection-verified', ok: false }]);
  expect(writes.at(-1).checkpoints).toEqual([{ id: 'clean-projection-verified', ok: true }]);
  expect(evidence.failedCheckpointId).toBe(null);
  await expect(checkpoint('arbitrary-secret-id', async () => {})).rejects.toThrow('invalid-rehearsal-checkpoint');
  expect(JSON.stringify(evidence)).not.toContain('arbitrary-secret-id');
});

test('failed assertions/operations stay failed with fixed checkpoint and no raw exception disclosure', async () => {
  const evidence = {}; const checkpoint = safeCheckpoints(evidence, async () => {});
  await expect(checkpoint('monochrome-cues-read', async () => { throw new Error('private-arbitrary-error'); }))
    .rejects.toThrow('synthetic rehearsal checkpoint failed: monochrome-cues-read');
  expect(evidence.failedCheckpointId).toBe('monochrome-cues-read');
  expect(evidence.checkpoints).toEqual([{ id: 'monochrome-cues-read', ok: false, failureClass: 'other' }]);
  expect(evidence.failedCheckpointClass).toBe('other');
  await checkpoint('monochrome-restored', async () => true);
  expect(evidence.failedCheckpointId).toBe('monochrome-cues-read');
  expect(JSON.stringify(evidence)).not.toContain('private-arbitrary-error');
});

test('CSP counts accept only allowlisted directive names and bounded safe integers', () => {
  const result = safeDirectiveCounts({ 'style-src-elem': 2, 'script-src': 1001, 'img-src': -1, 'font-src': 'unsafe', blockedURI: 'private-url' });
  expect(Object.keys(result)).toEqual([...CSP_DIRECTIVE_NAMES]);
  expect(result['style-src-elem']).toBe(2); expect(result['script-src']).toBe(1000);
  expect(result['img-src']).toBe(0); expect(result['font-src']).toBe(0);
  expect(JSON.stringify(result)).not.toContain('private-url');
  expect(safeDirectiveCounts(null)['style-src']).toBe(0);
});

test('serialized browser CSP listener reads only effectiveDirective, never URI/source/sample', () => {
  let listener; const context = vm.createContext({ document: { addEventListener(name, fn) { expect(name).toBe('securitypolicyviolation'); listener = fn; } } });
  vm.runInContext(`(${installCspCounter.toString()})()`, context);
  const accesses = []; const event = new Proxy({}, { get(_, name) { accesses.push(name); if (name === 'effectiveDirective') return 'style-src-elem'; throw new Error('unsafe-field-read'); } });
  listener(event); expect(accesses).toEqual(['effectiveDirective']);
  listener({ effectiveDirective: 'private-unknown-directive' });
  const result = JSON.parse(vm.runInContext('JSON.stringify(globalThis.__publicationRehearsalCspCounts)', context));
  expect(Object.keys(result)).toEqual([...CSP_DIRECTIVE_NAMES]); expect(result['style-src-elem']).toBe(1);
  expect(JSON.stringify(result)).not.toContain('private-unknown-directive');
});

// Minimal deterministic CSSStyleDeclaration model, not a browser/CSP substitute.
class Style {
  constructor(text = '') { this.cssText = text; this.failApply = false; }
  [Symbol.iterator]() { return this.values.keys(); }
  get cssText() { return [...this.values].map(([name, item]) => `${name}: ${item.value}${item.priority ? ' !important' : ''};`).join(' '); }
  set cssText(text) { this.values = new Map(); for (const declaration of text.split(';').filter((part) => part.trim())) {
    const colon = declaration.indexOf(':'); const name = declaration.slice(0, colon).trim(); const raw = declaration.slice(colon + 1).trim();
    this.values.set(name, { value: raw.replace(/\s*!important$/u, ''), priority: raw.endsWith('!important') ? 'important' : '' });
  } }
  setProperty(name, value, priority = '') { if (this.failApply && name === 'background') throw new Error('opaque-style-error'); this.values.set(name, { value, priority }); }
  getPropertyValue(name) { return this.values.get(name)?.value ?? ''; }
  getPropertyPriority(name) { return this.values.get(name)?.priority ?? ''; }
}
function node(tagName, text = null) { return { tagName, style: new Style(text ?? ''), had: text !== null,
  hasAttribute() { return this.had || this.style.values.size > 0; }, removeAttribute(name) { expect(name).toBe('style'); this.had = false; this.style.cssText = ''; } }; }
function browserScope(nodes) {
  const context = vm.createContext({ article: { querySelectorAll(selector) { expect(selector).toBe('ins,del'); return nodes; } },
    getComputedStyle: (value) => ({ textDecorationLine: value.tagName === 'INS' ? 'underline' : 'line-through', textDecorationThickness: '2px' }) });
  return vm.runInContext(`(${colourlessScope.toString()})(article)`, context);
}
test('CSSOM colour removal restores all prior declarations, priorities, order, empty and absent style exactly', () => {
  const nodes = [node('INS', 'color: purple !important; background-image: url(example); background-color: black; text-decoration-color: gold !important;'), node('DEL'), node('INS', '')];
  const before = nodes.map((value) => ({ cssText: value.style.cssText, had: value.hasAttribute('style') }));
  const scope = browserScope(nodes); expect(scope.applied).toBe(true);
  for (const value of nodes) { expect(value.style.getPropertyValue('color')).toBe('inherit'); expect(value.style.getPropertyPriority('color')).toBe('important'); }
  expect(scope.cues().map((cue) => cue.line)).toEqual(['underline', 'line-through', 'underline']);
  const restored = scope.restore();
  expect(restored).toEqual({ ok: true, nodeCount: 3, cssTextEqualCount: 3, hasAttributeEqualCount: 3, perPropertyEqualCount: 3,
    propertyCount: 4, valueEqualCount: 4, priorityEqualCount: 4, cssTextEqual: true, hasAttributeEqual: true, perPropertyEqual: true });
  expect(nodes.map((value) => ({ cssText: value.style.cssText, had: value.hasAttribute('style') }))).toEqual(before);
  expect(scope.restore()).toEqual(restored);
});

test('partial CSSOM application failure restores all snapshots before a fixed safe failure', () => {
  const nodes = [node('INS', 'color: blue !important;'), node('DEL', 'background-color: pink;')];
  const snapshot = (value) => ({ cssText: value.style.cssText, hadStyle: value.hasAttribute('style'),
    properties: [...value.style].map((name) => [name, value.style.getPropertyValue(name), value.style.getPropertyPriority(name)]) });
  const before = nodes.map(snapshot); nodes[1].style.failApply = true;
  expect(() => browserScope(nodes)).toThrow('colourless-cssom-apply-failed');
  expect(nodes.map(snapshot)).toEqual(before);
});

test('failure classification emits only closed labels, including hostile unknown errors', () => {
  const cases = [
    [new Error('Execution context was destroyed, private-url'), 'execution-context-destroyed'],
    [new Error('Cannot find context with specified id private-id'), 'execution-context-destroyed'],
    [new Error('Target page, context or browser has been closed private-url'), 'target-closed'],
    [new Error('JSHandle is disposed private-url'), 'handle-disposed'],
    [Object.assign(new Error('private-assertion-text'), { name: 'AssertionError' }), 'assertion'],
    [new Error('expect(received).toBe(expected) private-value'), 'assertion'],
    [new Error('private-unknown'), 'other'], ['private-string', 'other'], [null, 'other'],
    [new Proxy({}, { get() { throw new Error('private-getter'); } }), 'other'],
  ];
  for (const [error, label] of cases) {
    const result = checkpointFailureClass(error); expect(result).toBe(label); expect(CHECKPOINT_FAILURE_CLASSES).toContain(result);
    expect(JSON.stringify({ result })).not.toContain('private');
  }
});

test('failed cleanup cannot obscure the first checkpoint failure or classification', async () => {
  const evidence = {}; const checkpoint = safeCheckpoints(evidence, async () => {});
  const run = async () => {
    try {
      await checkpoint('monochrome-thickness-asserted', async () => { expect(false).toBe(true); });
    } finally {
      await checkpoint('monochrome-restored', async () => { throw new Error('Target page, context or browser has been closed private-url'); });
    }
  };
  await expect(run()).rejects.toThrow('synthetic rehearsal checkpoint failed: monochrome-restored');
  expect(evidence.failedCheckpointId).toBe('monochrome-thickness-asserted'); expect(evidence.failedCheckpointClass).toBe('assertion');
  expect(evidence.checkpoints).toEqual([
    { id: 'monochrome-thickness-asserted', ok: false, failureClass: 'assertion' },
    { id: 'monochrome-restored', ok: false, failureClass: 'target-closed' },
  ]);
  expect(JSON.stringify(evidence)).not.toContain('private-url');
});

test('restoration false result is distinguishable from rejected evaluate without changing its assertion', async () => {
  const result = { ok: false, nodeCount: 1, cssTextEqual: false, hasAttributeEqual: true, perPropertyEqual: true,
    cssTextEqualCount: 0, hasAttributeEqualCount: 1, perPropertyEqualCount: 1, propertyCount: 0, valueEqualCount: 0, priorityEqualCount: 0,
    ignored: 'private-extra' };
  const returned = {}; const completedCheckpoint = safeCheckpoints(returned, async () => {});
  await expect(completedCheckpoint('monochrome-restored', async () => {
    await observeRestoration(returned, async () => result); expect(returned.cssomColourRemovalRestored).toBe(true);
  })).rejects.toThrow('synthetic rehearsal checkpoint failed: monochrome-restored');
  expect(returned.cssomRestorationEvaluateCompleted).toBe(true); expect(returned.cssomColourRemovalRestored).toBe(false);
  expect(returned.cssomRestorationClauses.cssTextEqualCount).toBe(0); expect(returned.failedCheckpointClass).toBe('assertion');
  expect(JSON.stringify(returned)).not.toContain('private-extra');
  const rejected = {}; const rejectedCheckpoint = safeCheckpoints(rejected, async () => {});
  await expect(rejectedCheckpoint('monochrome-restored', async () => {
    await observeRestoration(rejected, async () => { throw new Error('Execution context was destroyed private-url'); });
    expect(rejected.cssomColourRemovalRestored).toBe(true);
  })).rejects.toThrow('synthetic rehearsal checkpoint failed: monochrome-restored');
  expect(rejected.cssomRestorationEvaluateCompleted).toBe(false); expect(rejected.cssomColourRemovalRestored).toBe(null);
  expect(rejected.cssomRestorationClauses).toBe(null); expect(rejected.failedCheckpointClass).toBe('execution-context-destroyed');
  expect(JSON.stringify(rejected)).not.toContain('private-url');
});

test('restoration observation rejects malformed output and persists no arbitrary fields', async () => {
  const evidence = {};
  await expect(observeRestoration(evidence, async () => ({ ok: 'private-value', html: 'private-html' })))
    .rejects.toThrow('invalid-restoration-result');
  expect(evidence.cssomRestorationEvaluateCompleted).toBe(true); expect(evidence.cssomColourRemovalRestored).toBe(null);
  expect(evidence.cssomRestorationClauses).toBe(null); expect(JSON.stringify(evidence)).not.toContain('private');
});

for (const failure of ['cssText', 'attribute', 'value', 'priority']) {
  test(`restoration retains the exact ${failure} equality with closed clause diagnostics`, () => {
    const value = node('INS', 'color: purple !important;'); const scope = browserScope([value]);
    if (failure === 'cssText') {
      const descriptor = Object.getOwnPropertyDescriptor(Style.prototype, 'cssText');
      Object.defineProperty(value.style, 'cssText', { get: () => 'different', set(text) { descriptor.set.call(this, text); } });
    } else if (failure === 'attribute') value.hasAttribute = () => false;
    else if (failure === 'value') value.style.getPropertyValue = () => 'different';
    else value.style.getPropertyPriority = () => 'different';
    const result = scope.restore(); expect(result.ok).toBe(false); expect(result.nodeCount).toBe(1);
    expect(result.cssTextEqual).toBe(failure !== 'cssText'); expect(result.hasAttributeEqual).toBe(failure !== 'attribute');
    expect(result.perPropertyEqual).toBe(!['value', 'priority'].includes(failure));
    expect(result.valueEqualCount).toBe(failure === 'value' ? 0 : 1);
    expect(result.priorityEqualCount).toBe(failure === 'priority' ? 0 : 1);
  });
}

// Chromium under the owner CSP synchronizes the style attribute lazily. Observed
// in an isolated same-CSP fixture: CSSOM mutation leaves the attribute
// unsynchronized; any attribute read synchronizes it; a removal issued while
// unsynchronized is undone by that later serialization; a removal after
// synchronization sticks and repeating it is a no-op. The permissive `node`
// model above cannot express that state, which is why it missed the defect.
class LazyStyle extends Style {
  get cssText() { return super.cssText; }
  set cssText(text) { super.cssText = text; this.dirty = true; }
  setProperty(name, value, priority = '') { super.setProperty(name, value, priority); this.dirty = true; }
}
function lazyNode(tagName, text = null) {
  const style = new LazyStyle(text ?? ''); style.dirty = false;
  return { tagName, style, had: text !== null, removals: 0,
    hasAttribute(name) { expect(name).toBe('style');
      if (this.style.dirty) { this.style.dirty = false; this.had = true; }
      return this.had; },
    removeAttribute(name) { expect(name).toBe('style'); this.removals += 1;
      if (this.style.dirty) { this.style.dirty = false; this.had = true; return; }
      this.style.cssText = ''; this.style.dirty = false; this.had = false; } };
}

test('restoration removes a style attribute the document never had, against lazy attribute synchronization', () => {
  const absent = lazyNode('DEL'); const present = lazyNode('INS', 'color: purple !important;');
  const nodes = [absent, present];
  const before = nodes.map((value) => ({ cssText: value.style.cssText, had: value.hasAttribute('style') }));
  expect(before[0].had).toBe(false); expect(before[1].had).toBe(true);
  const scope = browserScope(nodes); expect(scope.applied).toBe(true);
  expect(absent.hasAttribute('style')).toBe(true);
  const restored = scope.restore();
  expect(restored).toEqual({ ok: true, nodeCount: 2, cssTextEqualCount: 2, hasAttributeEqualCount: 2, perPropertyEqualCount: 2,
    propertyCount: 1, valueEqualCount: 1, priorityEqualCount: 1, cssTextEqual: true, hasAttributeEqual: true, perPropertyEqual: true });
  expect(nodes.map((value) => ({ cssText: value.style.cssText, had: value.hasAttribute('style') }))).toEqual(before);
  // Bounded: the untouched node is never removed, the restored one at most twice.
  expect(present.removals).toBe(0); expect(absent.removals).toBeLessThanOrEqual(2);
  expect(scope.restore()).toEqual(restored);
});

// Shape-only filesystem fixture; ownership tests open no listener or browser.
async function ownershipFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-publication-rehearsal-'));
  const captureDir = await mkdtemp(path.join(os.tmpdir(), 'owner-publication-ownership-evidence-'));
  const fixture = { root, projectRoot: path.join(root, 'owner-runtime'), checkout: path.join(root, 'delivery'),
    remote: path.join(root, 'local-only.git'), ownerOrigin: 'http://127.0.0.1:46740', readerOrigin: 'http://127.0.0.1:46741' };
  for (const directory of [fixture.projectRoot, fixture.checkout, fixture.remote]) await mkdir(directory, { mode: 0o700 });
  Object.defineProperty(fixture, 'issueSignInUrl', { get() { throw new Error('private-auth-value-must-not-be-read'); } });
  return { fixture, captureDir, cleanup: async () => { await rm(root, { recursive: true }); await rm(captureDir, { recursive: true }); } };
}

test('ownership record is private, exact, closed-schema and never grants shared-cgroup cleanup', async () => {
  const setup = await ownershipFixture();
  try {
    const written = await recordRehearsalOwnership(setup.fixture, setup.captureDir, 'main');
    expect(written.path).toBe(path.join(setup.captureDir, 'ownership-main.json'));
    const bytes = await readFile(written.path); const record = JSON.parse(bytes);
    expect((await lstat(written.path)).mode & 0o777).toBe(0o600);
    expect(written.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(Object.keys(record)).toEqual(['schemaVersion', 'label', 'recordedUtc', 'fixture', 'listeners', 'runner']);
    const metadata = await lstat(setup.fixture.root, { bigint: true });
    expect(record.fixture).toEqual({ root: setup.fixture.root, projectRoot: setup.fixture.projectRoot,
      checkout: setup.fixture.checkout, remote: setup.fixture.remote, realpath: await realpath(setup.fixture.root),
      device: metadata.dev.toString(), inode: metadata.ino.toString(), uid: process.getuid(), mode: '0700' });
    expect(record.listeners.host).toBe('127.0.0.1'); expect(record.listeners.ownerPort).toBe(46740); expect(record.listeners.readerPort).toBe(46741);
    expect(record.runner.pid).toBe(process.pid); expect(record.runner.startTicks).toMatch(/^\d+$/u);
    expect(record.runner.cwd).toBe(await realpath(process.cwd())); expect(record.runner.cmdlineSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.runner.cgroup.classification).toBe('shared-or-unproven'); expect(record.runner.cgroup.stoppable).toBe(false);
    expect(Object.keys(record.runner)).toEqual(['pid', 'ppid', 'startTicks', 'cwd', 'executable', 'cmdlineSha256', 'cgroup']);
    expect(JSON.stringify(record)).not.toContain('private-auth'); expect(JSON.stringify(record)).not.toContain('issueSignInUrl');
  } finally { await setup.cleanup(); }
});

test('ownership write failure fails closed before browser continuation and never overwrites a prior record', async () => {
  const setup = await ownershipFixture(); let browserStarted = false;
  try {
    const file = path.join(setup.captureDir, 'ownership-main.json'); await writeFile(file, 'prior-private-evidence', { mode: 0o600 });
    const run = async () => { await recordRehearsalOwnership(setup.fixture, setup.captureDir, 'main'); browserStarted = true; };
    await expect(run()).rejects.toThrow('rehearsal-ownership-record-failed');
    expect(browserStarted).toBe(false); expect(await readFile(file, 'utf8')).toBe('prior-private-evidence');
  } finally { await setup.cleanup(); }
});

test('ownership validation refuses unknown labels, symlinked roots/evidence and nonpaired or credentialled origins', async () => {
  const setup = await ownershipFixture();
  try {
    const rootLink = path.join(setup.captureDir, 'root-link'); await symlink(setup.fixture.root, rootLink);
    const captureLink = path.join(setup.captureDir, 'capture-link'); await symlink(setup.captureDir, captureLink);
    for (const [fixture, directory, label] of [
      [setup.fixture, setup.captureDir, '../private-label'],
      [{ ...setup.fixture, root: rootLink }, setup.captureDir, 'main'],
      [setup.fixture, captureLink, 'main'],
      [{ ...setup.fixture, readerOrigin: 'http://127.0.0.1:46742' }, setup.captureDir, 'main'],
      [{ ...setup.fixture, ownerOrigin: 'http://private-auth@127.0.0.1:46740' }, setup.captureDir, 'main'],
    ]) await expect(recordRehearsalOwnership(fixture, directory, label)).rejects.toThrow('rehearsal-ownership-record-failed');
    await expect(lstat(path.join(setup.captureDir, 'ownership-main.json'))).rejects.toThrow();
  } finally { await setup.cleanup(); }
});

function browserOwnershipSites(source) {
  const uniquePosition = (text, needle) => {
    const parts = text.split(needle);
    if (parts.length !== 2) throw new Error('ownership assertion requires one unambiguous site');
    return parts[0].length;
  };
  const gate = "const browserTest = process.env.OWNER_ALPHA_PUBLICATION_REHEARSAL_BROWSER === '1' ? test : test.skip;";
  const start = "browserTest('headless browser rehearsal uses actual publication routes and real local-only Git effects', async () => {";
  const gatePosition = uniquePosition(source, gate);
  const startPosition = uniquePosition(source, start);
  if (gatePosition >= startPosition) throw new Error('ownership assertion requires the gated browser body');
  const tail = source.slice(startPosition + start.length);
  const endPosition = uniquePosition(tail, '\n});');
  if (tail.slice(endPosition + '\n});'.length).trim()) throw new Error('ownership assertion requires the complete final browser test');
  const region = tail.slice(0, endPosition);
  const sites = {
    mainCreate: 'fixture = await createPublicationRehearsal({ port: 46840 })',
    mainRecord: "await recordRehearsalOwnership(fixture, captureDir, 'main')",
    mainLaunch: 'browser = await chromium.launch({ headless: true });',
    alternateCreate: 'const alternate = await createPublicationRehearsal({ port: 46844, variation })',
    alternateRecord: 'await recordRehearsalOwnership(alternate, captureDir, variation)',
    alternateLaunch: 'alternateContext = await browser.newContext({ viewport:',
  };
  return Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, uniquePosition(region, site)]));
}

test('every browser fixture records ownership before any owned browser or context starts', async () => {
  const source = await readFile(new URL('./publication-rehearsal.test.js', import.meta.url), 'utf8');
  const sites = browserOwnershipSites(source);
  expect(sites.mainRecord).toBeGreaterThan(sites.mainCreate);
  expect(sites.mainRecord).toBeLessThan(sites.mainLaunch);
  expect(sites.alternateRecord).toBeGreaterThan(sites.alternateCreate);
  expect(sites.alternateRecord).toBeLessThan(sites.alternateLaunch);
});

test('ownership ordering ignores earlier launcher assertion strings and refuses missing or ambiguous browser sites', async () => {
  const source = await readFile(new URL('./publication-rehearsal.test.js', import.meta.url), 'utf8');
  const misleading = '// expect(launcher).toContain("browser = await chromium.launch({ headless: true });");\n';
  expect(browserOwnershipSites(misleading + source)).toEqual(browserOwnershipSites(source));
  const launch = 'browser = await chromium.launch({ headless: true });';
  expect(() => browserOwnershipSites(source.replace(launch, ''))).toThrow('one unambiguous site');
  expect(() => browserOwnershipSites(source.replace(launch, `${launch}\n${launch}`))).toThrow('one unambiguous site');
  const record = "await recordRehearsalOwnership(fixture, captureDir, 'main')";
  expect(() => browserOwnershipSites(source.replace(record, ''))).toThrow('one unambiguous site');
  expect(() => browserOwnershipSites(source + source)).toThrow('one unambiguous site');
});

test('harness retains source/CSP protection, all cue checks and exact endpoint comparison', async () => {
  const source = await readFile(new URL('./publication-rehearsal.test.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const ownerCsp = server.slice(server.indexOf('const OWNER_CSP'), server.indexOf('const READER_CSP'));
  expect(ownerCsp).toContain("style-src 'self'"); expect(ownerCsp).not.toContain('unsafe-inline');
  expect(source).not.toContain('addStyleTag'); expect(source).not.toContain('bypassCSP');
  expect(source).toContain("expect(cues.every((cue) => Number.parseFloat(cue.thickness) >= 2)).toBe(true)");
  expect(source).toContain("expect(cues.filter((cue) => cue.tag === 'INS').every((cue) => cue.line === 'underline')).toBe(true)");
  expect(source).toContain("expect(cues.filter((cue) => cue.tag === 'DEL').every((cue) => cue.line === 'line-through')).toBe(true)");
  expect(source).toContain("expect(await page.locator('#publication-review-announcement').textContent()).toContain('Changes shown.')");
  expect(source).toContain('expect(cleanBlocks).toEqual(candidateBlocks.map(plain))');
  expect(source).toContain('.md-frontmatter > .section-kicker');
  expect(source).toContain('candidateBytes.equals(Buffer.from(REHEARSAL_CANDIDATE))');
  expect(source).toContain('finally {'); expect(source).toContain("checkpoint('monochrome-restored'");
  expect(new Set(INLINE_CHECKPOINT_IDS).size).toBe(INLINE_CHECKPOINT_IDS.length);
});
