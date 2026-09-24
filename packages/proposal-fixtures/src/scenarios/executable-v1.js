import { defaultLaneSupport, defaultOperatingEvidence } from '../contract.js';
import { buildExecutableV1Fixture } from '../executable-v1.js';
import { intent, projection } from './helpers.js';

const repository = 'https://forge.example/owner/handbook.git';
const revision = 'fixture-revision-2026-08-21';
const submission = (rationale, evidence = []) => ({ submittedAt: '2026-08-21T12:00:00Z', rationale, evidence, identityClaim: null });
const source = (path) => ({ repository, revision, path });
const replaceOnce = (base, oldText, replacement) => base.replace(oldText, replacement);

export const executableV1Descriptors = Object.freeze([
  {
    fixtureId: 'v1-retention-paragraph',
    baseText: '# Backup retention\n\nDaily backups are retained for thirty days, and the first backup from each month becomes a monthly archive. Monthly archives normally remain available for one year from their creation date. The current wording also includes archives named in an open restoration request, but it does not explain what happens when the request remains active beyond the archive’s normal expiry date. Restoration work can span several review cycles, especially when an owner must compare historical configuration, exported assets, and version records before closing the request. Operators therefore need one explicit rule that prevents routine retention cleanup from removing evidence while that work is still open.\n\n## Recovery checks\n\nTest one restoration every quarter.\n',
    oldText: 'Daily backups are retained for thirty days, and the first backup from each month becomes a monthly archive. Monthly archives normally remain available for one year from their creation date. The current wording also includes archives named in an open restoration request, but it does not explain what happens when the request remains active beyond the archive’s normal expiry date. Restoration work can span several review cycles, especially when an owner must compare historical configuration, exported assets, and version records before closing the request. Operators therefore need one explicit rule that prevents routine retention cleanup from removing evidence while that work is still open.',
    replacement: 'Daily backups are retained for thirty days, and the first backup from each month becomes a monthly archive. Monthly archives normally remain available for one year from their creation date. If an open restoration request names an archive, that archive is held until the request closes, even when its normal retention date passes. The hold applies only to the archives listed in the request and does not extend unrelated backup sets. Restoration work can span several review cycles while an owner compares historical configuration, exported assets, and version records. After the owner closes the request and retains its final receipt, the affected archives return to the ordinary cleanup schedule.',
    path: 'handbook/backup-retention.md',
    title: null,
    projection: projection({ pageLabel: 'Backup retention', title: 'Proposal for Backup retention', titleProvenance: 'Neutral page-label fallback', fallbackTitle: 'Proposal for Backup retention', summary: 'Clarify the retention exception for archives used by an open restoration request.', identityDisclosure: 'No contributor title was supplied. The interface uses a neutral page-label fallback.', provenance: { title: 'neutral-fallback' } }),
    intent: intent({ summary: 'Clarify the retention exception for archives used by an open restoration request.', rationale: 'The current sentence can be read as deleting an archive while a restoration is still active.', declaredScope: 'One long paragraph in one existing page' }),
    operationLabel: 'Clarify the open-request retention exception',
    contextBefore: '',
    contextAfter: '\n\n## Recovery checks',
  },
  {
    fixtureId: 'v1-survey-number-date',
    baseText: '# 2025 contributor survey\n\nThe survey closed on 14 March after responses from 184 maintainers. Results are used as directional evidence, not a representative population estimate.\n\nSource notes remain in the private research archive.\n',
    oldText: 'The survey closed on 14 March after responses from 184 maintainers.',
    replacement: 'The survey closed on 18 March after responses from 214 maintainers.',
    path: 'research/2025-contributor-survey.md',
    projection: projection({ pageLabel: '2025 contributor survey', title: 'Correct the 2025 survey totals and close date', titleProvenance: 'Content-addressed adapter suggestion', fallbackTitle: 'Proposal for 2025 contributor survey', summary: 'Correct the reported respondent count and closing date while retaining the interpretation caveat.', identityDisclosure: 'Adapter suggestion tied to the canonical proposal digest. It is visibly separate from contributor-authored intent.', provenance: { title: 'adapter-suggestion' } }),
    intent: intent({ summary: 'Correct the reported respondent count and closing date.', rationale: 'The source spreadsheet has 214 accepted responses and a final close date of 18 March.', category: 'correction', declaredScope: 'One sourced sentence in one existing page', references: [{ url: 'https://research.example/survey-2025', label: 'Contributor reference; not verified by this mockup' }] }),
    operationLabel: 'Correct respondent count and close date',
    contextBefore: '', contextAfter: ' Results are used as directional evidence',
  },
  {
    fixtureId: 'v1-onboarding-link',
    baseText: '# Onboarding checklist\n\n1. Read the [setup guide](/handbook/old-setup/).\n2. Ask an owner to confirm access.\n3. Keep the receipt for the completed handoff.\n',
    oldText: '/handbook/old-setup/', replacement: '/handbook/getting-started/', path: 'handbook/onboarding-checklist.md',
    projection: projection({ pageLabel: 'Onboarding checklist', title: 'Fix onboarding checklist link', titleProvenance: 'Private owner alias', fallbackTitle: 'Proposal for Onboarding checklist', summary: 'Repair the setup-guide destination without changing the link label or surrounding checklist.', identityDisclosure: 'Private owner alias. Original neutral fallback retained: Proposal for Onboarding checklist.', provenance: { title: 'private-owner-alias', fallbackRetained: true } }),
    intent: intent({ summary: 'Repair the setup-guide destination.', rationale: 'The old setup route was replaced by the getting-started route.', category: 'maintenance', declaredScope: 'One Markdown link destination in one existing page' }),
    operationLabel: 'Repair the setup guide link destination', contextBefore: 'Read the [setup guide](', contextAfter: ').\n2. Ask an owner',
  },
  {
    fixtureId: 'v1-offline-limitation-insertion',
    baseText: '# Offline contribution notes\n\nYou can draft a correction without a connection.\n\n## Receipts\n\nKeep the final receipt with your notes.\n',
    insertionAt: '# Offline contribution notes\n\nYou can draft a correction without a connection.'.length,
    replacement: '\n\nOffline edits remain only on your device until reconnection. Do not assume they entered the private queue until the intake surface returns a retained receipt that you keep.',
    path: 'guides/offline-contribution.md',
    projection: projection({ pageLabel: 'Offline contribution notes', title: 'Explain when offline edits enter the queue', titleProvenance: 'Contributor-authored title', fallbackTitle: 'Proposal for Offline contribution notes', summary: 'Add the missing limitation that offline edits are local until reconnection and a retained receipt.', identityDisclosure: 'Contributor-authored title in the research fixture.', provenance: { title: 'contributor-authored' } }),
    intent: intent({ title: 'Explain when offline edits enter the queue', summary: 'Add the missing limitation that offline edits are local until reconnection and a retained receipt.', rationale: 'The current wording could make a contributor assume a local draft has already entered owner review.', category: 'expansion', declaredScope: 'One bounded offset insertion in one existing page' }),
    operationLabel: 'Insert the offline queue limitation', contextBefore: 'You can draft a correction without a connection.', contextAfter: '\n\n## Receipts',
    laneSupport: defaultLaneSupport({ laneA: true, laneB: false, sameHostOwnerReview: true }),
  },
  {
    fixtureId: 'v1-obsolete-notice-deletion',
    baseText: '# Migration guide\n\nUse the staged migration steps below.\n\n> Pilot notice: During the June pilot, owners must email the migration desk before each test. This temporary process ended on 30 June.\n\n## Prepare\n\nExport a current manifest before migration.\n',
    oldText: '\n\n> Pilot notice: During the June pilot, owners must email the migration desk before each test. This temporary process ended on 30 June.',
    replacement: '', path: 'guides/migration.md',
    projection: projection({ pageLabel: 'Migration guide', title: 'Remove the obsolete pilot notice', titleProvenance: 'Contributor-authored title', fallbackTitle: 'Proposal for Migration guide', summary: 'Remove a time-limited pilot notice while preserving all surrounding migration guidance.', identityDisclosure: 'Contributor-authored title in the research fixture.', provenance: { title: 'contributor-authored' } }),
    intent: intent({ title: 'Remove the obsolete pilot notice', summary: 'Remove a time-limited pilot notice while preserving surrounding guidance.', rationale: 'The June pilot process has ended and now misdirects maintainers.', category: 'maintenance', declaredScope: 'One bounded deletion in one existing page' }),
    operationLabel: 'Remove the completed pilot notice', contextBefore: 'Use the staged migration steps below.', contextAfter: '\n\n## Prepare',
  },
  {
    fixtureId: 'v1-frontmatter-review-date',
    baseText: '---\ntitle: Incident response handbook\nreviewed: 2025-10-15\nowner: Resilience team\n---\n\n# Incident response handbook\n\nUse the current escalation matrix.\n',
    oldText: 'reviewed: 2025-10-15', replacement: 'reviewed: 2026-08-21', path: 'handbook/incident-response.md',
    projection: projection({ pageLabel: 'Incident response handbook', title: 'Update the handbook review date', titleProvenance: 'Contributor-authored title', fallbackTitle: 'Proposal for Incident response handbook', summary: 'Change only the allowlisted reviewed date; computed metadata-touch facts remain separate from the declared category.', identityDisclosure: 'Contributor-authored title. The interface also flags computed metadata touch.', provenance: { title: 'contributor-authored' } }),
    intent: intent({ title: 'Update the handbook review date', summary: 'Update the documented review date after the handbook check.', rationale: 'The owner completed the scheduled review on 21 August 2026.', category: 'maintenance', declaredScope: 'One allowlisted frontmatter value in one existing page' }),
    operationLabel: 'Update the reviewed frontmatter value', contextBefore: 'title: Incident response handbook\n', contextAfter: '\nowner: Resilience team',
    presentationNotes: ['Declared maintenance category remains advisory; computed metadata touch raises attention.'],
  },
  {
    fixtureId: 'v1-access-review-long-page',
    baseText: '# Quarterly access review\n\nEvery quarter the owning team confirms that each account, integration, and shared credential still needs the access it holds. The review protects two things at once: the confidentiality of member data, and the ability of on-call engineers to act during an incident without asking for permissions they should already hold.\n\n## Before the review\n\nExport the current access list from the directory, the forge, and the deployment provider. Record the export time and the exact revision of the policy you compared against. A review that cites a policy revision is far easier to re-check later than a review that cites only a date.\n\nAsk each team lead to confirm the people on their list. A lead who cannot confirm an account within five working days should say so explicitly, rather than letting the entry pass by silence.\n\n## During the review\n\nWork through the list one entry at a time. For each entry record the account, the access it holds, the stated justification, and the reviewer. Entries that changed since the previous quarter also carry a short note explaining what changed and who approved it.\n\nShared credentials follow the same path, but they additionally need a named owner. A shared credential without a named owner is treated as unowned and is scheduled for rotation whether or not anyone still uses it.\n\n## Removing access\n\nRemove access as soon as a reviewer confirms it is no longer needed. Do not batch removals until the end of the quarter.\n\n## After the review\n\nPublish the completed review to the internal handbook and keep the export files beside it. The published review is the durable record; a spreadsheet on one reviewer\'s laptop is not.\n\nSchedule the next review before closing the current one. Reviews scheduled at the end of the previous review happen; reviews scheduled soon do not.\n',
    oldText: 'Remove access as soon as a reviewer confirms it is no longer needed. Do not batch removals until the end of the quarter.',
    replacement: 'Remove access as soon as a reviewer confirms it is no longer needed, and record the removal in the same entry that raised it. Do not batch removals until the end of the quarter: a delayed removal and a missed removal look identical to anyone auditing the trail later. When an account still needs emergency access, say so in the entry and name the person who will re-check it next quarter, so that the exception stays visible instead of quietly becoming permanent.',
    path: 'handbook/quarterly-access-review.md',
    projection: projection({ pageLabel: 'Quarterly access review', title: 'Keep removal timing and emergency exceptions visible', titleProvenance: 'Contributor-authored title', fallbackTitle: 'Proposal for Quarterly access review', summary: 'Explain why removals are recorded immediately and how a genuine emergency exception stays visible.', identityDisclosure: 'Contributor-authored title in the research fixture.', provenance: { title: 'contributor-authored' } }),
    intent: intent({ title: 'Keep removal timing and emergency exceptions visible', summary: 'Explain why removals are recorded immediately and how a genuine emergency exception stays visible.', rationale: 'The current paragraph states the rule but not the reason, so teams batch removals and undocumented exceptions become permanent.', category: 'clarification', declaredScope: 'One paragraph inside one section of one long existing page' }),
    operationLabel: 'Explain removal timing and emergency exceptions',
    contextBefore: '## Removing access\n\n',
    contextAfter: '\n\n## After the review',
  },
].map((item, index) => {
  const base = item.baseText;
  const startCharacter = item.insertionAt ?? base.indexOf(item.oldText);
  if (startCharacter < 0) throw new Error(`fixture source does not contain old text: ${item.fixtureId}`);
  const endCharacter = item.insertionAt ?? startCharacter + item.oldText.length;
  const start = Buffer.byteLength(base.slice(0, startCharacter));
  const end = Buffer.byteLength(base.slice(0, endCharacter));
  const replacement = item.replacement;
  const candidateText = Buffer.concat([Buffer.from(base).subarray(0, start), Buffer.from(replacement), Buffer.from(base).subarray(end)]).toString('utf8');
  return Object.freeze({
    fixtureId: item.fixtureId, baseText: base, candidateText, intent: item.intent,
    reviewProjection: item.projection, operationLabel: item.operationLabel,
    contextBefore: item.contextBefore, contextAfter: item.contextAfter,
    laneSupport: item.laneSupport ?? defaultLaneSupport({ laneA: true, laneB: true, sameHostOwnerReview: true }), operatingEvidence: item.operatingEvidence ?? defaultOperatingEvidence({
      exactBinding: ['verified-by-real-v1', 'The fixture was prepared, serialized, parsed, digested, and reapplied through @cyberbaser/proposal.'],
    }),
    presentationNotes: item.presentationNotes,
    proposalInput: {
      proposalId: `fixture:${index + 1}`,
      source: source(item.path),
      operation: item.insertionAt === undefined
        ? {
            type: 'quote',
            selector: {
              quote: item.oldText,
              ...(item.contextBefore ? { prefix: item.contextBefore } : {}),
              ...(item.contextAfter ? { suffix: item.contextAfter } : {}),
            },
            replacement,
          }
        : { type: 'offset', start, end, replacement },
      submission: submission(item.intent.rationale, item.intent.references.map((reference) => reference.url)),
    },
  });
}));

export const executableV1Materializations = Object.freeze(executableV1Descriptors.map(buildExecutableV1Fixture));
export const executableV1Fixtures = Object.freeze(executableV1Materializations.map((item) => item.fixture));
