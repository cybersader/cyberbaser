import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { createEditSession, assertCheckoutReady, defaultGitRunner } from '../src/source.js';
import { defineStoreContext, prepareStore } from '../src/store.js';
import { createSaveHandler } from '../src/pipeline.js';
import { createOwnerPublicationRuntime, createPublicationSourceGuard } from '../src/owner-publication-runtime.js';

export const BASE = '# Synthetic page\n\nThe old value.\n';
export const EDITED = BASE.replace('old', 'new');
export const PRIVATE_ID = 'private-source-sentinel';
export const PRIVATE_PATH = 'Private-sentinel/Authoring.md';
export const MAPPING = { id: 'one-page', source: { identity: PRIVATE_ID, path: PRIVATE_PATH }, relativePath: 'Notes/Page.md', slug: 'Notes/page' };
export const cleanup = [];
export function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export async function command(root, args) {
  const proc = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (status) throw new Error(`synthetic Git command failed: ${stderr}`);
  return stdout.trim();
}
export async function publicationFixture({ trust = 'trusted: [example]\n', overrides = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publication-runtime-'));
  cleanup.push(root);
  await command(root, ['init', '-q', '-b', 'main']);
  await command(root, ['config', 'user.name', 'Synthetic Owner']);
  await command(root, ['config', 'user.email', 'synthetic@example.invalid']);
  const raw = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
  raw.repository.checkout = root;
  raw.repository.remote.url = 'https://github.com/example/fixture.git';
  raw.owner.identity = 'example'; raw.workflow.repository = 'example/fixture'; raw.live.baseUrl = 'https://example.github.io/fixture/';
  raw.ownerPublication = { enabled: true, mappings: [MAPPING] };
  const config = validateOwnerAlphaConfig(raw);
  await command(root, ['remote', 'add', 'origin', config.repository.remote.url]);
  await mkdir(path.join(root, 'Notes'));
  await writeFile(path.join(root, 'Notes/Page.md'), BASE);
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
  if (trust !== null) { await mkdir(path.join(root, '.cyberbaser')); await writeFile(path.join(root, '.cyberbaser/trust.yml'), trust); }
  await command(root, ['add', '.']);
  // Disposable repository created by this test, never the project or real content.
  await command(root, ['commit', '-q', '-m', 'synthetic fixture']);
  const head = await command(root, ['rev-parse', 'HEAD']);
  const git = (checkout, args, options) => args[0] === 'ls-remote'
    ? Promise.resolve(`${head}\trefs/heads/main`) : defaultGitRunner(checkout, args, options);
  const context = defineStoreContext({ projectRoot: root, workspaceRoot: path.join(root, config.workspace.root), storeRoot: path.join(root, config.workspace.store) });
  await prepareStore(context);
  let text = EDITED; let version = 7; let unavailable = false; let reads = 0;
  const readNote = async () => {
    reads += 1;
    if (unavailable) throw new Error(`${PRIVATE_ID} ${PRIVATE_PATH}`);
    const bytes = Buffer.from(text);
    return { ...MAPPING.source, version, text, bytesBase64: bytes.toString('base64'), byteLength: bytes.length,
      digest: `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:` };
  };
  const renderGate = deferred(); const completions = []; let renderCalls = 0;
  const dependencies = { assertCheckoutReady: (value) => assertCheckoutReady(value, { git }),
    runPreApplyChecks: async () => { renderCalls += 1; return renderGate.promise; },
    revalidateSource: createPublicationSourceGuard({ config, context, readNote }), ...overrides };
  const pipeline = createSaveHandler({ config, context, projectRoot: root, dependencies });
  let completion;
  const wrapped = { ...pipeline, startEdit(input) { const handle = pipeline.startEdit(input); completion = handle.completion; return handle; } };
  const runtime = createOwnerPublicationRuntime({ config, context, readNote, pipeline: wrapped,
    sourceSession: (input) => createEditSession({ ...input, git }),
    checkoutReady: dependencies.assertCheckoutReady,
    onCompletion: (outcome) => { completions.push(outcome); } });
  return { root, config, context, head, git, readNote, runtime, pipeline, dependencies, renderGate, completions,
    prepare: () => runtime.prepare({ mappingId: MAPPING.id }),
    setSource(value = EDITED, nextVersion = 8) { text = value; version = nextVersion; },
    setUnavailable(value = true) { unavailable = value; },
    get reads() { return reads; }, get renderCalls() { return renderCalls; }, get completion() { return completion; } };
}
