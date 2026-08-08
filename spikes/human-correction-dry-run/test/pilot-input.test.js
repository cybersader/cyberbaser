import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseStrictArgs } from '../src/cli.js';
import {
  convertReaderFieldsToCase,
  countsTowardPilot,
  createSubmissionRecord,
  evidenceClassification,
  operatorDefaults,
  validateDogfoodObservation,
  validateDogfoodObservationSeriesBinding,
  validateOperator,
  validateOperatorRepin,
  validateOwnerDogfoodSeriesCharter,
  validateOwnerDecision,
  validateSubmission,
} from '../src/pilot-input.js';

const TEMPLATE = path.resolve(import.meta.dir, '../templates/reader-form.html');
const V1_TEMPLATE = path.resolve(import.meta.dir, '../templates/reader-form-v1.html');
const FORM_FIELDS = Object.freeze({
  pageUrl: 'https://example.org/kb/guide',
  exactQuote: '  Exact line with é and emoji ✅  ',
  replacement: ' Replacement with café and ✅ ',
  rationale: '  Preserve every submitted byte.\nSecond line.  ',
  factualSource: 'not applicable',
  publicCreditName: 'Reader Name',
  creditConsent: 'no',
});

function validDogfoodOperator(overrides = {}) {
  const value = operatorDefaults('OD-01', 'owner-self-dogfood');
  return {
    ...value,
    checkoutDir: '/owner/cyberbase',
    baseCommit: '1234567890abcdef1234567890abcdef12345678',
    sourcePath: 'guide.md',
    publicUrl: 'https://cybersader.github.io/cyberbase/guide/',
    sourceAuthorizedForLocalProcessing: true,
    ...overrides,
  };
}

function validDogfoodSeries(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactType: 'private-owner-self-dogfood-series-charter',
    profile: 'owner-self-dogfood',
    attemptIds: ['OD-01', 'OD-02', 'OD-03'],
    obligationAssignments: {
      'normal-correction': 'OD-01',
      'signed-out-mobile-handoff': 'OD-01',
      'stale-source': 'OD-02',
      'ambiguous-quote': 'OD-02',
      'owner-rejection': 'OD-03',
    },
    plannedSignedOutMobile: {
      attemptId: 'OD-01',
      device: 'Owner phone',
      operatingSystem: 'Mobile OS',
      browser: 'Mobile browser',
      signedIn: false,
    },
    evidenceClassification: {
      evidenceClass: 'owner-self-dogfood',
      countsTowardHumanPilot: false,
      independentOwnerEvidence: false,
      claimBoundary: 'maintainer operational and mechanical evidence only',
    },
    ...overrides,
  };
}

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

  test('defaults to reader-form-v2 while preserving the historical v1 template', async () => {
    const [current, historical] = await Promise.all([
      readFile(TEMPLATE, 'utf8'),
      readFile(V1_TEMPLATE, 'utf8'),
    ]);
    expect(current).toContain("instrumentVersion: 'reader-form-v2'");
    expect(current).toContain('Replacement must differ from the exact quote.');
    expect(historical).toContain("instrumentVersion: 'reader-form-v1'");
    expect(historical).not.toContain('Replacement must differ from the exact quote.');
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
    expect(submission.instrumentVersion).toBe('reader-form-v2');
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
    expect(() => createSubmissionRecord({
      attemptId: 'HC-01',
      openedAt: '2026-07-28T12:00:00.000Z',
      submittedAt: '2026-07-28T12:00:05.000Z',
      elapsedMs: 5000,
      fields: { ...FORM_FIELDS, replacement: FORM_FIELDS.exactQuote },
    })).toThrow(/replacement must differ/u);
    const historical = createSubmissionRecord({
      attemptId: 'HC-01',
      openedAt: '2026-07-28T12:00:00.000Z',
      submittedAt: '2026-07-28T12:00:05.000Z',
      elapsedMs: 5000,
      instrumentVersion: 'reader-form-v1',
      fields: { ...FORM_FIELDS, replacement: FORM_FIELDS.exactQuote },
    });
    expect(historical.instrumentVersion).toBe('reader-form-v1');
    expect(historical.replacement).toBe(historical.exactQuote);
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
        .toThrow(/limited to non-counting rehearsal and owner-self-dogfood profiles/u);
    }
  });

  test('owner self-dogfood has a distinct ID namespace and can never claim independent evidence', () => {
    const operator = validateOperator(validDogfoodOperator());
    expect(operator.attemptId).toBe('OD-01');
    expect(evidenceClassification(operator)).toEqual({
      evidenceClass: 'owner-self-dogfood',
      countsTowardHumanPilot: false,
      independentOwnerEvidence: false,
      claimBoundary: 'maintainer operational and mechanical evidence only',
    });
    expect(countsTowardPilot(operator)).toBe(false);
    expect(() => operatorDefaults('HC-01', 'owner-self-dogfood'))
      .toThrow(/must use an OD-01 through OD-99 attempt ID/u);
    expect(() => operatorDefaults('OD-01', 'cyberbase-rehearsal'))
      .toThrow(/must use an HC-01 through HC-99 attempt ID/u);
    expect(() => validateOperator(validDogfoodOperator({ independentOwnerAttested: true })))
      .toThrow(/cannot claim independent-owner evidence/u);
  });

  test('operator repin changes only checkout and base while preserving the original binding', () => {
    const original = validDogfoodOperator();
    const replacement = {
      ...original,
      checkoutDir: '/owner/cyberbase-policy-bearing',
      baseCommit: 'abcdef1234567890abcdef1234567890abcdef12',
    };
    const artifact = {
      schemaVersion: 1,
      artifactType: 'private-owner-self-dogfood-operator-repin',
      attemptId: 'OD-01',
      reason: 'The original source pin predates publish.yml.',
      repinnedAt: '2026-07-31T13:00:00.000Z',
      previousCheckoutDir: original.checkoutDir,
      previousBaseCommit: original.baseCommit,
      publishConfigPresent: true,
      replacementOperator: replacement,
    };

    expect(validateOperatorRepin(artifact, original)).toMatchObject({
      previousBaseCommit: original.baseCommit,
      replacementOperator: { baseCommit: replacement.baseCommit },
    });
    expect(() => validateOperatorRepin({
      ...artifact,
      replacementOperator: { ...replacement, publicUrl: 'https://example.org/changed' },
    }, original)).toThrow(/may change only checkoutDir and baseCommit/u);
    expect(() => validateOperatorRepin({
      ...artifact,
      publishConfigPresent: false,
    }, original)).toThrow(/requires publish.yml/u);
    expect(() => validateOperatorRepin({
      ...artifact,
      replacementOperator: original,
    }, original)).toThrow(/different base commit/u);
    expect(() => validateOperatorRepin({
      ...artifact,
      extra: 'not allowed',
    }, original)).toThrow(/unknown field: extra/u);
  });

  test('owner self-dogfood observation keeps reader and owner contexts separate', () => {
    const observation = validateDogfoodObservation({
      schemaVersion: 1,
      attemptId: 'OD-01',
      evidenceClass: 'owner-self-dogfood',
      precommittedObligations: [
        'normal-correction',
        'signed-out-mobile-handoff',
      ],
      scenario: 'signed-out mobile handoff',
      readerContext: {
        device: 'Owner phone', operatingSystem: 'Mobile OS', browser: 'Mobile browser', signedIn: false,
      },
      ownerContext: {
        device: 'laptop', operatingSystem: 'desktop OS', browser: 'desktop browser', signedIn: true,
      },
      roleSeparation: 'same maintainer, separate reader and owner contexts',
      startedAt: '2026-07-30T12:00:00.000Z',
      completedAt: '',
      manualInterventions: ['private file transfer'],
      sourceWritePerformed: false,
      publicDeploymentPerformed: false,
      liveVerificationPerformed: false,
      notes: '',
    });
    expect(observation.readerContext.device).toBe('Owner phone');
    expect(observation.ownerContext.device).toBe('laptop');
    expect(
      validateDogfoodObservationSeriesBinding(observation, validDogfoodSeries()),
    ).toEqual(observation);
    expect(() => validateDogfoodObservationSeriesBinding({
      ...observation,
      precommittedObligations: ['signed-out-mobile-handoff'],
    }, validDogfoodSeries())).toThrow(/do not match the precommitted series assignment/u);
    for (const [field, value] of [
      ['device', 'Different phone'],
      ['operatingSystem', 'Different OS'],
      ['browser', 'Different browser'],
      ['signedIn', true],
    ]) {
      expect(() => validateDogfoodObservationSeriesBinding({
        ...observation,
        readerContext: { ...observation.readerContext, [field]: value },
      }, validDogfoodSeries())).toThrow(/does not match the precommitted signed-out mobile context/u);
    }
    expect(() => validateDogfoodObservation({
      ...observation,
      ownerContext: { ...observation.ownerContext, signedIn: 'yes' },
    })).toThrow(/signedIn must be boolean or null/u);
  });

  test('validates and freezes three-to-five-attempt owner dogfood series charters', () => {
    const three = validateOwnerDogfoodSeriesCharter(validDogfoodSeries());
    expect(three.attemptIds).toEqual(['OD-01', 'OD-02', 'OD-03']);
    expect(Object.isFrozen(three)).toBe(true);
    expect(Object.isFrozen(three.obligationAssignments)).toBe(true);
    expect(Object.isFrozen(three.plannedSignedOutMobile)).toBe(true);
    expect(Object.isFrozen(three.evidenceClassification)).toBe(true);

    const four = validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      attemptIds: ['OD-01', 'OD-02', 'OD-03', 'OD-04'],
      obligationAssignments: {
        'normal-correction': 'OD-01',
        'signed-out-mobile-handoff': 'OD-01',
        'stale-source': 'OD-02',
        'ambiguous-quote': 'OD-03',
        'owner-rejection': 'OD-04',
      },
    }));
    expect(four.attemptIds).toHaveLength(4);

    const five = validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      attemptIds: ['OD-01', 'OD-02', 'OD-03', 'OD-04', 'OD-05'],
      obligationAssignments: {
        'normal-correction': 'OD-01',
        'signed-out-mobile-handoff': 'OD-02',
        'stale-source': 'OD-03',
        'ambiguous-quote': 'OD-04',
        'owner-rejection': 'OD-05',
      },
      plannedSignedOutMobile: {
        attemptId: 'OD-02',
        device: 'Owner phone',
        operatingSystem: 'Mobile OS',
        browser: 'Mobile browser',
        signedIn: false,
      },
    }));
    expect(five.attemptIds).toHaveLength(5);
  });

  test('rejects incomplete, undeclared, signed-in, forged, and privacy-expanding series charters', () => {
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      attemptIds: ['OD-01', 'OD-02'],
    }))).toThrow(/three to five/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      attemptIds: ['OD-01', 'OD-02', 'OD-02'],
    }))).toThrow(/must be unique/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      attemptIds: ['OD-01', 'OD-02', 'HC-03'],
    }))).toThrow(/must use OD-01 through OD-99/u);
    for (const forbiddenField of [
      'candidate', 'sourcePath', 'url', 'quote', 'replacement', 'notes', 'decision', 'observation',
    ]) {
      expect(() => validateOwnerDogfoodSeriesCharter({
        ...validDogfoodSeries(),
        [forbiddenField]: 'private value',
      })).toThrow(new RegExp(`unknown field: ${forbiddenField}`, 'u'));
    }
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      plannedSignedOutMobile: {
        ...validDogfoodSeries().plannedSignedOutMobile,
        notes: 'private note',
      },
    }))).toThrow(/unknown field: notes/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      evidenceClassification: {
        ...validDogfoodSeries().evidenceClassification,
        ownerName: 'private owner',
      },
    }))).toThrow(/unknown field: ownerName/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      obligationAssignments: {
        ...validDogfoodSeries().obligationAssignments,
        'extra-scenario': 'OD-01',
      },
    }))).toThrow(/unknown field: extra-scenario/u);

    const missingObligation = validDogfoodSeries();
    delete missingObligation.obligationAssignments['owner-rejection'];
    expect(() => validateOwnerDogfoodSeriesCharter(missingObligation))
      .toThrow(/owner-rejection is required/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      obligationAssignments: {
        ...validDogfoodSeries().obligationAssignments,
        'owner-rejection': 'OD-04',
      },
    }))).toThrow(/must reference a declared OD attempt/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      attemptIds: ['OD-01', 'OD-02', 'OD-03', 'OD-04'],
    }))).toThrow(/OD-04 must have at least one obligation/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      plannedSignedOutMobile: {
        ...validDogfoodSeries().plannedSignedOutMobile,
        attemptId: 'OD-02',
      },
    }))).toThrow(/must match the signed-out-mobile-handoff obligation/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      plannedSignedOutMobile: {
        ...validDogfoodSeries().plannedSignedOutMobile,
        signedIn: true,
      },
    }))).toThrow(/must set signedIn to false/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      plannedSignedOutMobile: {
        ...validDogfoodSeries().plannedSignedOutMobile,
        device: '',
      },
    }))).toThrow(/must not be empty/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      plannedSignedOutMobile: {
        ...validDogfoodSeries().plannedSignedOutMobile,
        device: '   ',
      },
    }))).toThrow(/must contain a non-whitespace character/u);
    expect(() => validateOwnerDogfoodSeriesCharter(validDogfoodSeries({
      evidenceClassification: {
        ...validDogfoodSeries().evidenceClassification,
        countsTowardHumanPilot: true,
      },
    }))).toThrow(/must remain fixed/u);
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
