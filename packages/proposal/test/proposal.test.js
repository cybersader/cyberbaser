import { createHash } from 'node:crypto';
import { test, expect } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseConfig } from '@cyberbaser/trust';
import proposalSchema from '../schema/proposal-v1.schema.json' with { type: 'json' };
import {
  PROPOSAL_ARTIFACT_TYPE,
  PROPOSAL_MAX_BYTES,
  PROPOSAL_MAX_SPAN_BYTES,
  PROPOSAL_SCHEMA_VERSION,
  ProposalError,
  applyProposal,
  classifyProposal,
  parseProposal,
  prepareProposal,
  proposalDigest,
  proposalToTrustChange,
  serializeProposal,
  validateProposal,
} from '../src/index.js';

const BASE_TEXT = [
  '---',
  'title: Example',
  '---',
  '',
  '# Example',
  '',
  'A line about teh process.',
  'Tail with emoji 🧭 and é.',
  '',
].join('\r\n');
const BASE = Buffer.from(BASE_TEXT, 'utf8');
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
const schemaValidator = new Ajv2020({ allErrors: true, strict: false });
addFormats(schemaValidator);
const validateAgainstSchema = schemaValidator.compile(proposalSchema);

function quoteInput(overrides = {}) {
  return {
    proposalId: 'lane-a:example-1',
    source: {
      repository: 'https://github.com/cybersader/cyberbase.git',
      revision: 'opaque-revision-1',
      path: 'docs/example.md',
    },
    operation: {
      type: 'quote',
      selector: {
        quote: 'teh',
        prefix: 'A line about ',
        suffix: ' process.',
      },
      replacement: 'the',
    },
    submission: {
      submittedAt: '2026-08-10T12:34:56Z',
      rationale: 'Correct the misspelling without changing meaning.',
      evidence: ['https://example.com/source'],
      identityClaim: null,
    },
    ...overrides,
  };
}

function mutable(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCode(callback, code) {
  try {
    callback();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalError);
    expect(error.code).toBe(code);
  }
}

test('prepares a canonical quote proposal and applies one exact splice', () => {
  const proposal = prepareProposal(BASE, quoteInput());
  expect(proposal.schemaVersion).toBe(PROPOSAL_SCHEMA_VERSION);
  expect(proposal.artifactType).toBe(PROPOSAL_ARTIFACT_TYPE);
  expect(proposal.operation.type).toBe('quote');
  expect(proposal.operation.selector).toEqual({
    quote: 'teh',
    prefix: 'A line about ',
    suffix: ' process.',
  });
  expect(Buffer.from(proposal.operation.expectedOldBytesBase64, 'base64').toString()).toBe('teh');
  expect(Buffer.from(proposal.operation.replacementBytesBase64, 'base64').toString()).toBe('the');
  const candidate = applyProposal(BASE, proposal);
  expect(candidate.toString('utf8')).toBe(BASE_TEXT.replace('teh process', 'the process'));
  expect(candidate.subarray(0, proposal.operation.start)).toEqual(
    BASE.subarray(0, proposal.operation.start),
  );
  expect(candidate.subarray(
    proposal.operation.start + 3,
  )).toEqual(BASE.subarray(proposal.operation.end));
});

test('prepares offset insertion, replacement, and deletion operations', () => {
  const base = Buffer.from('alpha βeta omega\n');
  const cases = [
    { start: 0, end: 0, replacement: 'Start: ', expected: 'Start: alpha βeta omega\n' },
    { start: 6, end: 11, replacement: 'gamma', expected: 'alpha gamma omega\n' },
    { start: 11, end: 17, replacement: '', expected: 'alpha βeta\n' },
  ];
  for (const [index, item] of cases.entries()) {
    const proposal = prepareProposal(base, quoteInput({
      proposalId: `offset:${index}`,
      operation: {
        type: 'offset',
        start: item.start,
        end: item.end,
        replacement: item.replacement,
      },
    }));
    expect(proposal.operation.selector).toBeNull();
    expect(applyProposal(base, proposal).toString()).toBe(item.expected);
  }
});

test('allows one bounded insertion into an existing empty Markdown file', () => {
  const base = Buffer.alloc(0);
  const proposal = prepareProposal(base, quoteInput({
    proposalId: 'offset:empty-file',
    operation: {
      type: 'offset',
      start: 0,
      end: 0,
      replacement: '# First heading\n',
    },
  }));
  expect(proposal.operation.baseByteLength).toBe(0);
  expect(applyProposal(base, proposal).toString()).toBe('# First heading\n');
});

test('preserves CRLF, tabs, trailing spaces, emoji, and combining marks', () => {
  const proposal = prepareProposal(BASE, quoteInput());
  const candidate = applyProposal(BASE, proposal);
  expect(candidate.toString()).toContain('\r\n');
  expect(candidate.toString()).toContain('🧭 and é.');
  expect(candidate.length).toBe(BASE.length);

  const tabs = Buffer.from('before\told  \r\nafter\r\n');
  const tabProposal = prepareProposal(tabs, quoteInput({
    proposalId: 'tabs:1',
    operation: {
      type: 'quote',
      selector: { quote: 'old', prefix: 'before\t', suffix: '  \r\n' },
      replacement: 'new',
    },
  }));
  expect(applyProposal(tabs, tabProposal).toString()).toBe('before\tnew  \r\nafter\r\n');
});

test('fails closed on absent, ambiguous, and non-boundary selections', () => {
  expectCode(
    () => prepareProposal(BASE, quoteInput({
      operation: {
        type: 'quote',
        selector: { quote: 'missing' },
        replacement: 'new',
      },
    })),
    'correction-quote-not-found',
  );
  expectCode(
    () => prepareProposal(Buffer.from('old and old\n'), quoteInput({
      operation: {
        type: 'quote',
        selector: { quote: 'old' },
        replacement: 'new',
      },
    })),
    'correction-quote-ambiguous',
  );
  expectCode(
    () => prepareProposal(Buffer.from('a🧭b'), quoteInput({
      operation: { type: 'offset', start: 2, end: 3, replacement: 'x' },
    })),
    'correction-offset-not-utf8-boundary',
  );
});

test('rechecks quote uniqueness when applying an externally constructed proposal', () => {
  const base = Buffer.from('old and old\n');
  const proposal = prepareProposal(base, quoteInput({
    proposalId: 'quote:external-ambiguous',
    operation: {
      type: 'offset',
      start: 0,
      end: 3,
      replacement: 'new',
    },
  }));
  const external = mutable(proposal);
  external.operation.type = 'quote';
  external.operation.selector = {
    quote: 'old',
    prefix: null,
    suffix: null,
  };
  const parsed = parseProposal(serializeProposal(external));
  expectCode(
    () => applyProposal(base, parsed),
    'correction-quote-ambiguous',
  );
});

test('rejects no-op, whole-file, and oversize operations', () => {
  expectCode(
    () => prepareProposal(BASE, quoteInput({
      operation: {
        type: 'quote',
        selector: { quote: 'teh', prefix: 'A line about ', suffix: ' process.' },
        replacement: 'teh',
      },
    })),
    'no-op-proposal',
  );
  expectCode(
    () => prepareProposal(Buffer.from('whole'), quoteInput({
      operation: { type: 'offset', start: 0, end: 5, replacement: 'other' },
    })),
    'whole-file-operation',
  );
  const large = Buffer.from(`a${'x'.repeat(65 * 1024)}z`);
  expectCode(
    () => prepareProposal(large, quoteInput({
      operation: { type: 'offset', start: 1, end: large.length - 1, replacement: 'y' },
    })),
    'operation-span-too-large',
  );
});

test('enforces the complete artifact ceiling through every object API', () => {
  const prefix = 'p'.repeat(PROPOSAL_MAX_SPAN_BYTES);
  const quote = 'q'.repeat(PROPOSAL_MAX_SPAN_BYTES);
  const suffix = 's'.repeat(PROPOSAL_MAX_SPAN_BYTES);
  const replacement = 'r'.repeat(PROPOSAL_MAX_SPAN_BYTES);
  const base = Buffer.from(`${prefix}${quote}${suffix}`);

  expectCode(
    () => prepareProposal(base, quoteInput({
      proposalId: 'quote:oversize-artifact',
      operation: {
        type: 'quote',
        selector: { quote, prefix, suffix },
        replacement,
      },
    })),
    'proposal-too-large',
  );

  const offset = prepareProposal(base, quoteInput({
    proposalId: 'quote:oversize-object',
    operation: {
      type: 'offset',
      start: PROPOSAL_MAX_SPAN_BYTES,
      end: PROPOSAL_MAX_SPAN_BYTES * 2,
      replacement,
    },
  }));
  const external = mutable(offset);
  external.operation.type = 'quote';
  external.operation.selector = { quote, prefix, suffix };
  expectCode(() => validateProposal(external), 'proposal-too-large');
  expectCode(() => applyProposal(base, external), 'proposal-too-large');
});

test('accepts forge-neutral source identity including a non-default Forgejo port', () => {
  const proposal = prepareProposal(BASE, quoteInput({
    source: {
      repository: 'https://forge.example:8443/owner/wiki.git',
      revision: 'refs/immutable/snapshot:α',
      path: 'Knowledge/Example.md',
    },
  }));
  expect(proposal.source.repository).toBe('https://forge.example:8443/owner/wiki.git');
  expect(proposal.source.revision).toBe('refs/immutable/snapshot:α');
});

test('rejects credentialed, noncanonical, unsafe, and non-Markdown sources', () => {
  for (const repository of [
    'http://forge.example/owner/wiki.git',
    'https://user:secret@forge.example/owner/wiki.git',
    'https://forge.example:443/owner/wiki.git',
    'https://forge.example./owner/wiki.git',
    'https://forge.example/owner/%77iki.git',
    'https://forge.example/owner/%2fwiki.git',
    'https://forge.example/owner/wiki.git?',
    'https://forge.example/owner/wiki.git#',
    'https://forge.example/owner/wiki.git?token=x',
    'https://forge.example/owner/wiki.git/',
  ]) {
    expect(() => prepareProposal(BASE, quoteInput({
      source: { ...quoteInput().source, repository },
    }))).toThrow(ProposalError);
  }
  for (const path of ['/absolute.md', '../escape.md', 'a//b.md', 'a\\b.md', '.git/config.md', 'a.txt']) {
    expectCode(
      () => prepareProposal(BASE, quoteInput({
        source: { ...quoteInput().source, path },
      })),
      'invalid-source-path',
    );
  }
});

test('the structural JSON Schema stays aligned with the runtime envelope', () => {
  expect(proposalSchema.properties.schemaVersion.const).toBe(PROPOSAL_SCHEMA_VERSION);
  expect(proposalSchema.properties.artifactType.const).toBe(PROPOSAL_ARTIFACT_TYPE);
  expect(proposalSchema.additionalProperties).toBe(false);
  expect(proposalSchema.required).toEqual([
    'schemaVersion',
    'artifactType',
    'proposalId',
    'source',
    'operation',
    'submission',
  ]);
  expect(proposalSchema.properties.source.additionalProperties).toBe(false);
  expect(proposalSchema.properties.operation.additionalProperties).toBe(false);
  expect(proposalSchema.properties.submission.additionalProperties).toBe(false);

  const source = proposalSchema.properties.source.properties;
  const operation = proposalSchema.properties.operation.properties;
  const submission = proposalSchema.properties.submission.properties;
  const matches = (definition, value) => new RegExp(definition.pattern, 'u').test(value);
  expect(matches(source.repository, 'https://forge.example/owner/wiki.git')).toBe(true);
  expect(matches(source.repository, 'http://forge.example/owner/wiki.git')).toBe(false);
  expect(matches(source.repository, 'https://user@forge.example/owner/wiki.git')).toBe(false);
  expect(matches(source.repository, 'https://forge.example/owner/wiki.git?token=x')).toBe(false);
  expect(matches(source.path, 'Knowledge/Example.md')).toBe(true);
  expect(matches(source.path, '../escape.md')).toBe(false);
  expect(matches(source.path, 'a//b.md')).toBe(false);
  expect(matches(operation.baseDigest, 'arbitrary')).toBe(false);
  expect(matches(operation.candidateDigest, 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:')).toBe(true);
  expect(matches(operation.expectedOldBytesBase64, 'dGVo')).toBe(true);
  expect(matches(operation.expectedOldBytesBase64, 'dGVo===')).toBe(false);
  expect(matches(submission.evidence.items, 'https://example.com/source')).toBe(true);
  expect(matches(submission.evidence.items, 'http://example.com/source')).toBe(false);
  const claim = submission.identityClaim.oneOf[1].properties;
  expect(matches(claim.issuer, 'https://forge.example/')).toBe(true);
  expect(matches(claim.issuer, 'file:///tmp/claim')).toBe(false);
  expect(proposalSchema.properties.operation.allOf).toHaveLength(1);
  expect(operation.baseByteLength.minimum).toBe(0);
});

test('the JSON Schema rejects representative invalid complete artifacts', () => {
  const proposal = prepareProposal(BASE, quoteInput({
    submission: {
      ...quoteInput().submission,
      identityClaim: {
        type: 'human',
        issuer: 'https://forge.example/',
        subject: 'alice',
      },
    },
  }));
  expect(validateAgainstSchema(proposal)).toBe(true);

  const mutations = [
    (value) => { value.source.repository = 'http://forge.example/owner/wiki.git'; },
    (value) => { value.source.path = '../escape.md'; },
    (value) => { value.operation.baseDigest = 'arbitrary'; },
    (value) => { value.operation.expectedOldBytesBase64 = 'dGVo==='; },
    (value) => { value.operation.start = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.submission.submittedAt = '2026-02-30T00:00:00Z'; },
    (value) => { value.submission.rationale = '   '; },
    (value) => { value.submission.evidence = ['http://example.com/source']; },
    (value) => { value.submission.identityClaim.issuer = 'file:///tmp/claim'; },
  ];
  for (const mutateArtifact of mutations) {
    const invalid = mutable(proposal);
    mutateArtifact(invalid);
    expect(validateAgainstSchema(invalid)).toBe(false);
  }
});

test('canonical serialization is compact, ordered, and ends in one LF', () => {
  const proposal = prepareProposal(BASE, quoteInput());
  const text = serializeProposal(proposal);
  expect(text.endsWith('\n')).toBe(true);
  expect(text.endsWith('\n\n')).toBe(false);
  expect(text.includes('\n ')).toBe(false);
  expect(Object.keys(JSON.parse(text))).toEqual([
    'schemaVersion',
    'artifactType',
    'proposalId',
    'source',
    'operation',
    'submission',
  ]);
  expect(parseProposal(text)).toEqual(proposal);
  expect(parseProposal(Buffer.from(text))).toEqual(proposal);
});

test('rejects all noncanonical JSON encodings', () => {
  const proposal = prepareProposal(BASE, quoteInput());
  const canonical = serializeProposal(proposal);
  const reordered = JSON.stringify({
    artifactType: proposal.artifactType,
    schemaVersion: proposal.schemaVersion,
    proposalId: proposal.proposalId,
    source: proposal.source,
    operation: proposal.operation,
    submission: proposal.submission,
  }) + '\n';
  const duplicated = canonical.replace(
    '"schemaVersion":1,',
    '"schemaVersion":1,"schemaVersion":1,',
  );
  for (const value of [
    canonical.trimEnd(),
    `${canonical}\n`,
    canonical.replace(/\n$/u, '\r\n'),
    `${JSON.stringify(proposal, null, 2)}\n`,
    reordered,
    duplicated,
    ` ${canonical}`,
  ]) {
    expectCode(() => parseProposal(value), 'noncanonical-proposal');
  }
  expectCode(
    () => parseProposal(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)])),
    'utf8-bom',
  );
  expectCode(() => parseProposal(Buffer.from([0xff])), 'invalid-utf8');
});

test('rejects missing, unknown, and inconsistent fields', () => {
  const proposal = prepareProposal(BASE, quoteInput());
  const unknown = mutable(proposal);
  unknown.route = 'auto-merge';
  expectCode(() => validateProposal(unknown), 'unknown-field');

  const missing = mutable(proposal);
  delete missing.submission.rationale;
  expectCode(() => validateProposal(missing), 'missing-field');

  const selectorMismatch = mutable(proposal);
  selectorMismatch.operation.selector.quote = 'different';
  expectCode(() => validateProposal(selectorMismatch), 'selector-old-bytes-mismatch');

  const lengthMismatch = mutable(proposal);
  lengthMismatch.operation.candidateByteLength += 1;
  expectCode(() => validateProposal(lengthMismatch), 'candidate-length-mismatch');

  const noncanonicalBase64 = mutable(proposal);
  noncanonicalBase64.operation.expectedOldBytesBase64 = 'dGVo===';
  expectCode(() => validateProposal(noncanonicalBase64), 'invalid-base64');
});

test('rejects stale bases and tampered operation bindings before producing candidate bytes', () => {
  const proposal = prepareProposal(BASE, quoteInput());
  expectCode(
    () => applyProposal(Buffer.from(BASE_TEXT.replace('Tail', 'Sail')), proposal),
    'correction-base-digest-mismatch',
  );
  for (const field of [
    'expectedOldBytesBase64',
    'replacementBytesBase64',
    'candidateDigest',
  ]) {
    const tampered = mutable(proposal);
    if (field.endsWith('Base64')) {
      tampered.operation[field] = Buffer.from(field.startsWith('expected') ? 'xxx' : 'new').toString('base64');
    } else {
      tampered.operation[field] = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    }
    expect(() => applyProposal(BASE, tampered)).toThrow(ProposalError);
  }
});

test('validates timestamps, rationale, evidence, identity claims, and Unicode', () => {
  const proposal = prepareProposal(BASE, quoteInput({
    submission: {
      ...quoteInput().submission,
      evidence: ['https://example.com/a?view=1', 'https://example.com/b#section'],
      identityClaim: {
        type: 'human',
        issuer: 'https://forge.example/',
        subject: 'alice',
      },
    },
  }));
  expect(proposal.submission.identityClaim.subject).toBe('alice');

  for (const submittedAt of [
    '2026-08-10T12:34:56.000Z',
    '2026-02-30T12:34:56Z',
    '2026-08-10T12:34:56+00:00',
  ]) {
    expectCode(
      () => prepareProposal(BASE, quoteInput({
        submission: { ...quoteInput().submission, submittedAt },
      })),
      'invalid-timestamp',
    );
  }
  expectCode(
    () => prepareProposal(BASE, quoteInput({
      submission: { ...quoteInput().submission, rationale: '   ' },
    })),
    'invalid-rationale',
  );
  expectCode(
    () => prepareProposal(BASE, quoteInput({
      submission: { ...quoteInput().submission, rationale: '\ud800' },
    })),
    'invalid-unicode',
  );
  expectCode(
    () => prepareProposal(BASE, quoteInput({
      submission: {
        ...quoteInput().submission,
        evidence: ['https://example.com/a', 'https://example.com/a'],
      },
    })),
    'duplicate-evidence',
  );
});

test('rejects URL spelling aliases across evidence and identity metadata', () => {
  for (const evidence of [
    'https://example.com./source',
    'https://example.com/%73ource',
    'https://example.com/%2fsource',
  ]) {
    expectCode(
      () => prepareProposal(BASE, quoteInput({
        submission: {
          ...quoteInput().submission,
          evidence: [evidence],
        },
      })),
      'noncanonical-url',
    );
  }
  for (const issuer of [
    'https://forge.example./',
    'https://forge.example/%69ssuer',
    'https://forge.example/%2fissuer',
  ]) {
    expectCode(
      () => prepareProposal(BASE, quoteInput({
        submission: {
          ...quoteInput().submission,
          identityClaim: {
            type: 'human',
            issuer,
            subject: 'alice',
          },
        },
      })),
      'noncanonical-url',
    );
  }
  for (const issuer of [
    'https://forge.example/?',
    'https://forge.example/#',
  ]) {
    expectCode(
      () => prepareProposal(BASE, quoteInput({
        submission: {
          ...quoteInput().submission,
          identityClaim: {
            type: 'human',
            issuer,
            subject: 'alice',
          },
        },
      })),
      'invalid-url-components',
    );
  }
});

test('proposal digest is deterministic and binds all canonical fields', () => {
  const proposal = prepareProposal(BASE, quoteInput());
  const first = proposalDigest(proposal);
  expect(first).toMatch(new RegExp('^sha-256=:[A-Za-z0-9+/]{43}=:$', 'u'));
  expect(proposalDigest(proposal)).toBe(first);
  const changed = mutable(proposal);
  changed.submission.rationale = `${changed.submission.rationale} More context.`;
  expect(proposalDigest(changed)).not.toBe(first);
});

test('validated proposals are deeply frozen without mutating caller input', () => {
  const input = quoteInput();
  const snapshot = structuredClone(input);
  const proposal = prepareProposal(BASE, input);
  expect(input).toEqual(snapshot);
  expect(Object.isFrozen(proposal)).toBe(true);
  expect(Object.isFrozen(proposal.source)).toBe(true);
  expect(Object.isFrozen(proposal.operation.selector)).toBe(true);
  expect(Object.isFrozen(proposal.submission.evidence)).toBe(true);
});

test('identity claims cannot elevate trust without a receiver-verified subject', () => {
  const proposal = prepareProposal(BASE, quoteInput({
    submission: {
      ...quoteInput().submission,
      identityClaim: {
        type: 'agent',
        issuer: 'https://forge.example/',
        subject: 'cyberbaser-bot',
      },
    },
  }));
  const anonymous = classifyProposal(BASE, proposal, TRUST_CONFIG);
  expect(anonymous.tier).toBe('anonymous');
  expect(anonymous.route).toBe('full-review');

  const verified = classifyProposal(
    BASE,
    proposal,
    TRUST_CONFIG,
    { author: 'cyberbaser-bot', authorType: 'agent' },
  );
  expect(verified.tier).toBe('agent');
  expect(verified.route).toBe('auto-merge');
});

test('trust conversion derives exact before and after bytes and retains claims only as inert metadata', () => {
  const proposal = prepareProposal(BASE, quoteInput({
    submission: {
      ...quoteInput().submission,
      identityClaim: {
        type: 'human',
        issuer: 'https://forge.example/',
        subject: 'alice',
      },
    },
  }));
  const change = proposalToTrustChange(
    BASE,
    proposal,
    { author: 'alice@forge.example', authorType: 'human' },
  );
  expect(change.author).toBe('alice@forge.example');
  expect(change.files).toEqual([{
    path: 'docs/example.md',
    before: BASE_TEXT,
    after: BASE_TEXT.replace('teh process', 'the process'),
    status: 'modified',
  }]);
  expect(change.meta.identityClaim.subject).toBe('alice');
  expect(change.meta.proposalDigest).toBe(proposalDigest(proposal));
  expect(Object.isFrozen(change)).toBe(true);
});

test('rejects leading UTF-8 BOM additions and removals before trust classification', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const prepared = prepareProposal(BASE, quoteInput({
    proposalId: 'offset:add-leading-bom',
    operation: {
      type: 'offset',
      start: 0,
      end: 0,
      replacement: 'x',
    },
  }));
  const addition = mutable(prepared);
  const candidate = Buffer.concat([bom, BASE]);
  addition.operation.replacementBytesBase64 = bom.toString('base64');
  addition.operation.candidateByteLength = candidate.length;
  addition.operation.candidateDigest = `sha-256=:${createHash('sha256').update(candidate).digest('base64')}:`;
  expectCode(
    () => proposalToTrustChange(
      BASE,
      addition,
      { author: 'cyberbaser-bot', authorType: 'agent' },
    ),
    'leading-bom-change',
  );

  const bomBase = Buffer.concat([bom, BASE]);
  const removal = prepareProposal(bomBase, quoteInput({
    proposalId: 'offset:remove-leading-bom',
    operation: {
      type: 'offset',
      start: 0,
      end: bom.length,
      replacement: '',
    },
  }));
  expectCode(
    () => classifyProposal(
      bomBase,
      removal,
      TRUST_CONFIG,
      { author: 'cyberbaser-bot', authorType: 'agent' },
    ),
    'leading-bom-change',
  );
});

test('strips a stable leading BOM prefix before applying trust frontmatter controls', () => {
  const text = [
    '---',
    'title: Example',
    'published: false',
    '---',
    '',
    'Body',
    '',
  ].join('\n');
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const base = Buffer.concat([
    bom,
    bom,
    Buffer.from(text),
  ]);
  const proposal = prepareProposal(base, quoteInput({
    proposalId: 'quote:bom-frontmatter',
    operation: {
      type: 'quote',
      selector: {
        quote: 'false',
        prefix: 'published: ',
        suffix: '\n---',
      },
      replacement: 'true',
    },
  }));
  const decision = classifyProposal(
    base,
    proposal,
    TRUST_CONFIG,
    { author: 'cyberbaser-bot', authorType: 'agent' },
  );
  expect(decision.route).toBe('full-review');
  expect(decision.checks.frontmatter.changed).toEqual(['published']);
  expect(decision.checks.frontmatter.disallowed).toEqual(['published']);
});

test('rejects invalid receiver-verified subjects', () => {
  const proposal = prepareProposal(BASE, quoteInput());
  for (const subject of [
    {},
    { author: '', authorType: 'human' },
    { author: 'alice', authorType: 'anonymous' },
    { author: 'alice', authorType: 'human', extra: true },
  ]) {
    expectCode(
      () => proposalToTrustChange(BASE, proposal, subject),
      'invalid-verified-subject',
    );
  }
});

test('rejects an over-limit artifact before JSON parsing', () => {
  const bytes = Buffer.alloc(PROPOSAL_MAX_BYTES + 1, 0x20);
  expectCode(() => parseProposal(bytes), 'proposal-too-large');
});
