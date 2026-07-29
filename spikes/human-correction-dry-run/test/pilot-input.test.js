import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseStrictArgs } from '../src/cli.js';
import {
  convertReaderFieldsToCase,
  countsTowardPilot,
  createSubmissionRecord,
  operatorDefaults,
  validateOperator,
  validateOwnerDecision,
  validateSubmission,
} from '../src/pilot-input.js';

const TEMPLATE = path.resolve(import.meta.dir, '../templates/reader-form.html');
const FORM_FIELDS = Object.freeze({
  pageUrl: 'https://example.org/kb/guide',
  exactQuote: '  Exact line with é and emoji ✅  ',
  replacement: ' Replacement with café and ✅ ',
  rationale: '  Preserve every submitted byte.\nSecond line.  ',
  factualSource: 'not applicable',
  publicCreditName: 'Reader Name',
  creditConsent: 'no',
});

function validIndependentOperator(overrides = {}) {
  return {
    schemaVersion: 1,
    attemptId: 'HC-01',
    profile: 'independent-counted',
    repository: 'https://example.org/owner/kb',
    checkoutDir: '/absolute/owner/kb',
    baseCommit: '1234567890abcdef1234567890abcdef12345678',
    sourcePath: 'docs/guide.md',
    publicUrl: 'https://example.org/kb/guide',
    sourceAuthorizedForLocalProcessing: true,
    independentOwnerAttested: true,
    readerUnaided: true,
    accessInterruption: false,
    correctionKind: 'wording',
    selectorContext: {},
    ownerPolicyRevision: 'owner-policy-v1',
    ownerPolicy: {
      trusted: [], agents: [],
      caps: { lines: 10, files: 1, proseWords: 25, typoLines: 4, typoWords: 4 },
      allowedNewFolders: [], frontmatterAllowlist: [],
    },
    publicationBoundary: 'not-applicable',
    renderer: {
      profile: 'owner-static-output',
      basePath: 'kb',
      buildCommand: 'owner-build --baseline and owner-build --candidate',
    },
    ...overrides,
  };
}

describe('reader form contract', () => {
  test('contains exactly the seven canonical participant fields in order', async () => {
    const html = await readFile(TEMPLATE, 'utf8');
    const names = [...html.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"/gu)]
      .map((match) => match[1]);
    expect(names).toEqual([
      'pageUrl',
      'exactQuote',
      'replacement',
      'rationale',
      'factualSource',
      'publicCreditName',
      'creditConsent',
    ]);
    expect(html).toContain('Paste the URL of the page you want to correct.');
    expect(html).toContain('Copy one exact line that should change.');
    expect(html).toContain('Browser textareas normalize pasted line endings');
    expect(html).toContain('Study instrument, not a product endpoint.');
    expect(html).toContain('__PROFILE_NOTICE__');
  });

  test('has no network target, remote resource, storage call, account field, or contact collector', async () => {
    const html = await readFile(TEMPLATE, 'utf8');
    expect(html).not.toMatch(/<form[^>]+(?:action|method)=/iu);
    expect(html).not.toMatch(/<(?:script|link|img|iframe)[^>]+(?:src|href)=/iu);
    expect(html).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB)\b/u);
    expect(html).not.toMatch(/name="(?:email|username|account|ip|sourcePath|credential|contact|demographic)/iu);
    expect(html).not.toContain('type="email"');
  });

  test('serialization preserves supported single-line text exactly and rejects normalized multiline change fields', () => {
    const submission = createSubmissionRecord({
      attemptId: 'HC-01',
      openedAt: '2026-07-28T12:00:00.000Z',
      submittedAt: '2026-07-28T12:00:05.000Z',
      elapsedMs: 5000,
      fields: { ...FORM_FIELDS, replacement: '' },
    });
    expect(submission.exactQuote).toBe(FORM_FIELDS.exactQuote);
    expect(submission.replacement).toBe('');
    expect(submission.rationale).toBe(FORM_FIELDS.rationale);
    expect(submission.elapsedMs).toBe(5000);
    expect(Object.keys(submission).slice(3, 6)).toEqual(['openedAt', 'submittedAt', 'elapsedMs']);
    expect(() => createSubmissionRecord({
      attemptId: 'HC-01',
      openedAt: '2026-07-28T12:00:00.000Z',
      submittedAt: '2026-07-28T12:00:05.000Z',
      elapsedMs: 5000,
      fields: { ...FORM_FIELDS, exactQuote: 'line 1\nline 2' },
    })).toThrow(/must be one line/u);
    expect(() => createSubmissionRecord({
      attemptId: 'HC-01',
      openedAt: '2026-07-28T12:00:00.000Z',
      submittedAt: '2026-07-28T12:00:05.000Z',
      elapsedMs: 5000,
      fields: { ...FORM_FIELDS, replacement: 'line 1\r\nline 2' },
    })).toThrow(/must be one line/u);
  });
});

describe('strict pilot schemas and deterministic conversion', () => {
  test('one strict CLI parser rejects unknown and duplicate pilot arguments', () => {
    expect(parseStrictArgs(['--attempt', 'HC-01'], {
      allowed: ['attempt'], required: ['attempt'],
    })).toEqual({ attempt: 'HC-01' });
    expect(() => parseStrictArgs(['--unknown', 'value'], {
      allowed: ['attempt'], required: [],
    })).toThrow(/unknown argument/u);
    expect(() => parseStrictArgs(['--attempt', 'HC-01', '--attempt', 'HC-02'], {
      allowed: ['attempt'], required: ['attempt'],
    })).toThrow(/duplicate argument/u);
  });

  test('rejects unknown submission fields and credit-consent inconsistencies', () => {
    const submission = createSubmissionRecord({
      attemptId: 'HC-01',
      openedAt: '2026-07-28T12:00:00.000Z',
      submittedAt: '2026-07-28T12:00:05.000Z',
      elapsedMs: 5000,
      fields: FORM_FIELDS,
    });
    expect(() => validateSubmission({ ...submission, email: 'reader@example.org' }))
      .toThrow(/unknown field: email/u);
    expect(() => validateSubmission({ ...submission, publicCreditName: '', creditConsent: 'yes' }))
      .toThrow(/credit consent yes requires/u);
  });

  test('independent-counted fails without explicit attestation, authorization, mapping, pin, or renderer details', () => {
    expect(() => validateOperator(validIndependentOperator({ independentOwnerAttested: false })))
      .toThrow(/independent-owner attestation/u);
    expect(() => validateOperator(validIndependentOperator({ sourceAuthorizedForLocalProcessing: false })))
      .toThrow(/authorization/u);
    expect(() => validateOperator(validIndependentOperator({ sourcePath: '' }))).toThrow(/must not be empty/u);
    expect(() => validateOperator(validIndependentOperator({ baseCommit: '' }))).toThrow(/must not be empty/u);
    expect(() => validateOperator(validIndependentOperator({
      renderer: { profile: 'owner-static-output', basePath: 'kb', buildCommand: '' },
    }))).toThrow(/must not be empty/u);
  });

  test('the preparation kit never labels synthetic or pre-decision records as counted evidence', () => {
    const rehearsal = operatorDefaults('HC-01', 'cyberbase-rehearsal');
    rehearsal.checkoutDir = '/owner/cyberbase';
    rehearsal.baseCommit = '1234567890abcdef1234567890abcdef12345678';
    rehearsal.sourcePath = 'guide.md';
    rehearsal.publicUrl = 'https://example.org/cyberbase/guide';
    rehearsal.sourceAuthorizedForLocalProcessing = true;
    expect(countsTowardPilot(rehearsal)).toBe(false);
    expect(countsTowardPilot(validIndependentOperator())).toBe(false);
    expect(countsTowardPilot(validIndependentOperator({ readerUnaided: false }))).toBe(false);
    expect(countsTowardPilot(validIndependentOperator({ accessInterruption: true }))).toBe(false);
    for (const repository of [
      'https://github.com/cybersader/cyberbase',
      'https://github.com/cybersader/cyberbase/',
      'https://github.com/cybersader/cyberbase.git',
    ]) {
      expect(() => validateOperator(validIndependentOperator({ repository })))
        .toThrow(/permanently limited to the zero-count rehearsal profile/u);
    }
  });

  test('owner-decision identifiers must use prepared-run formats before binding validation', () => {
    expect(() => validateOwnerDecision({
      schemaVersion: 1,
      attemptId: 'HC-01',
      mechanicalCaseId: 'WRONG-RUN',
      candidateDigest: 'WRONG-DIGEST',
      decision: 'accept',
      reason: 'Invalid binding fixture.',
      reviewSeconds: 1,
      decidedAt: '2026-07-28T12:00:00.000Z',
    })).toThrow(/mechanicalCaseId is invalid/u);
  });

  test('form-to-case conversion is deterministic and byte exact', () => {
    const mapping = {
      repository: 'https://example.org/owner/kb',
      baseCommit: '1234567890abcdef1234567890abcdef12345678',
      sourcePath: 'docs/guide.md',
      publicUrl: FORM_FIELDS.pageUrl,
      selectorContext: { prefix: 'prefix\n', suffix: '\nsuffix' },
    };
    const first = convertReaderFieldsToCase(FORM_FIELDS, mapping, 'wording');
    const second = convertReaderFieldsToCase(FORM_FIELDS, mapping, 'wording');
    expect(second).toEqual(first);
    expect(first.quote).toBe(FORM_FIELDS.exactQuote);
    expect(first.replacement).toBe(FORM_FIELDS.replacement);
    expect(first.rationale).toBe(FORM_FIELDS.rationale);
    expect(first.prefix).toBe('prefix\n');
    expect(first.suffix).toBe('\nsuffix');
  });

  test('public credit never changes the forced anonymous trust inputs', () => {
    const withoutCredit = convertReaderFieldsToCase(
      { ...FORM_FIELDS, publicCreditName: '', creditConsent: 'no' },
      {
        repository: 'https://example.org/owner/kb',
        baseCommit: '1234567890abcdef1234567890abcdef12345678',
        sourcePath: 'docs/guide.md',
      },
      'wording',
    );
    const withCredit = convertReaderFieldsToCase(
      { ...FORM_FIELDS, publicCreditName: 'Public Reader', creditConsent: 'yes' },
      {
        repository: 'https://example.org/owner/kb',
        baseCommit: '1234567890abcdef1234567890abcdef12345678',
        sourcePath: 'docs/guide.md',
      },
      'wording',
    );
    expect(withCredit).toEqual(withoutCredit);
    expect(withCredit).not.toHaveProperty('author');
    expect(withCredit).not.toHaveProperty('publicCreditName');
  });
});
