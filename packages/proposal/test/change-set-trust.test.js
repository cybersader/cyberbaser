import { expect, test } from 'bun:test';
import { parseConfig } from '@cyberbaser/trust';
import {
  ProposalError,
  createChangeSetProposal,
  changeSetProposalToTrustChange,
  classifyChangeSetProposal,
} from '../src/index.js';

const TRUST_CONFIG = parseConfig(`
trusted:
  - alice@forge.example
agents:
  - cyberbaser-bot
caps:
  lines: 60
  files: 5
  proseWords: 25
allowedNewFolders:
  - "docs/**"
frontmatterAllowlist:
  - title
`);
const source = { repository: 'https://forge.example/owner/wiki.git', revision: 'immutable:1', path: 'Example.md' };
const submission = {
  submittedAt: '2026-11-16T12:00:00Z',
  rationale: 'Fix wording.',
  evidence: [],
  identityClaim: { type: 'agent', issuer: 'https://forge.example/', subject: 'cyberbaser-bot' },
};
const base = Buffer.from('Mouses are good.\nCUSTOM keys 🔑 here.\n');
const operations = [
  { operationId: 'a', start: 0, end: 6, expected: 'Mouses', replacement: 'Mice' },
  { operationId: 'b', start: 17, end: 24, expected: 'CUSTOM ', replacement: '' },
];
const proposal = createChangeSetProposal(base, { proposalId: 'trust:2', source, operations, submission });

test('classifies the combined candidate as one change, never per operation', () => {
  const change = changeSetProposalToTrustChange(base, proposal);
  expect(change.files).toHaveLength(1);
  expect(change.files[0].before).toBe(base.toString());
  expect(change.files[0].after).toBe('Mice are good.\nkeys 🔑 here.\n');
  expect(change.meta.source).toEqual({ repository: source.repository, revision: source.revision, path: 'Example.md' });
  expect(Object.isFrozen(change.meta)).toBe(true);
});

test('identity claims in the artifact cannot elevate trust; only a receiver-verified subject can', () => {
  const anonymous = classifyChangeSetProposal(base, proposal, TRUST_CONFIG);
  expect(anonymous.tier).toBe('anonymous');
  expect(anonymous.route).toBe('full-review');
  const verified = classifyChangeSetProposal(base, proposal, TRUST_CONFIG, { author: 'cyberbaser-bot', authorType: 'agent' });
  expect(verified.tier).toBe('agent');
});

test('refuses a mismatched base, invalid subjects and leading-BOM changes', () => {
  expect(() => classifyChangeSetProposal(Buffer.from('Different base text here.\n'), proposal, TRUST_CONFIG)).toThrow(ProposalError);
  expect(() => classifyChangeSetProposal(base, proposal, TRUST_CONFIG, { author: '', authorType: 'human' })).toThrow(ProposalError);
  const bomBase = Buffer.from('﻿Hello world.\n');
  const bomProposal = createChangeSetProposal(bomBase, {
    proposalId: 'trust:bom', source, submission,
    operations: [{ operationId: 'x', start: 0, end: 3, expected: '﻿', replacement: '' }],
  });
  try {
    classifyChangeSetProposal(bomBase, bomProposal, TRUST_CONFIG);
    throw new Error('expected leading-bom-change');
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalError);
    expect(error.code).toBe('leading-bom-change');
  }
});
