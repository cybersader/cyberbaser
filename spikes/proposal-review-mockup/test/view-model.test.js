import { expect, test } from 'bun:test';
import { buildViewModel, createReceiptPreview, exposeInvisibleText, fixtureView } from '../src/view-model.js';
import { inlineTokens, markdownBlocks } from '@cyberbaser/review-projection';
import { getFixture } from '@cyberbaser/proposal-fixtures';

test('view model preserves title provenance, actual scope, labels, and quiet groups', () => {
  const model = buildViewModel();
  expect(model.groups.needs.length).toBe(9);
  expect(model.groups.blocked.length).toBe(4);
  expect(model.groups.decided.length).toBe(3);
  const inboxIds = Object.values(model.groups).flat().map((fixture) => fixture.id);
  for (const id of ['blocked-ambiguous-selection', 'no-op-operation', 'credential-like-text', 'later-two-guide-terminology-rename']) expect(inboxIds).not.toContain(id);
  expect(model.evidenceGroups.preAdmission.map((fixture) => fixture.id)).toContain('blocked-ambiguous-selection');
  expect(model.evidenceGroups.conceptual.map((fixture) => fixture.id)).toContain('later-two-guide-terminology-rename');
  const fallback = model.fixtures.find((fixture) => fixture.id === 'v1-retention-paragraph');
  expect(fallback.title).toBe('Proposal for Backup retention');
  expect(fallback.titleProvenance).toBe('Neutral page-label fallback');
  const adapter = model.fixtures.find((fixture) => fixture.id === 'v1-survey-number-date');
  expect(adapter.titleProvenance).toBe('Content-addressed adapter suggestion');
  const alias = model.fixtures.find((fixture) => fixture.id === 'v1-onboarding-link');
  expect(alias.titleProvenance).toBe('Private owner alias');
  expect(alias.fallbackTitle).toBe('Proposal for Onboarding checklist');
  const target = model.fixtures.find((fixture) => fixture.id === 'v2-setup-three-places');
  expect(target.actualScope).toBe('3 exact changes in 1 existing page · one atomic decision · partial approval unavailable');
  expect(target.supportLabel).toBe('Target capability');
  expect(target.evidenceLabel).toBe('Static design only');
});

test('insertion, deletion, blocked, and conceptual projections stay explicit', () => {
  const insertion = fixtureView(getFixture('v1-offline-limitation-insertion'));
  expect(insertion.operations[0].currentText).toBe('No current text at this location');
  expect(insertion.operations[0].currentSemanticLabel).toBe('No current text');
  expect(insertion.operations[0].proposedSemanticLabel).toBe('Added · Not yet approved');
  const deletion = fixtureView(getFixture('v1-obsolete-notice-deletion'));
  expect(deletion.operations[0].proposedText).toBe('Notice removed here');
  expect(deletion.operations[0].currentSemanticLabel).toBe('Removed');
  expect(deletion.operations[0].proposedSemanticLabel).toBe('Absent in proposed result · Not yet approved');
  const blocked = fixtureView(getFixture('blocked-stale-base'));
  expect(blocked.decisionControls).toBe(false);
  expect(blocked.attentionLabel).toBe('Blocked from decision');
  expect(blocked.blocker).toContain('digest');
  const conceptual = fixtureView(getFixture('later-two-guide-terminology-rename'));
  expect(conceptual.decisionControls).toBe(false);
  expect(conceptual.supportLabel).toBe('Conceptual later');
  expect(conceptual.attentionLabel).toBe('Conceptual later · no decision available');
  const authority = fixtureView(getFixture('authority-approved-not-authorized'));
  expect(authority.operatingEvidence.ownerDecision.state).toBe('approved');
  expect(authority.operatingEvidence.applicationAuthority.state).toBe('absent');
});

test('bidi and invisible controls are exposed as named code points in display text', () => {
  const exposed = exposeInvisibleText('abc‮txt​end');
  expect(exposed).toContain('⟦U+202E RIGHT-TO-LEFT OVERRIDE⟧');
  expect(exposed).toContain('⟦U+200B ZERO WIDTH SPACE⟧');
  expect(exposed).not.toContain('‮');
  expect(fixtureView(getFixture('bidi-invisible-text')).summary).toContain('⟦U+202E RIGHT-TO-LEFT OVERRIDE⟧');
});

test('receipt previews lead with decision, note, full scope, source unchanged, and no-effect copy', () => {
  const fixture = fixtureView(getFixture('v1-retention-paragraph'));
  for (const action of ['approve', 'reject']) {
    const receipt = createReceiptPreview(fixture, action, 'Bounded owner note.');
    expect(receipt.kind).toBe('Private proposal decision receipt');
    expect(receipt.result).toBe(action === 'approve' ? 'Approval recorded' : 'Proposal rejected');
    expect(receipt.note).toBe('Bounded owner note.');
    expect(receipt.actualScope).toBe(fixture.actualScope);
    expect(receipt.sourceState).toBe('Source unchanged');
    expect(receipt.noEffect).toContain('No application requested or started');
    expect(receipt.noEffect).toContain('commit');
    expect(receipt.noEffect).toContain('publication');
  }
  const target = fixtureView(getFixture('v2-setup-three-places'));
  const targetReceipt = createReceiptPreview(target, 'approve', 'Approve all three exact changes together.');
  expect(targetReceipt.atomicity).toBe('One atomic decision · partial approval unavailable');
  expect(targetReceipt.paths.map((path) => path.path)).toEqual(['guides/setup.md']);
  expect(targetReceipt.operations.map((operation) => operation.label)).toEqual([
    'Update the supported runtime prerequisite',
    'Repair the validation command and reference',
    'Add the compatibility note',
  ]);
});


// Context is cut at the edges of changed blocks by the shared projection, so
// compare the shape with adjacent context runs collapsed.
function shape(segments) {
  return segments.map((item) => item.kind).filter((kind, index, kinds) => kind !== 'context' || kinds[index - 1] !== 'context');
}

test('document projections are replayed from the pinned base and declared exact operations', () => {
  const fixture = fixtureView(getFixture('v1-retention-paragraph'));
  const raw = getFixture('v1-retention-paragraph');
  expect(fixture.document.modes).toEqual({
    changes: { available: true, reason: null },
    proposed: { available: true, reason: null },
    current: { available: true, reason: null },
  });
  const [file] = fixture.document.files;
  expect(file.path).toBe('handbook/backup-retention.md');
  expect(file.operationNumbers).toEqual([1]);
  expect(shape(file.current.segments)).toEqual(['context', 'removed', 'context']);
  expect(shape(file.proposed.segments)).toEqual(['context', 'added', 'context']);
  expect(shape(file.unified.segments)).toEqual(['context', 'removed', 'added', 'context']);
  expect(file.current.segments.map((item) => item.text).join('')).toBe(raw.sourceFiles[0].baseText);
  expect(file.proposed.segments.map((item) => item.text).join('')).toBe(raw.sourceFiles[0].candidateText);
  for (const segment of file.unified.segments) {
    if (segment.kind === 'context') expect(segment.operation).toBeNull();
    else expect(segment.operation).toBe(1);
  }
});

test('insertion, deletion, and multi-operation projections mark every declared change', () => {
  const insertion = fixtureView(getFixture('v1-offline-limitation-insertion'));
  const insertionFile = insertion.document.files[0];
  expect(shape(insertionFile.current.segments)).toEqual(['context', 'insertion-point', 'context']);
  expect(shape(insertionFile.proposed.segments)).toEqual(['context', 'added', 'context']);

  const deletion = fixtureView(getFixture('v1-obsolete-notice-deletion'));
  const deletionFile = deletion.document.files[0];
  expect(shape(deletionFile.current.segments)).toEqual(['context', 'removed', 'context']);
  expect(shape(deletionFile.proposed.segments)).toEqual(['context', 'deletion-point', 'context']);

  const target = fixtureView(getFixture('v2-setup-three-places'));
  const targetFile = target.document.files[0];
  const rawTarget = getFixture('v2-setup-three-places');
  expect(targetFile.operationNumbers).toEqual([1, 2, 3]);
  expect(targetFile.proposed.segments.map((item) => item.text).join('')).toBe(rawTarget.sourceFiles[0].candidateText);
  expect(new Set(targetFile.unified.segments.filter((item) => item.operation !== null).map((item) => item.operation))).toEqual(new Set([1, 2, 3]));
});

test('undecidable evidence never receives a synthesized document projection', () => {
  const stale = fixtureView(getFixture('blocked-stale-base'));
  expect(stale.document.modes.current.available).toBe(true);
  expect(stale.document.modes.proposed.available).toBe(false);
  expect(stale.document.modes.changes.available).toBe(false);
  expect(stale.document.modes.proposed.reason).toContain('No candidate result is derivable');

  const overlapping = fixtureView(getFixture('blocked-overlapping-v2-operations'));
  for (const mode of ['current', 'proposed', 'changes']) {
    expect(overlapping.document.modes[mode].available).toBe(false);
    expect(overlapping.document.modes[mode].reason).toContain('not canonically ordered');
  }

  const newPage = fixtureView(getFixture('later-new-handoff-checklist-page'));
  expect(newPage.document.modes.current.available).toBe(false);
  expect(newPage.document.modes.current.reason).toContain('does not exist in the pinned base');
  expect(newPage.document.modes.proposed.available).toBe(true);
  expect(newPage.document.files[0].proposed.segments.map((item) => item.kind)).toEqual(['added']);

  const twoFiles = fixtureView(getFixture('later-two-guide-terminology-rename'));
  expect(twoFiles.document.files).toHaveLength(2);
  expect(twoFiles.document.files.map((file) => file.operationNumbers)).toEqual([[1], [2]]);
});


test('the reading projection recognizes a conservative Markdown subset and keeps offsets contiguous', () => {
  const text = '---\ntitle: Example\nreviewed: 2026-08-21\n---\n\n# Heading\n\nA paragraph with **bold**, *italic*, `code`, a [link](/somewhere/), and a [[wikilink|alias]].\n\n- first\n- second\n\n> A quotation.\n\n```\nfenced code\n```\n';
  const blocks = markdownBlocks(text);
  expect(blocks.map((block) => block.kind)).toEqual([
    'frontmatter', 'gap', 'heading', 'gap', 'paragraph', 'gap', 'list', 'gap', 'quote', 'gap', 'code',
  ]);
  expect(blocks[0].start).toBe(0);
  expect(blocks.at(-1).end).toBe(text.length);
  for (let index = 1; index < blocks.length; index += 1) expect(blocks[index].start).toBe(blocks[index - 1].end);
  expect(blocks[0].entries).toEqual([
    { name: 'title', value: 'Example' },
    { name: 'reviewed', value: '2026-08-21' },
  ]);
  expect(blocks[2].level).toBe(1);
  expect(blocks[6].items.map((item) => item.tokens[0].text)).toEqual(['first', 'second']);
  expect(blocks[10].text).toBe('fenced code');

  const tokens = blocks[4].tokens;
  expect(tokens.filter((token) => token.type !== 'text').map((token) => [token.type, token.text])).toEqual([
    ['strong', 'bold'], ['emphasis', 'italic'], ['code', 'code'], ['link', 'link'], ['wikilink', 'alias'],
  ]);
  expect(tokens.find((token) => token.type === 'wikilink').target).toBe('wikilink');
  expect(tokens.find((token) => token.type === 'link').target).toBe('/somewhere/');
});

test('reading blocks never lose bytes and unknown syntax falls back to plain text', () => {
  for (const id of ['v1-access-review-long-page', 'v1-onboarding-link', 'v1-frontmatter-review-date', 'v2-restructure-installation-section']) {
    const [file] = fixtureView(getFixture(id)).document.files;
    const source = getFixture(id).sourceFiles[0].baseText;
    expect(file.current.blocks.at(-1).end).toBe(source.length);
    for (let index = 1; index < file.current.blocks.length; index += 1) {
      expect(file.current.blocks[index].start).toBe(file.current.blocks[index - 1].end);
    }
  }
  expect(inlineTokens('<div onclick="x">raw html</div>').map((token) => token.type)).toEqual(['text']);
  expect(inlineTokens('').map((token) => token.text)).toEqual(['']);
});


test('the projection names every construct it does not interpret instead of rendering it wrongly', () => {
  const blocks = markdownBlocks([
    '# Page',
    '',
    'A plain paragraph.',
    '',
    '> [!note] Spacing',
    '> Space them apart.',
    '',
    '| a | b |',
    '| - | - |',
    '',
    '![[diagram.png]]',
    '',
    '- [ ] a task',
    '',
    'Inline $x^2$ math.',
    '',
    '```mermaid',
    'graph TD;',
    '```',
    '',
    'Text with <span>html</span>.',
    '',
  ].join('\n'));
  const named = blocks.filter((block) => block.kind !== 'gap').map((block) => block.uninterpreted);
  expect(named).toEqual([
    [], [], ['callout'], ['table'], ['note or image embed'], ['task list'], ['math'], ['renderer-executed block'], ['inline HTML'],
  ]);
  for (const block of blocks) expect(Array.isArray(block.uninterpreted)).toBe(true);
});
