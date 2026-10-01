import { buildResearchCandidate } from '../research-change-set.js';
import { baseFixture, intent, nonExecutableExactChange, operation, projection } from './helpers.js';

function offset(base, text, occurrence = 0) {
  let start = -1;
  for (let index = 0; index <= occurrence; index += 1) start = base.indexOf(text, start + 1);
  if (start < 0) throw new Error(`missing target text: ${text}`);
  return { start: Buffer.byteLength(base.slice(0, start)), end: Buffer.byteLength(base.slice(0, start + text.length)) };
}
function build({ fixtureId, title, summary, rationale, category, path, baseText, specs, pageLabel, notes = [] }) {
  const operationsInput = specs.map((spec, index) => {
    const range = spec.insertAfter !== undefined
      ? (() => { const found = offset(baseText, spec.insertAfter); return { start: found.end, end: found.end }; })()
      : offset(baseText, spec.oldText, spec.occurrence ?? 0);
    return { operationId: `research-${index + 1}`, label: spec.label, start: range.start, end: range.end, replacement: spec.replacementText };
  });
  const built = buildResearchCandidate(Buffer.from(baseText), operationsInput);
  const viewOperations = built.operations.map((item, index) => operation({
    operationId: item.operationId, label: item.label, path, start: item.start, end: item.end,
    oldText: item.oldText, replacementText: item.replacement,
    contextBefore: specs.find((spec) => spec.label === item.label)?.contextBefore ?? '',
    contextAfter: specs.find((spec) => spec.label === item.label)?.contextAfter ?? '',
  }));
  return baseFixture({
    fixtureId,
    supportLevel: 'target-v2-research',
    evidenceClass: 'static-design-only',
    operationCount: viewOperations.length,
    intent: intent({ title, summary, rationale, category, declaredScope: `${viewOperations.length} exact changes in one existing page`, provenance: { title: 'contributor-authored', summary: 'contributor-authored' } }),
    sourceFiles: [{ path, exists: true, baseText, candidateText: built.candidate.toString('utf8') }],
    exactChange: nonExecutableExactChange({ operations: viewOperations, reason: 'Target capability research only. No proposal-v2 canonical artifact, parser, queue acceptance, or executable product contract exists.' }),
    reviewProjection: projection({ pageLabel, title, titleProvenance: 'Contributor-authored title', fallbackTitle: `Proposal for ${pageLabel}`, summary, identityDisclosure: 'Contributor-authored title and summary retained with provenance.', provenance: { title: 'contributor-authored' } }),
    notes: ['Target capability', 'Static design only', `${viewOperations.length} exact changes · one atomic decision · partial approval unavailable`, ...notes],
  });
}

export const targetV2Fixtures = Object.freeze([
  build({
    fixtureId: 'v2-setup-three-places',
    title: 'Bring the setup guide forward for version 4.2',
    summary: 'Update the prerequisite, repair the validation command, and add a compatibility note as one atomic proposal.',
    rationale: 'Readers following the current guide install an unsupported runtime and run a command removed in 4.2.',
    category: 'clarification',
    path: 'guides/setup.md', pageLabel: 'Setup guide',
    baseText: '# Setup\n\n## Prerequisites\n\nInstall Runtime 3.9 or newer.\n\n## Verify\n\nRun `cyberbaser doctor --legacy` and compare the [compatibility table](/reference/old-compatibility/).\n\n## Continue\n\nOpen the workspace after verification.\n',
    specs: [
      { oldText: 'Runtime 3.9', replacementText: 'Runtime 4.2', label: 'Update the supported runtime prerequisite', contextBefore: 'Install ', contextAfter: ' or newer.' },
      { oldText: '`cyberbaser doctor --legacy` and compare the [compatibility table](/reference/old-compatibility/)', replacementText: '`cyberbaser doctor` and compare the [compatibility table](/reference/compatibility/)', label: 'Repair the validation command and reference', contextBefore: 'Run ', contextAfter: '.' },
      { insertAfter: 'Run `cyberbaser doctor --legacy` and compare the [compatibility table](/reference/old-compatibility/).', replacementText: '\n\nRuntime 4.2 remains compatible with workspaces created by 4.0 and 4.1.', label: 'Add the compatibility note', contextBefore: 'Run `cyberbaser doctor --legacy` and compare the [compatibility table](/reference/old-compatibility/).', contextAfter: '\n\n## Continue' },
    ],
  }),
  build({
    fixtureId: 'v2-restructure-installation-section',
    title: 'Restructure the installation section around supported paths',
    summary: 'Rename the section, replace two paragraphs, and remove an obsolete aside without serializing the full document.',
    rationale: 'The section currently mixes retired pilot steps with the two supported installation paths.',
    category: 'restructure', path: 'guides/installation.md', pageLabel: 'Installation guide',
    baseText: '# Installation\n\n## Quick install\n\nInstall the package globally, then copy the example configuration into your home directory.\n\nFor isolated environments, use the same global install and set a different cache path.\n\n> Pilot aside: container users must request a temporary registry key from the migration desk.\n\n## Verify the installation\n\nRun the local health check before opening a workspace.\n',
    specs: [
      { oldText: '## Quick install', replacementText: '## Choose an installation path', label: 'Rename the installation heading' },
      { oldText: 'Install the package globally, then copy the example configuration into your home directory.', replacementText: 'For a workstation, install the package in the project and keep the tracked configuration beside the workspace.', label: 'Replace the workstation instructions' },
      { oldText: 'For isolated environments, use the same global install and set a different cache path.', replacementText: 'For an isolated environment, use the local OCI bundle and mount only the documented workspace paths.', label: 'Replace the isolated-environment instructions' },
      { oldText: '\n\n> Pilot aside: container users must request a temporary registry key from the migration desk.', replacementText: '', label: 'Remove the obsolete pilot aside' },
    ],
    notes: ['Section-level comprehension uses bounded comparison units, not whole-document line alignment.'],
  }),
]);
