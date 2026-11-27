#!/usr/bin/env bun
import { rm } from 'node:fs/promises';
import { createOwnerCommands } from '../src/core/commands.js';
import { createBootstrapPrincipalAdapter } from '../src/core/principal.js';
import { OwnerAlphaError } from '../src/errors.js';
import { foldedWorkspaceDigest, spellWorkspaceCandidate } from '../src/owner-publication.js';
import { readWorkspaceCapture as readCapture } from '../src/workspace-capture.js';
import { MAPPING, publicationFixture } from './publication-fixture.js';
const usage = 'bun apps/owner-alpha/test/workspace-capture-rehearsal.js <before.json> <after.json>';
const mapping = { mappingId: MAPPING.id };

function refuse(code) {
  throw new OwnerAlphaError(code, 'workspace capture rehearsal refused');
}

function byteFacts(bytes) {
  const text = bytes.toString('utf8');
  const crlf = [...text.matchAll(/\r\n/gu)].length;
  const lf = [...text.matchAll(/\n/gu)].length - crlf;
  return `${crlf} CRLF, ${lf} LF; final newline ${text.endsWith('\n') ? 'yes' : 'no'}`;
}

async function main(args) {
  let root;
  let fixture;
  let bound = false;
  try {
    if (args.length !== 2) return console.error(`Usage: ${usage}`), 2;
    const before = await readCapture(args[0]);
    const after = await readCapture(args[1]);
    if (before.source !== after.source || before.path !== after.path) refuse('capture-source-mismatch');
    const foldedBefore = foldedWorkspaceDigest(before.text);
    const foldedAfter = foldedWorkspaceDigest(after.text);
    fixture = await publicationFixture({ workspace: true, localGit: true, base: before.text,
      sourceIdentity: before.source, sourcePath: before.path,
      onRoot(value) { root = value; console.log(`Temporary root: ${JSON.stringify(root)}`); } });
    fixture.renderGate.resolve({ ok: true, synthetic: true,
      rendered: { witnesses: { old: 'simulated old text', new: 'simulated new text' } } });
    fixture.setSource(before.text, 0);
    const baseline = await fixture.runtime.bindWorkspaceBaseline(mapping);
    if (baseline.foldedTextDigest !== foldedBefore) refuse('rehearsal-baseline-mismatch');
    bound = true;

    const principalAdapter = createBootstrapPrincipalAdapter();
    const principal = principalAdapter.fromSession({ id: fixture.config.owner.identity,
      sessionId: 'synthetic-local-rehearsal', authenticatedAt: Date.now() });
    const commands = createOwnerCommands({ config: fixture.config, projectRoot: fixture.root,
      publication: fixture.runtime, principalAdapter });
    await commands.readPublicationStatus(mapping, principal);
    fixture.setSource(after.text, 0);
    const prepared = await commands.preparePublication({ ...mapping, expectedDigest: foldedAfter }, principal);
    if (prepared.outcome === 'unchanged') {
      console.log('Bound: yes. No content change; nothing to publish.');
      console.log(`Delivery unchanged: ${byteFacts(Buffer.from(before.text))}; leading BOM ${before.text.startsWith('\uFEFF') ? 'present' : 'absent'}.`);
      return 0;
    }
    const intent = { draftId: prepared.summary.draftId };
    const receipt = await commands.readPublicationReceipt(intent, principal);
    if (receipt.state !== 'prepared' || receipt.foldedTextDigest !== foldedAfter) refuse('rehearsal-receipt-mismatch');
    await commands.publish(intent, principal);
    const result = await fixture.completion;
    if (result.state !== 'completed') refuse(result.failure?.code ?? 'rehearsal-job-incomplete');
    const status = await commands.readPublicationStatus(mapping, principal);
    if (status.live?.verified !== true || status.live.foldedTextDigest !== foldedAfter) refuse('rehearsal-live-evidence-mismatch');
    const git = fixture.actualGit;
    const commit = await git(fixture.remote, ['rev-parse', 'refs/heads/main'], { encoding: 'utf8' });
    if (commit === baseline.commit || commit !== await git(fixture.root, ['rev-parse', 'HEAD'], { encoding: 'utf8' })) refuse('rehearsal-commit-mismatch');
    const deliveryPath = fixture.mapping.relativePath;
    const beforeBytes = await git(fixture.root, ['show', `${baseline.commit}:${deliveryPath}`]);
    const afterBytes = await git(fixture.remote, ['show', `${commit}:${deliveryPath}`]);
    const { operation } = prepared.draft.prepared;
    const replacementLength = Buffer.from(operation.replacementBytesBase64, 'base64').length;
    if (!beforeBytes.equals(Buffer.from(before.text))
      || !afterBytes.equals(Buffer.from(spellWorkspaceCandidate(beforeBytes, after.text)))
      || !afterBytes.subarray(0, operation.start).equals(beforeBytes.subarray(0, operation.start))
      || !afterBytes.subarray(operation.start + replacementLength).equals(beforeBytes.subarray(operation.end))) {
      refuse('rehearsal-delivery-bytes-mismatch');
    }
    const diff = await git(fixture.root, ['diff', '--no-ext-diff', '--no-textconv', '--text', '--no-color',
      baseline.commit, commit, '--', deliveryPath]);
    console.log('Bound: yes. Published one exact change to a disposable local Git remote.');
    console.log(`Commit: ${commit}`);
    console.log('Build/render: simulated. Deployment: simulated. Live check: simulated. Local rebuild: simulated.');
    console.log(`Vault terminator spelling preserved; ${byteFacts(beforeBytes)} → ${byteFacts(afterBytes)}.`);
    console.log(`Leading BOM preserved (${before.text.startsWith('\uFEFF') ? 'present' : 'absent'}). Bytes outside the splice are unchanged.`);
    process.stdout.write(diff);
    return 0;
  } catch (error) {
    const code = error instanceof OwnerAlphaError && /^[a-z][a-z0-9-]{0,79}$/u.test(error.code)
      ? error.code : 'rehearsal-failed';
    const repeats = error instanceof OwnerAlphaError ? error.details?.repeats : undefined;
    const reason = code === 'workspace-text-repeated'
      ? Number.isSafeInteger(repeats) && repeats >= 2 ? ` The workspace note repeats the vault text ${repeats} times.` : ' The workspace note repeats the vault text.'
      : code === 'workspace-properties-invalid' ? ' The workspace note has invalid frontmatter structure.' : '';
    console.error(`Bound: ${bound ? 'yes' : 'no'}. Refused: ${code}.${reason}`);
    return 1;
  } finally {
    await fixture?.completion?.catch(() => {});
    if (root) await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch { console.error('Refused: rehearsal-cleanup-failed.'); process.exitCode = 1; }
}
