// Realistic disposable corpus for the maintainer checkpoint of the real
// four-mode owner review. The launcher seeds these pages into a temporary
// checkout and submits each proposal through the real account-free intake, so
// the owner sees genuine Lane B evidence rather than hand-built fixtures.
//
// Everything here is synthetic-mechanical research data. It is not a proposal
// schema, a fixture contract, or product evidence, and it creates no authority.
// The `expects` block on each proposal is asserted by
// `apps/owner-alpha/test/review-checkpoint-corpus.test.js`, so the checkpoint
// pack in the canonical docs cannot claim a fixture exercises something it
// does not.

import { validateOwnerAlphaConfig } from '../src/index.js';

export const CHECKPOINT_REPOSITORY = 'https://forge.example:8443/owner/wiki.git';

const RETENTION_BEFORE = 'Daily backups are retained for thirty days, and the first backup from each month becomes a monthly archive. Monthly archives normally remain available for one year from their creation date. The current wording also includes archives named in an open restoration request, but it does not explain what happens when the request remains active beyond the archive’s normal expiry date. Restoration work can span several review cycles, especially when an owner must compare historical configuration, exported assets, and version records before closing the request. Operators therefore need one explicit rule that prevents routine retention cleanup from removing evidence while that work is still open.';
const RETENTION_AFTER = 'Daily backups are retained for thirty days, and the first backup from each month becomes a monthly archive. Monthly archives normally remain available for one year from their creation date. If an open restoration request names an archive, that archive is held until the request closes, even when its normal retention date passes. The hold applies only to the archives listed in the request and does not extend unrelated backup sets. Restoration work can span several review cycles while an owner compares historical configuration, exported assets, and version records. After the owner closes the request and retains its final receipt, the affected archives return to the ordinary cleanup schedule.';

const PILOT_NOTICE = '\n\n> Pilot notice: During the June pilot, owners must email the migration desk before each test. This temporary process ended on 30 June.';

const REMOVAL_BEFORE = 'Remove access as soon as a reviewer confirms it is no longer needed. Do not batch removals until the end of the quarter.';
const REMOVAL_AFTER = 'Remove access as soon as a reviewer confirms it is no longer needed, and record the removal in the same entry that raised it. Do not batch removals until the end of the quarter: a delayed removal and a missed removal look identical to anyone auditing the trail later. When an account still needs emergency access, say so in the entry and name the person who will re-check it next quarter, so that the exception stays visible instead of quietly becoming permanent.';

export const CHECKPOINT_PAGES = Object.freeze([
  {
    path: 'handbook/backup-retention.md',
    text: `# Backup retention\n\n${RETENTION_BEFORE}\n\n## Recovery checks\n\nTest one restoration every quarter.\n`,
  },
  {
    path: 'research/2025-contributor-survey.md',
    text: '# 2025 contributor survey\n\nThe survey closed on 14 March after responses from 184 maintainers. Results are used as directional evidence, not a representative population estimate.\n\nSource notes remain in the private research archive.\n',
  },
  {
    path: 'handbook/onboarding-checklist.md',
    text: '# Onboarding checklist\n\n1. Read the [setup guide](/handbook/old-setup/).\n2. Ask an owner to confirm access.\n3. Keep the receipt for the completed handoff.\n',
  },
  {
    path: 'guides/migration.md',
    text: `# Migration guide\n\nUse the staged migration steps below.${PILOT_NOTICE}\n\n## Prepare\n\nExport a current manifest before migration.\n`,
  },
  {
    path: 'handbook/incident-response.md',
    text: '---\ntitle: Incident response handbook\nreviewed: 2025-10-15\nowner: Resilience team\n---\n\n# Incident response handbook\n\nUse the current escalation matrix.\n',
  },
  {
    path: 'handbook/quarterly-access-review.md',
    text: `# Quarterly access review\n\nEvery quarter the owning team confirms that each account, integration, and shared credential still needs the access it holds. The review protects two things at once: the confidentiality of member data, and the ability of on-call engineers to act during an incident without asking for permissions they should already hold.\n\n## Before the review\n\nExport the current access list from the directory, the forge, and the deployment provider. Record the export time and the exact revision of the policy you compared against. A review that cites a policy revision is far easier to re-check later than a review that cites only a date.\n\nAsk each team lead to confirm the people on their list. A lead who cannot confirm an account within five working days should say so explicitly, rather than letting the entry pass by silence.\n\n## During the review\n\nWork through the list one entry at a time. For each entry record the account, the access it holds, the stated justification, and the reviewer. Entries that changed since the previous quarter also carry a short note explaining what changed and who approved it.\n\nShared credentials follow the same path, but they additionally need a named owner. A shared credential without a named owner is treated as unowned and is scheduled for rotation whether or not anyone still uses it.\n\n## Removing access\n\n${REMOVAL_BEFORE}\n\n## After the review\n\nPublish the completed review to the internal handbook and keep the export files beside it. The published review is the durable record; a spreadsheet on one reviewer's laptop is not.\n\nSchedule the next review before closing the current one. Reviews scheduled at the end of the previous review happen; reviews scheduled soon do not.\n`,
  },
  {
    path: 'handbook/on-call-rota.md',
    text: '# On-call rota\n\nThe rota rotates weekly. Handover happens at 09:00 local time.\n\n> [!warning] Escalation\n> Page the secondary if the primary does not acknowledge within ten minutes.\n\n| Week | Primary | Secondary |\n|---|---|---|\n| 38 | Dana | Priya |\n| 39 | Priya | Malik |\n\nBefore handover, confirm the `pager-config.yml` matches [[Escalation policy]] and tick the checklist:\n\n- [ ] Alerts routed to the new primary\n- [ ] Runbook links verified\n\nQuestions about the rota go to the resilience channel.\n',
  },
]);

export const CHECKPOINT_PROPOSALS = Object.freeze([
  {
    id: 'retention-paragraph',
    label: 'Long paragraph rewrite',
    path: 'handbook/backup-retention.md',
    selection: { quote: RETENTION_BEFORE, prefix: '# Backup retention\n\n', suffix: '\n\n## Recovery checks' },
    replacement: RETENTION_AFTER,
    rationale: 'The current sentence can be read as deleting an archive while a restoration is still active. This wording states the hold, its scope, and when it ends.',
    evidence: [],
    exercises: 'Changes mode over one long paragraph; the changed passage is revealed as exact source while the rest of the page reads structurally; Compare with long prose on both sides.',
    expects: { blockKinds: ['heading', 'paragraph'], uninterpreted: [], inlineTypes: [], removal: true, addition: true },
  },
  {
    id: 'survey-numbers',
    label: 'Sourced factual correction',
    path: 'research/2025-contributor-survey.md',
    selection: { quote: 'The survey closed on 14 March after responses from 184 maintainers.', prefix: null, suffix: ' Results are used as directional evidence' },
    replacement: 'The survey closed on 18 March after responses from 214 maintainers.',
    rationale: 'The source spreadsheet has 214 accepted responses and a final close date of 18 March.',
    evidence: ['https://research.example/survey-2025'],
    exercises: 'A small factual change inside a sentence, with a contributor reference link; whether the changed numbers are findable in Changes and Proposed.',
    expects: { blockKinds: ['heading', 'paragraph'], uninterpreted: [], inlineTypes: [], removal: true, addition: true },
  },
  {
    id: 'checklist-link',
    label: 'Link destination inside an ordered list',
    path: 'handbook/onboarding-checklist.md',
    selection: { quote: '/handbook/old-setup/', prefix: 'Read the [setup guide](', suffix: ').' },
    replacement: '/handbook/getting-started/',
    rationale: 'The old setup route was replaced by the getting-started route.',
    evidence: [],
    exercises: 'A change inside a list item; the list renders structurally in Current and Proposed and the link is a non-navigating mark rather than a live link.',
    expects: { blockKinds: ['heading', 'ordered-list'], uninterpreted: [], inlineTypes: ['link'], removal: true, addition: true },
  },
  {
    id: 'pilot-notice-removal',
    label: 'Removal of an obsolete notice',
    path: 'guides/migration.md',
    selection: { quote: PILOT_NOTICE, prefix: 'Use the staged migration steps below.', suffix: '\n\n## Prepare' },
    replacement: '',
    rationale: 'The June pilot process has ended and now misdirects maintainers.',
    evidence: [],
    exercises: 'Pure deletion: Changes shows the struck passage, Proposed shows the page without it, and the dock still names the change without inventing replacement text.',
    expects: { blockKinds: ['heading', 'paragraph', 'quote'], uninterpreted: [], inlineTypes: [], removal: true, addition: false },
  },
  {
    id: 'frontmatter-review-date',
    label: 'Frontmatter value',
    path: 'handbook/incident-response.md',
    selection: { quote: 'reviewed: 2025-10-15', prefix: 'title: Incident response handbook\n', suffix: '\nowner: Resilience team' },
    replacement: 'reviewed: 2026-08-21',
    rationale: 'The owner completed the scheduled review on 21 August 2026.',
    evidence: [],
    exercises: 'A change inside YAML frontmatter; page metadata renders as a table in the untouched case and the changed block reveals exact source.',
    expects: { blockKinds: ['frontmatter', 'heading', 'paragraph'], uninterpreted: [], inlineTypes: [], removal: true, addition: true, changedBlockKind: 'frontmatter' },
  },
  {
    id: 'access-review-long-page',
    label: 'One paragraph in a long page',
    path: 'handbook/quarterly-access-review.md',
    selection: { quote: REMOVAL_BEFORE, prefix: '## Removing access\n\n', suffix: '\n\n## After the review' },
    replacement: REMOVAL_AFTER,
    rationale: 'The current paragraph states the rule but not the reason, so teams batch removals and undocumented exceptions become permanent.',
    evidence: [],
    exercises: 'The default-mode question: locating one changed paragraph in a five-section page, and whether full-width reading beats Compare here.',
    expects: { blockKinds: ['heading', 'paragraph'], uninterpreted: [], inlineTypes: [], removal: true, addition: true, minHeadings: 5 },
  },
  {
    id: 'rota-handover-sentence',
    label: 'Sentence on a page with unsupported constructs',
    path: 'handbook/on-call-rota.md',
    selection: { quote: 'Handover happens at 09:00 local time.', prefix: 'The rota rotates weekly. ', suffix: null },
    replacement: 'Handover happens at 09:00 UTC, and the outgoing engineer posts a short summary before leaving.',
    rationale: 'Local time is ambiguous across the rota, and the summary step is currently undocumented.',
    evidence: [],
    exercises: 'Semi-rendering limits: the callout, table, and task list on this page are shown as exact source labelled not interpreted here, and the wikilink is a non-navigating mark.',
    expects: { blockKinds: ['heading', 'paragraph', 'list'], uninterpreted: ['callout', 'table', 'task list'], inlineTypes: ['wikilink', 'code'], removal: true, addition: true },
  },
]);

export function checkpointOwnerConfig({ checkout, socketPath, host = '127.0.0.1', port = 4317 }) {
  return validateOwnerAlphaConfig({
    schemaVersion: 1,
    listen: { host, port },
    proposalReview: {
      enabled: true,
      socketPath,
      requestTimeoutMs: 5000,
      maxListEntries: 100,
    },
    repository: {
      checkout,
      remote: { name: 'origin', url: CHECKPOINT_REPOSITORY },
      branch: 'main',
    },
    owner: {
      identity: 'owner',
      allowedTrustRoutes: ['auto-merge', 'quick-review'],
    },
    live: { baseUrl: 'https://published.example/' },
    workflow: {
      provider: 'forgejo-actions',
      apiBaseUrl: 'https://forge.example:8443/api/v1',
      repository: 'owner/wiki',
      path: '.forgejo/workflows/publish-site.yml',
      event: 'push',
      branch: 'main',
      jobs: ['build', 'deploy'],
      deploymentJob: 'deploy',
    },
    workspace: {
      root: '.workspace/owner-alpha',
      store: '.workspace/owner-alpha/store',
      site: '.workspace/owner-alpha/site',
      cache: '.workspace/owner-alpha/cache',
    },
    paths: { include: ['**/*.md'], exclude: ['.git/**', '.workspace/**'] },
    limits: {
      maxSourceBytes: 2_097_152,
      maxReplacementBytes: 65_536,
      maxChangedBytes: 65_536,
      maxChangedLines: 60,
      maxArtifactBytes: 8_388_608,
      requestTimeoutMs: 30_000,
      networkTimeoutMs: 900_000,
    },
    checks: {
      allowedOfmVerdicts: ['clean'],
      requirePublishedSource: true,
      requireProjectionVerification: true,
      requireNoNewBrokenLinks: true,
      requireRenderedWitness: true,
    },
    git: {
      autoCommit: true,
      autoPush: true,
      useHooks: true,
      commitMessagePrefix: 'owner-alpha:',
    },
  });
}

export function checkpointIntent(fixture, proposal) {
  return fixture.intent({
    pageId: fixture.pageIdFor(proposal.path),
    selection: proposal.selection,
    replacement: proposal.replacement,
    rationale: proposal.rationale,
    evidence: proposal.evidence,
  });
}
