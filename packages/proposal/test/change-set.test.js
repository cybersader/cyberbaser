import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../schema/proposal-v2.schema.json' with { type: 'json' };
import {
  ProposalError, PROPOSAL_MAX_BYTES, CHANGE_SET_MAX_OPERATIONS,
  CHANGE_SET_MAX_SPAN_BYTES, CHANGE_SET_MAX_CHANGED_BYTES, CHANGE_SET_MAX_FILE_BYTES,
  createChangeSetProposal, validateChangeSetProposal, applyChangeSetProposal,
  serializeChangeSetProposal, changeSetProposalDigest, parseVersionedProposal,
  projectV1ToChangeSet, describeChangeSet, renderChangeSet,
  criticMarkupAdapter, changeSetDisplayAdapters,
  prepareProposal, parseProposal, serializeProposal, proposalDigest, applyProposal,
} from '../src/index.js';
import { parseProposal as parseFromV2 } from '../src/v2.js';

const hash = (bytes) => `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
const copy = (value) => JSON.parse(JSON.stringify(value));
const source = { repository: 'https://forge.example/owner/wiki.git', revision: 'immutable:1', path: 'Example.md' };
const submission = { submittedAt: '2026-11-16T12:00:00Z', rationale: 'Fix wording.', evidence: [], identityClaim: null };
const base = Buffer.from('one old tail\n');
const operation = { operationId: 'op:1', start: 4, end: 7, expected: 'old', replacement: 'new' };
const input = (operations = [operation], extra = {}) => ({ proposalId: 'test:2', source, operations, submission, ...extra });
const create = (operations = [operation], bytes = base, extra = {}) => createChangeSetProposal(bytes, input(operations, extra));
function code(fn, expected) {
  try { fn(); throw new Error(`expected ${expected}`); }
  catch (error) { expect(error).toBeInstanceOf(ProposalError); expect(error.code).toBe(expected); }
}
function redigest(proposal) {
  const { changeSetDigest, ...body } = proposal.changeSet;
  proposal.changeSet.changeSetDigest = hash(Buffer.from(`${JSON.stringify(body)}\n`));
  return proposal;
}
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schemaValid = ajv.compile(schema);

// Independent golden bytes and digest, not generated through the implementation.
const V1_GOLDEN = '{"schemaVersion":1,"artifactType":"cyberbaser-proposal","proposalId":"golden:1","source":{"repository":"https://forge.example/owner/wiki.git","revision":"immutable:1","path":"Example.md"},"operation":{"type":"offset","selector":null,"baseByteLength":13,"baseDigest":"sha-256=:sZTX3gK3A0EPzUKHMpTRb4CWWBftfN8Yy60tmknKTEg=:","start":4,"end":7,"expectedOldBytesBase64":"b2xk","replacementBytesBase64":"bmV3","candidateByteLength":13,"candidateDigest":"sha-256=:r/BOzRMBBMJqJ5SBHKp2qLZcqqJ3cTfX+l8Dp5OJ+ps=:"},"submission":{"submittedAt":"2026-11-16T12:00:00Z","rationale":"Fix wording.","evidence":[],"identityClaim":null}}\n';
const V1_DIGEST = 'sha-256=:doo7mWCDOsBzd93zJtCSzi3Pg25f5z3N4XfN7tqg6XU=:';

test('v1 golden bytes, digest, root parser shape and application are unchanged', () => {
  const legacy = prepareProposal(base, {
    proposalId: 'golden:1', source, submission,
    operation: { type: 'offset', start: 4, end: 7, replacement: 'new' },
  });
  expect(serializeProposal(legacy)).toBe(V1_GOLDEN);
  expect(proposalDigest(legacy)).toBe(V1_DIGEST);
  expect(parseProposal(V1_GOLDEN)).toEqual(legacy);
  expect(parseProposal(V1_GOLDEN).schemaVersion).toBe(1);
  expect(applyProposal(base, legacy)).toEqual(Buffer.from('one new tail\n'));
});

test('creates and applies an atomic modify-only change set with every binding', () => {
  const proposal = create();
  expect(schemaValid(proposal)).toBe(true);
  expect(proposal.changeSet.atomic).toBe(true);
  expect(proposal.changeSet.files).toHaveLength(1);
  expect(proposal.changeSet.files[0].kind).toBe('modify');
  expect(proposal.changeSet.files[0].base).toEqual({ byteLength: base.length, digest: hash(base) });
  expect(applyChangeSetProposal(base, proposal)).toEqual(Buffer.from('one new tail\n'));
  expect(validateChangeSetProposal(proposal, base)).toEqual(proposal);
  expect(proposal.changeSet.files[0].candidate.digest).toBe(hash(Buffer.from('one new tail\n')));
});

test('canonical serialization and both digests have independent fixed-order formulas', () => {
  const proposal = create();
  const { changeSetDigest, ...body } = proposal.changeSet;
  expect(changeSetDigest).toBe(hash(Buffer.from(`${JSON.stringify(body)}\n`)));
  const text = serializeChangeSetProposal(proposal);
  expect(text).toBe(`${JSON.stringify(proposal)}\n`);
  expect(Object.keys(proposal)).toEqual(['schemaVersion', 'artifactType', 'proposalId', 'changeSet', 'submission']);
  expect(Object.keys(body)).toEqual(['atomic', 'repository', 'baseRevision', 'files']);
  expect(Object.keys(body.files[0])).toEqual(['path', 'kind', 'base', 'operations', 'candidate']);
  expect(Object.keys(body.files[0].operations[0])).toEqual(['operationId', 'start', 'end', 'expected', 'replacement']);
  expect(changeSetProposalDigest(proposal)).toBe(hash(Buffer.from(text)));
  const changed = copy(proposal);
  changed.submission.rationale = 'New rationale.';
  expect(validateChangeSetProposal(changed).changeSet.changeSetDigest).toBe(changeSetDigest);
  expect(changeSetProposalDigest(changed)).not.toBe(changeSetProposalDigest(proposal));
});

test('version dispatch is explicit and preserves the old parser fail-closed behavior', () => {
  const proposal = create();
  const text = serializeChangeSetProposal(proposal);
  expect(parseVersionedProposal(text)).toEqual({ version: 2, proposal });
  expect(parseFromV2(Buffer.from(text))).toEqual({ version: 2, proposal });
  expect(parseVersionedProposal(V1_GOLDEN)).toEqual({ version: 1, proposal: parseProposal(V1_GOLDEN) });
  expect(() => parseProposal(text)).toThrow(ProposalError);
  for (const version of [0, 3, '2']) code(() => parseVersionedProposal(JSON.stringify({ schemaVersion: version })), 'unsupported-schema');
});

test('parser rejects alternate encodings, duplicate keys, malformed input and oversized input', () => {
  const proposal = create();
  const text = serializeChangeSetProposal(proposal);
  for (const bad of [text.trimEnd(), `${text}\n`, text.replace(/\n$/u, '\r\n'),
    `${JSON.stringify(proposal, null, 2)}\n`, ` ${text}`,
    text.replace('"schemaVersion":2,', '"schemaVersion":2,"schemaVersion":2,'),
    text.replace('"schemaVersion":2,"artifactType":"cyberbaser-proposal",', '"artifactType":"cyberbaser-proposal","schemaVersion":2,'),
    text.replace('old', '\\u006fld')]) {
    code(() => parseVersionedProposal(bad), 'noncanonical-proposal');
  }
  code(() => parseVersionedProposal(`﻿${text}`), 'utf8-bom');
  code(() => parseVersionedProposal(Buffer.from([255])), 'invalid-utf8');
  code(() => parseVersionedProposal('\ud800'), 'invalid-unicode');
  code(() => parseVersionedProposal(''), 'empty-proposal');
  code(() => parseVersionedProposal('{'), 'malformed-json');
  code(() => parseVersionedProposal(Buffer.alloc(PROPOSAL_MAX_BYTES + 1)), 'proposal-too-large');
  code(() => parseVersionedProposal('x'.repeat(PROPOSAL_MAX_BYTES + 1)), 'proposal-too-large');
});

test('all nested records are strict and structural schema rejects invalid envelopes', () => {
  const mutations = [
    (p) => { p.extra = true; }, (p) => { p.changeSet.extra = true; },
    (p) => { p.changeSet.files[0].extra = true; }, (p) => { p.changeSet.files[0].base.extra = true; },
    (p) => { p.changeSet.files[0].candidate.extra = true; },
    (p) => { p.changeSet.files[0].operations[0].extra = true; },
    (p) => { p.submission.extra = true; }, (p) => { delete p.changeSet.files[0].operations[0].expected; },
    (p) => { p.changeSet.atomic = false; }, (p) => { p.changeSet.files.push(copy(p.changeSet.files[0])); },
    (p) => { p.changeSet.files[0].kind = 'create'; }, (p) => { p.changeSet.files[0].path = '../escape.md'; },
    (p) => { p.changeSet.repository = 'https://user:secret@forge.example/wiki.git'; },
    (p) => { p.submission.submittedAt = '2026-02-30T00:00:00Z'; },
  ];
  for (const mutate of mutations) {
    const invalid = copy(create()); mutate(invalid);
    expect(schemaValid(invalid)).toBe(false);
    expect(() => validateChangeSetProposal(invalid)).toThrow(ProposalError);
  }
});

test('source and inert identity metadata follow v1 rules without trust elevation', () => {
  const claimed = create([operation], base, { submission: { ...submission, identityClaim: { type: 'agent', issuer: 'https://forge.example/', subject: 'administrator' } } });
  expect(claimed.submission.identityClaim.subject).toBe('administrator');
  expect(Object.keys(claimed)).not.toContain('authority');
  for (const repository of ['http://forge.example/wiki.git', 'https://forge.example./wiki.git', 'https://forge.example/%77iki.git']) {
    expect(() => create([operation], base, { source: { ...source, repository } })).toThrow(ProposalError);
  }
  for (const bad of [{ ...submission, rationale: 'bad\r\n' }, { ...submission, rationale: ' ' },
    { ...submission, identityClaim: { type: 'owner', issuer: 'https://forge.example/', subject: 'admin' } },
    { ...submission, evidence: ['https://example.com/', 'https://example.com/'] }]) {
    expect(() => create([operation], base, { submission: bad })).toThrow(ProposalError);
  }
});

test('returns independent deeply frozen values and never changes inputs or base', () => {
  const request = copy(input()); const snapshot = copy(request); const bytes = Buffer.from(base);
  const proposal = createChangeSetProposal(bytes, request);
  expect(request).toEqual(snapshot); expect(bytes).toEqual(base);
  for (const value of [proposal, proposal.changeSet, proposal.changeSet.files, proposal.changeSet.files[0],
    proposal.changeSet.files[0].operations, proposal.changeSet.files[0].operations[0], proposal.submission.evidence]) {
    expect(Object.isFrozen(value)).toBe(true);
  }
  request.operations[0].replacement = 'bad';
  expect(proposal.changeSet.files[0].operations[0].replacement).toBe('new');
  const candidate = applyChangeSetProposal(bytes, proposal); candidate.fill(0);
  expect(bytes).toEqual(base);
});

test('supports adjacent operations and insertion at a previous range end', () => {
  const bytes = Buffer.from('abc!');
  const operations = [
    { operationId: 'a', start: 0, end: 1, expected: 'a', replacement: 'A' },
    { operationId: 'b', start: 1, end: 2, expected: 'b', replacement: 'B' },
    { operationId: 'c', start: 2, end: 2, expected: '', replacement: 'X' },
    { operationId: 'd', start: 3, end: 3, expected: '', replacement: '?' },
  ];
  expect(applyChangeSetProposal(bytes, create(operations, bytes)).toString()).toBe('ABXc?!');
});

test('rejects overlap, unsorted ranges, duplicate starts and duplicate operation IDs', () => {
  const a = { operationId: 'a', start: 1, end: 3, expected: 'ne', replacement: 'A' };
  const b = { operationId: 'b', start: 2, end: 4, expected: 'e ', replacement: 'B' };
  code(() => create([a, b]), 'overlap');
  code(() => create([b, a]), 'noncanonical-order');
  code(() => create([a, { ...b, start: 1, end: 1, expected: '' }]), 'duplicate-start');
  code(() => create([{ ...a, end: 1, expected: '' }, { ...b, start: 1, end: 1, expected: '' }]), 'duplicate-start');
  code(() => create([{ ...a, end: 1, expected: '' }, { ...b, start: 1, end: 3, expected: 'ne' }]), 'duplicate-start');
  code(() => create([a, { ...operation, operationId: 'a' }]), 'duplicate-operation-id');
});

test('rejects invalid identifiers and malformed operation arrays', () => {
  for (const id of ['', 'a b', 'é', 'x'.repeat(129), 'a\n']) expect(() => create([{ ...operation, operationId: id }])).toThrow(ProposalError);
  for (const operations of [[], null, {}, Array(2)]) expect(() => create(operations)).toThrow(ProposalError);
});

test('rejects unsafe, out-of-range and reversed offsets', () => {
  for (const change of [{ start: -1 }, { start: 0.5 }, { start: Number.MAX_SAFE_INTEGER + 1 },
    { start: 8, end: 7 }, { end: 999 }, { end: NaN }, { start: '4' }]) {
    expect(() => create([{ ...operation, ...change }])).toThrow(ProposalError);
  }
});

test('rejects mismatched expected bytes, lengths, unpaired surrogates and invalid base UTF-8', () => {
  code(() => create([{ ...operation, expected: 'xxx' }]), 'old-bytes-mismatch');
  code(() => create([{ ...operation, expected: 'xx' }]), 'old-bytes-length-mismatch');
  for (const field of ['expected', 'replacement']) code(() => create([{ ...operation, [field]: '\ud800' }]), 'invalid-unicode');
  code(() => create([operation], Buffer.from([255])), 'invalid-utf8');
  code(() => create([operation], 'one old tail\n'), 'invalid-bytes');
});

test('rejects start and end offsets inside a UTF-8 code point', () => {
  const bytes = Buffer.from('a🧭漢b');
  code(() => create([{ operationId: 'a', start: 2, end: 3, expected: 'x', replacement: 'Y' }], bytes), 'offset-not-utf8-boundary');
  code(() => create([{ operationId: 'a', start: 1, end: 2, expected: 'x', replacement: 'Y' }], bytes), 'offset-not-utf8-boundary');
  code(() => create([{ operationId: 'a', start: 6, end: 6, expected: '', replacement: 'Y' }], bytes), 'offset-not-utf8-boundary');
});

test('preserves BOM CRLF tabs combining marks and untouched lone CR without normalization', () => {
  const bytes = Buffer.from('﻿﻿A\r\n漢🧭 old\t é\rTAIL\r\n');
  const start = bytes.indexOf('old');
  const proposal = create([{ ...operation, start, end: start + 3, replacement: 'new\r\ntext' }], bytes);
  expect(applyChangeSetProposal(bytes, proposal)).toEqual(Buffer.from(bytes.toString().replace('old', 'new\r\ntext')));
});

test('rejects CRLF splitting and introduced lone CR but permits complete CRLF replacements', () => {
  const bytes = Buffer.from('a\r\nb!');
  for (const op of [
    { start: 2, end: 3, expected: '\n', replacement: '' },
    { start: 1, end: 2, expected: '\r', replacement: '' },
    { start: 2, end: 2, expected: '', replacement: 'X' },
  ]) code(() => create([{ operationId: 'a', ...op }], bytes), 'crlf-split');
  code(() => create([{ ...operation, replacement: 'bad\rtext' }]), 'invalid-line-ending');
  const proposal = create([{ operationId: 'a', start: 1, end: 3, expected: '\r\n', replacement: '\n' }], bytes);
  expect(applyChangeSetProposal(bytes, proposal).toString()).toBe('a\nb!');
});

test('rejects each no-op and a globally cancelling change set', () => {
  code(() => create([{ ...operation, replacement: 'old' }]), 'no-op-proposal');
  code(() => create([{ ...operation, start: 0, end: 0, expected: '', replacement: '' }]), 'no-op-proposal');
  const operations = [
    { operationId: 'a', start: 0, end: 1, expected: 'a', replacement: '' },
    { operationId: 'b', start: 1, end: 1, expected: '', replacement: 'a' },
  ];
  code(() => create(operations, Buffer.from('a!')), 'no-op-proposal');
});

test('rejects complete file coverage, including an adjacent removed-range union', () => {
  const bytes = Buffer.from('abcd');
  code(() => create([{ operationId: 'a', start: 0, end: 4, expected: 'abcd', replacement: 'new' }], bytes), 'whole-file-operation');
  code(() => create([
    { operationId: 'a', start: 0, end: 2, expected: 'ab', replacement: 'A' },
    { operationId: 'b', start: 2, end: 4, expected: 'cd', replacement: 'B' },
  ], bytes), 'whole-file-operation');
});

test('allows a bounded insertion into an existing empty file', () => {
  const bytes = Buffer.alloc(0);
  const proposal = create([{ operationId: 'a', start: 0, end: 0, expected: '', replacement: '# New\n' }], bytes);
  expect(applyChangeSetProposal(bytes, proposal).toString()).toBe('# New\n');
});

test('enforces operation count at the exact limit and one beyond', () => {
  const bytes = Buffer.from('x'.repeat(CHANGE_SET_MAX_OPERATIONS + 2));
  const operations = Array.from({ length: CHANGE_SET_MAX_OPERATIONS + 1 }, (_, i) => ({ operationId: `op:${i}`, start: i, end: i + 1, expected: 'x', replacement: 'y' }));
  expect(create(operations.slice(0, CHANGE_SET_MAX_OPERATIONS), bytes).changeSet.files[0].operations).toHaveLength(50);
  code(() => create(operations, bytes), 'operation-count');
});

test('enforces each UTF-8 span and the aggregate removed-plus-inserted byte cap', () => {
  const size = CHANGE_SET_MAX_SPAN_BYTES;
  const bytes = Buffer.from(`${'x'.repeat(size)}!${'x'.repeat(size)}!`);
  const operations = [0, size + 1].map((start, i) => ({ operationId: `op:${i}`, start, end: start + size, expected: 'x'.repeat(size), replacement: 'y'.repeat(size) }));
  expect(operations.reduce((sum, op) => sum + op.expected.length + op.replacement.length, 0)).toBe(CHANGE_SET_MAX_CHANGED_BYTES);
  expect(create(operations, bytes).changeSet.files[0].operations).toHaveLength(2);
  code(() => create([...operations, { operationId: 'extra', start: bytes.length, end: bytes.length, expected: '', replacement: 'z' }], bytes), 'changed-bytes-too-large');
  code(() => create([{ ...operation, replacement: 'y'.repeat(size + 1) }]), 'string-too-large');
  code(() => create([{ ...operation, replacement: '🧭'.repeat(size / 4 + 1) }]), 'string-too-large');
  const big = Buffer.from(`${'x'.repeat(size + 1)}!`);
  code(() => create([{ operationId: 'a', start: 0, end: size + 1, expected: 'x'.repeat(size + 1), replacement: '' }], big), 'string-too-large');
});

test('caps base and candidate independently at 4 MiB before construction', () => {
  const bytes = Buffer.alloc(CHANGE_SET_MAX_FILE_BYTES, 120);
  const op = { operationId: 'a', start: 0, end: 1, expected: 'x', replacement: 'y' };
  expect(applyChangeSetProposal(bytes, create([op], bytes)).length).toBe(CHANGE_SET_MAX_FILE_BYTES);
  code(() => create([op], Buffer.alloc(CHANGE_SET_MAX_FILE_BYTES + 1, 120)), 'file-too-large');
  code(() => create([{ ...op, end: 0, expected: '', replacement: 'y' }], bytes), 'file-too-large');
});

test('JSON escaping overhead cannot bypass the canonical artifact cap', () => {
  const span = '\0'.repeat(CHANGE_SET_MAX_SPAN_BYTES);
  const bytes = Buffer.from(`${span}!${span}!`);
  const operations = [0, span.length + 1].map((start, i) => ({ operationId: `op:${i}`, start, end: start + span.length, expected: span, replacement: '\u0001'.repeat(span.length) }));
  code(() => create(operations, bytes), 'proposal-too-large');
});

test('fails stale base length and digest before returning a candidate', () => {
  const proposal = create();
  code(() => applyChangeSetProposal(Buffer.from('short'), proposal), 'base-length-mismatch');
  code(() => applyChangeSetProposal(Buffer.from('ONE old tail\n'), proposal), 'base-digest-mismatch');
  code(() => validateChangeSetProposal(proposal, Buffer.from('ONE old tail\n')), 'base-digest-mismatch');
});

test('rejects tampered envelope digests and rehashed incorrect expected/candidate bindings', () => {
  const badDigest = copy(create()); badDigest.changeSet.changeSetDigest = hash(Buffer.from('tamper'));
  code(() => validateChangeSetProposal(badDigest), 'change-set-digest-mismatch');
  const opTamper = copy(create()); opTamper.changeSet.files[0].operations[0].replacement = 'bad';
  code(() => validateChangeSetProposal(opTamper), 'change-set-digest-mismatch');
  const expected = copy(create()); expected.changeSet.files[0].operations[0].expected = 'xxx'; redigest(expected);
  code(() => applyChangeSetProposal(base, expected), 'old-bytes-mismatch');
  const candidate = copy(create()); candidate.changeSet.files[0].candidate.digest = hash(Buffer.from('wrong')); redigest(candidate);
  code(() => applyChangeSetProposal(base, candidate), 'candidate-digest-mismatch');
  const wrongLength = copy(create()); wrongLength.changeSet.files[0].candidate.byteLength += 1; redigest(wrongLength);
  code(() => validateChangeSetProposal(wrongLength), 'candidate-length-mismatch');
  const wrongSource = copy(create()); wrongSource.changeSet.files[0].path = 'Other.md';
  code(() => validateChangeSetProposal(wrongSource), 'change-set-digest-mismatch');
});

test('v1 projection is read-only, carries original digest and is not an executable v2 artifact', () => {
  const proposal = parseProposal(V1_GOLDEN); const view = projectV1ToChangeSet(proposal);
  expect(view.version).toBe(1); expect(view.proposalDigest).toBe(V1_DIGEST);
  expect(view.changeSet.files[0].operations).toEqual([{ ...operation, operationId: 'v1:operation' }]);
  expect(Object.isFrozen(view.changeSet.files[0].operations[0])).toBe(true);
  expect(() => validateChangeSetProposal(view)).toThrow(ProposalError);
  expect(serializeProposal(proposal)).toBe(V1_GOLDEN);
});

test('v1 projection does not impose v2 caps or line ending restrictions on old records', () => {
  const bytes = Buffer.from(`a${'x'.repeat(20000)}\r\n!`);
  const legacy = prepareProposal(bytes, { proposalId: 'legacy:large', source, submission,
    operation: { type: 'offset', start: 1, end: 20001, replacement: 'y' } });
  expect(projectV1ToChangeSet(legacy).changeSet.files[0].operations[0].expected.length).toBe(20000);
  expect(describeChangeSet(bytes, legacy).version).toBe(1);
});

test('description exposes source-verified code point positions and bounded contexts', () => {
  const bytes = Buffer.from('α🧭\r\n漢old tail'); const start = bytes.indexOf('old');
  const proposal = create([{ ...operation, start, end: start + 3 }], bytes);
  const description = describeChangeSet(bytes, proposal, { contextCodePoints: 2 });
  expect(description.operations[0].startPosition).toEqual({ line: 2, column: 2 });
  expect(description.operations[0].endPosition).toEqual({ line: 2, column: 5 });
  expect(description.operations[0].context).toEqual({ before: '\n漢', after: ' t' });
  expect(describeChangeSet(bytes, proposal, { contextCodePoints: 0 }).operations[0].context).toEqual({ before: '', after: '' });
  expect(describeChangeSet(base, parseProposal(V1_GOLDEN)).operations[0].startPosition).toEqual({ line: 1, column: 5 });
  code(() => describeChangeSet(base, proposal), 'base-length-mismatch');
});

test('v1 description rechecks original quote uniqueness rather than applying the projection', () => {
  const bytes = Buffer.from('old and old!');
  const legacy = copy(prepareProposal(bytes, { proposalId: 'legacy:quote', source, submission,
    operation: { type: 'offset', start: 0, end: 3, replacement: 'new' } }));
  legacy.operation.type = 'quote'; legacy.operation.selector = { quote: 'old', prefix: null, suffix: null };
  expect(projectV1ToChangeSet(legacy).version).toBe(1);
  code(() => describeChangeSet(bytes, legacy), 'correction-quote-ambiguous');
});

for (const adapter of [criticMarkupAdapter, { id: 'plain-test', renderOperation: (op) => `${op.expected} -> ${op.replacement}` }]) {
  test(`display adapter conformance: ${adapter.id} receives frozen verified data and cannot alter integrity`, () => {
    const proposal = create(); const before = serializeChangeSetProposal(proposal);
    const rendered = renderChangeSet(base, proposal, adapter);
    expect(rendered.adapter).toBe(adapter.id);
    expect(rendered.operations[0].operationId).toBe('op:1');
    expect(typeof rendered.operations[0].text).toBe('string');
    expect(rendered.proposalDigest).toBe(changeSetProposalDigest(proposal));
    expect(Object.isFrozen(rendered.operations)).toBe(true);
    expect(serializeChangeSetProposal(proposal)).toBe(before);
  });
}

test('CriticMarkup is a registered escaped display adapter, not an envelope field', () => {
  expect(changeSetDisplayAdapters['critic-markup']).toBe(criticMarkupAdapter);
  expect(renderChangeSet(base, create()).operations[0].text).toBe('{~~old~>new~~}');
  expect(renderChangeSet(base, create([{ ...operation, replacement: '' }])).operations[0].text).toBe('{--old--}');
  expect(renderChangeSet(base, create([{ ...operation, start: 4, end: 4, expected: '', replacement: 'x' }])).operations[0].text).toBe('{++x++}');
  expect(renderChangeSet(base, create([{ ...operation, replacement: '{~~bad~>text~~}' }])).operations[0].text).toContain('\\{\\~\\~bad\\~>text\\~\\~\\}');
});

test('core fails closed on invalid adapter providers, output and unverified source', () => {
  const proposal = create();
  for (const adapter of [{}, { id: 'x', renderOperation: 'no' }, { id: 'x', renderOperation: () => 1 },
    { id: 'x', renderOperation: () => '\ud800' }, { id: 'x', renderOperation: () => 'x'.repeat(512 * 1024 + 1) },
    { id: 'x', renderOperation: () => { throw new Error('provider failed'); } },
    { id: 'x', renderOperation: (op) => { op.replacement = 'evil'; return 'x'; } }]) {
    expect(() => renderChangeSet(base, proposal, adapter)).toThrow(ProposalError);
  }
  let called = false;
  expect(() => renderChangeSet(Buffer.from('stale'), proposal, { id: 'spy', renderOperation: () => { called = true; return ''; } })).toThrow(ProposalError);
  expect(called).toBe(false);
});

test('deterministic fuzz: 300 Unicode/CRLF bases preserve every undeclared byte gap', () => {
  let seed = 0x51ced;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = ['a', 'b', '漢', '🧭', 'é', '\r\n', '\n', '\t', ' ', '﻿'];
  for (let trial = 0; trial < 300; trial += 1) {
    const tokens = ['START', ...Array.from({ length: 15 + random(70) }, () => alphabet[random(alphabet.length)]), 'END'];
    const offsets = [0];
    for (const token of tokens) offsets.push(offsets.at(-1) + Buffer.byteLength(token));
    const bytes = Buffer.from(tokens.join(''));
    const operations = []; const edits = [];
    for (let index = 1; index < tokens.length - 1 && operations.length < 12; index += 1 + random(4)) {
      const endIndex = Math.min(tokens.length - 1, index + random(3));
      const expected = tokens.slice(index, endIndex).join('');
      let replacement = ['', `new${trial}漢🧭`, '\r\n', 'text\n'][random(4)];
      if (replacement === expected) replacement = 'different';
      operations.push({ operationId: `op:${operations.length}`, start: offsets[index], end: offsets[endIndex], expected, replacement });
      edits.push({ index, endIndex, replacement }); index = Math.max(index, endIndex);
    }
    const reference = [...tokens];
    for (const edit of [...edits].reverse()) reference.splice(edit.index, edit.endIndex - edit.index, edit.replacement);
    const proposal = create(operations, bytes);
    const candidate = applyChangeSetProposal(bytes, proposal);
    expect(candidate).toEqual(Buffer.from(reference.join('')));
    expect(parseVersionedProposal(serializeChangeSetProposal(proposal)).proposal).toEqual(proposal);
    expect(schemaValid(proposal)).toBe(true);
    let baseCursor = 0; let candidateCursor = 0;
    for (const op of operations) {
      const gapLength = op.start - baseCursor;
      expect(candidate.subarray(candidateCursor, candidateCursor + gapLength)).toEqual(bytes.subarray(baseCursor, op.start));
      candidateCursor += gapLength + Buffer.byteLength(op.replacement); baseCursor = op.end;
    }
    expect(candidate.subarray(candidateCursor)).toEqual(bytes.subarray(baseCursor));
  }
});
