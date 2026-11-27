// Run as the node account inside the node service's view of the disk: one
// owner Save job, applied and committed by the node, pushed by the publisher
// over its socket. Checks are stubbed (they are not what this test is about);
// everything after them is the real pipeline.
//   BUN_BE_BUN=1 /opt/cyberbaser/bin/cyberbaser save-job.mjs <config> <job-id>
import { loadOwnerAlphaConfig } from '/src/apps/owner-alpha/src/config.js';
import { createSaveHandler } from '/src/apps/owner-alpha/src/pipeline.js';

const [configFile, jobId] = process.argv.slice(2);
const save = createSaveHandler({
  config: await loadOwnerAlphaConfig(configFile),
  projectRoot: '/opt/cyberbaser',
  dependencies: {
    async runPreApplyChecks() { return { ok: true, rendered: { witnesses: { old: 'old sentence.', new: 'new sentence.' } } }; },
  },
});
const result = await save.startEdit({
  jobId, renderer: { relativePath: 'docs/page.md', slug: 'docs/page' },
  editedText: '# Page\n\nSynthetic new sentence.\n',
}).completion;
process.stdout.write(`${JSON.stringify({ state: result?.state ?? result?.status ?? null, ok: result?.ok ?? null })}\n`);
