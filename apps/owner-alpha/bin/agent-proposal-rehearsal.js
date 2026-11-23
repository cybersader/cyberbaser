#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PINNED_QUARTZ_COMMIT, PINNED_QUARTZ_REF } from '../src/quartz-renderer.js';
import { readWorkspaceCapture } from '../src/workspace-capture.js';
import { agentProcessEnvironment } from './agent-propose.js';
import { generateKey } from './owner-alpha-keys.js';
import { runPublicationRehearsalLauncher } from './publication-rehearsal.js';
import { AGENT_REHEARSAL_DELIVERY_PATH, createSuggestionsFixture, startSuggestionsRehearsal } from './suggestions-rehearsal-fixture.js';

export const AGENT_LABEL = 'Workspace Draft Agent';
const defaultBefore = { source: 'synthetic-workspace', path: 'drafts/workspace-note.md',
  text: '---\ntitle: Workspace note\n---\n\n# Workspace note\n\nStore the notes in the blue folder.\n' };
const defaultAfter = { ...defaultBefore, text: defaultBefore.text.replace('blue folder', 'green binder') };

// This is not Quartz. Render enough inert, local HTML for the normal application
// path to exercise its checks and rebuild. The shared fixture labels it simulated.
async function renderFixture({ contentDir, outputDir, editLinkMode, ownerOrigin }) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  for (const file of ['index.md', AGENT_REHEARSAL_DELIVERY_PATH]) {
    const text = (await readFile(path.join(contentDir, file), 'utf8'))
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const slug = file.slice(0, -3);
    const editLink = editLinkMode === 'owner'
      ? `<a href="${ownerOrigin}/owner/in-place?relativePath=${encodeURIComponent(file)}&amp;slug=${encodeURIComponent(slug)}">Edit this page</a>` : '';
    await writeFile(path.join(outputDir, `${slug}.html`),
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Simulated build</title><main><p>Simulated build. Disposable local rehearsal only.</p><pre>${text}</pre>${editLink}</main></html>\n`);
  }
  return { renderer: 'quartz-cyberbase', revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF, synthetic: true };
}

export async function runAgentChild({ capture, checkout, key, socket }) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'agent-propose.js'),
    capture, AGENT_REHEARSAL_DELIVERY_PATH, checkout, key, socket], {
    cwd: path.dirname(capture), env: agentProcessEnvironment(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

// realQuartz renders the private site with the pinned Quartz (and its source
// provenance) instead of the inert simulated pages. It is slow; tests opt in.
// iroh: null (off), 'none' (direct loopback paths only), 'n0' (n0's public
// relay) or an http://127.0.0.1:<port>/ test relay turns on the node's Iroh
// carrier with a disposable state directory.
// publication: null, or { workspaceText } to turn on owner publication of the
// delivery note from a synthetic workspace copy (workspace/<delivery path>)
// that starts equal to the vault, is bound to it, then holds workspaceText.
export const PUBLICATION_MAPPING_ID = 'workspace-note';
export async function createAgentProposalRehearsal({ port = 46527, before = defaultBefore, after = defaultAfter, realQuartz = false, siteTitle = null, iroh = null, publication = null } = {}) {
  if (before.source !== after.source || before.path !== after.path) throw new Error('Capture files must describe the same note.');
  const fixture = await createSuggestionsFixture({ port, agentBase: before.text, siteTitle });
  try {
    const { root, config, git, checkout, remote } = fixture;
    const agent = path.join(root, 'agent');
    const snapshot = path.join(agent, 'snapshot');
    const capture = path.join(agent, 'capture.json');
    const key = path.join(agent, 'key.json');
    const socket = path.join(root, 'signed.sock');
    const registryFile = path.join(root, 'registry.json');
    await mkdir(agent, { mode: 0o700 });
    await git(root, ['clone', '-q', '--no-hardlinks', '--no-checkout', '--', remote, snapshot]);
    await git(snapshot, ['remote', 'remove', 'origin']);
    await git(snapshot, ['config', '--local', 'cyberbaser.repository', config.repository.remote.url]);
    await writeFile(capture, JSON.stringify(after), { mode: 0o600 });
    const entry = await generateKey({ label: AGENT_LABEL, kind: 'agent', grants: ['propose'], file: key });
    await writeFile(registryFile, JSON.stringify({ ownerId: config.owner.identity, entries: [entry] }), { mode: 0o600 });
    const irohState = path.join(root, 'iroh');
    if (iroh !== null) await mkdir(irohState, { mode: 0o700 });
    const workspaceDir = path.join(root, 'workspace');
    const mapping = { id: PUBLICATION_MAPPING_ID, source: { identity: 'synthetic-workspace', path: AGENT_REHEARSAL_DELIVERY_PATH, kind: 'workspace' },
      relativePath: AGENT_REHEARSAL_DELIVERY_PATH, slug: AGENT_REHEARSAL_DELIVERY_PATH.slice(0, -3) };
    let workspaceVersion = 1;
    const readAuthoringNote = async () => {
      const bytes = await readFile(path.join(workspaceDir, AGENT_REHEARSAL_DELIVERY_PATH));
      return { identity: mapping.source.identity, path: mapping.source.path, version: workspaceVersion, text: bytes.toString('utf8'),
        bytesBase64: bytes.toString('base64'), byteLength: bytes.length, digest: `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:` };
    };
    if (publication !== null) {
      await mkdir(workspaceDir, { mode: 0o700 });
      await writeFile(path.join(workspaceDir, AGENT_REHEARSAL_DELIVERY_PATH), before.text, { mode: 0o600 });
    }
    await writeFile(fixture.configFile, JSON.stringify({ ...config, deviceRegistryFile: registryFile, signedRequestSocket: socket,
      ...(publication === null ? {} : { ownerPublication: { enabled: true, mappings: [mapping] } }),
      ...(iroh === null ? {} : { iroh: { enabled: true, stateDirectory: irohState, relay: iroh, ...(iroh !== 'n0' ? { bindAddress: '127.0.0.1:0' } : {}) } }) }), { mode: 0o600 });
    const runtime = await startSuggestionsRehearsal(fixture, { ...(realQuartz ? {} : { renderer: renderFixture, simulatedRender: true }),
      ...(publication === null ? {} : { readAuthoringNote }) });
    if (publication !== null) {
      // The owner's explicit bind of the workspace copy to the vault, then the
      // workspace receives the newer text (as a sync would).
      const { bindWorkspaceBaseline } = await import('../src/owner-publication-store.js');
      const { storeContextFromConfig } = await import('../src/store.js');
      const { loadOwnerAlphaConfig } = await import('../src/config.js');
      const loaded = await loadOwnerAlphaConfig(fixture.configFile);
      await bindWorkspaceBaseline({ context: storeContextFromConfig(loaded, fixture.projectRoot), config: loaded,
        mappingId: PUBLICATION_MAPPING_ID, readNote: readAuthoringNote });
      await writeFile(path.join(workspaceDir, AGENT_REHEARSAL_DELIVERY_PATH), publication.workspaceText, { mode: 0o600 });
      workspaceVersion += 1;
    }
    const result = await runAgentChild({ capture, checkout: snapshot, key, socket });
    if (result.code !== 0) throw new Error(`Agent submission failed (${/^[a-z-]+$/u.test(result.stderr) ? result.stderr : 'unknown-refusal'}).`);
    if (result.stdout.startsWith('Unchanged;')) throw new Error('The captures are unchanged; nothing was submitted.');
    const { queueId } = JSON.parse(result.stdout);
    const issueSignInUrl = () => `${runtime.ownerOrigin}/owner/bootstrap?token=${runtime.issueBootstrap()}`;
    let verified = false;
    return {
      ...fixture, agent: { capture, checkout: snapshot, key, socket }, queueId, entry, issueSignInUrl, runtime,
      panelUrl: `${runtime.ownerOrigin}/owner/review`,
      instructions: [
        `Submitted ${queueId} for ${AGENT_REHEARSAL_DELIVERY_PATH} as ${AGENT_LABEL}.`,
        result.stderr ? 'Open the proposal and Approve. This edit touches properties, so Apply to page is unavailable.'
          : 'In the isolated Proposals inbox, open the proposal, Approve, then choose Apply to page and watch the simulated publication job.',
        'Quit and remove the temporary vault: Ctrl-C or q then Enter.',
      ],
      async verify() {
        const login = await fetch(issueSignInUrl(), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
        if (login.status !== 303 || !cookie) throw new Error('Local sign-in did not succeed.');
        const request = (route) => fetch(`${runtime.ownerOrigin}${route}`, { headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        const [list, detail, inbox] = await Promise.all([request('/api/review'), request(`/api/review/${queueId}`), request('/owner/review')]);
        const item = (await list.json()).actionable?.find(({ summary }) => summary.queueId === queueId);
        if (!list.ok || !detail.ok || !inbox.ok || item?.summary?.submitter?.label !== AGENT_LABEL
          || !(await inbox.text()).includes(`From ${AGENT_LABEL}, one of your agents`)
          || (await readFile(path.join(checkout, AGENT_REHEARSAL_DELIVERY_PATH), 'utf8')) !== before.text) {
          throw new Error('The signed proposal was not visible as an unapplied change in the real owner inbox.');
        }
        await detail.body?.cancel();
        verified = true;
      },
      async cleanup() {
        await fixture.cleanup();
        const gone = await lstat(root).then(() => false, (error) => error?.code === 'ENOENT');
        if (!gone) throw new Error('Temporary directory remained.');
        if (verified) console.log(`Verified ${queueId} in the owner inbox as ${AGENT_LABEL}; temporary directory removed.`);
      },
    };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

async function main(args) {
  const files = [];
  let port = 46527; let verifyOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--headless') verifyOnly = true;
    else if (args[i] === '--port' && /^\d+$/u.test(args[i + 1] ?? '')) port = Number(args[++i]);
    else if (!args[i].startsWith('--')) files.push(args[i]);
    else throw new Error('Unknown argument.');
  }
  if (![0, 2].includes(files.length)) throw new Error('Expected two capture files, or none.');
  const [before, after] = await Promise.all(files.map(readWorkspaceCapture));
  await runPublicationRehearsalLauncher({ options: { port, openBrowser: !verifyOnly }, verifyOnly,
    createFixture: () => createAgentProposalRehearsal({ port, before, after }) });
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch {
    console.error('Agent proposal rehearsal could not complete. Use review:agent-proposal [--headless] [--port NUMBER] [before.json after.json].');
    process.exitCode = 1;
  }
}
