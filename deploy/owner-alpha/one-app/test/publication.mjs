// Lab-only helper, bundled outside the image. The signing key never crosses
// from the fixture viewer to the node; only a signed job intent does.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadOwnerAlphaConfig } from '../../../../apps/owner-alpha/src/config.js';
import { loadDurableJob, transitionDurableJob } from '../../../../apps/owner-alpha/src/job-state.js';
import { attachOwnerApproval, createSaveHandler, pipelineArtifactPaths } from '../../../../apps/owner-alpha/src/pipeline.js';
import { requestPublication } from '../../../../apps/owner-alpha/src/publisher/client.js';
import { ownerRequest } from '../../../../apps/owner-alpha/src/publisher/owner-control.js';
import { storeContextFromConfig } from '../../../../apps/owner-alpha/src/store.js';
import { createDevice, enroll, signPublish } from '../../../../apps/owner-alpha/test/signed-device.js';

const socketPath = '/run/cyberbaser-publisher/publisher.sock';
const state = '/tmp/one-app-device.json';
const keyId = 'one-app-device';
const configFile = '/var/lib/cyberbaser/config/owner-alpha.json';
const projectRoot = '/opt/cyberbaser';
const note = 'Garden/Note.md';
const prior = 'This is a synthetic public-to-the-fixture note.';
const edited = 'This is the signed synthetic update.';
const [command, jobId] = process.argv.slice(2);
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

try {
  switch (command) {
    case 'enroll': {
      const enrollPort = Number(process.env.ONE_APP_TEST_PORT ?? 4317) + 2;
      const page = await fetch(`http://127.0.0.1:${enrollPort}/enroll`, { signal: AbortSignal.timeout(3000) });
      if (!page.ok) throw new Error('enrollment-page-denied');
      const html = await page.text();
      const code = /Or type this code: <strong[^>]*>([A-Z0-9-]+)<\/strong>/u.exec(html)?.[1];
      if (!code) throw new Error('enrollment-page-missing-code');
      const device = createDevice({ keyId, label: 'Synthetic signing device' });
      await enroll(device, { socketPath, code });
      writeFileSync(state, JSON.stringify({ seed: device.seed.toString('base64'), publisher: device.publisher }), { mode: 0o600, flag: 'wx' });
      out({ ok: true });
      break;
    }
    case 'status': {
      const { publisher } = JSON.parse(readFileSync(state, 'utf8'));
      const keys = await ownerRequest({ socketPath, op: 'keys' });
      const challenge = await ownerRequest({ socketPath, op: 'challenge' });
      out({ ok: challenge.publisher === publisher && keys.body.keys.filter((key) => key.revokedAt === null).map((key) => key.keyId).join(',') === keyId });
      break;
    }
    case 'sign': {
      const [commit, repository, remote, branch] = process.argv.slice(3);
      const { seed, publisher } = JSON.parse(readFileSync(state, 'utf8'));
      const device = createDevice({ keyId, seed: Buffer.from(seed, 'base64') });
      device.publisher = publisher;
      out(await signPublish(device, { socketPath, commit, repository, remote, branch }));
      break;
    }
    case 'unsigned': {
      const config = await loadOwnerAlphaConfig(configFile);
      const context = storeContextFromConfig(config, projectRoot);
      const text = readFileSync(path.join(config.repository.checkout, note), 'utf8');
      if (!text.includes(prior)) throw new Error('fixture-note-mismatch');
      // Like the native save-job fixture: stub pre-apply renderer/check
      // witnesses only. Source apply, Git, job evidence and push are real.
      const save = createSaveHandler({ config, projectRoot, dependencies: {
        async runPreApplyChecks() { return { ok: true, rendered: { witnesses: { old: prior, new: edited } } }; },
      } });
      const pending = save.startEdit({ jobId, renderer: { relativePath: note, slug: 'Garden/Note' }, editedText: text.replace(prior, edited) });
      await pending.accepted;
      const result = await pending.completion;
      const commit = JSON.parse(readFileSync(path.join(context.storeRoot, pipelineArtifactPaths(jobId).committed), 'utf8')).result.commit;
      const job = await loadDurableJob(context, jobId);
      out({ state: result.state, reason: job.history.at(-1)?.reason ?? null, commit });
      break;
    }
    case 'submit-signed': {
      const config = await loadOwnerAlphaConfig(configFile);
      const context = storeContextFromConfig(config, projectRoot);
      const job = await loadDurableJob(context, jobId);
      if (job.state !== 'awaiting-approval') throw new Error('job-not-awaiting-approval');
      const record = JSON.parse(readFileSync('/tmp/lab-approval', 'utf8'));
      await attachOwnerApproval({ context, config, jobId, record });
      await transitionDurableJob(context, jobId, 'pushing', { at: new Date().toISOString(), reason: 'owner-approval-attached' });
      // Leave the durable job at the real recoverable boundary: the publisher
      // owns the checked push and its receipt. The node will recover it.
      const result = await requestPublication({ socketPath, jobId, timeoutMs: 60_000 });
      out({ ok: true, result });
      break;
    }
    default: throw new Error('invalid-lab-command');
  }
} catch (error) {
  // Do not log Git subprocess arguments, config, HTTP bodies or signatures.
  const reason = error?.code ?? error?.message;
  out({ ok: false, code: typeof reason === 'string' && /^[a-z0-9-]{1,80}$/i.test(reason) ? reason : 'fixture-command-failed' });
  process.exitCode = 1;
}
