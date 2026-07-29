import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateCorrection } from '../src/evaluate.js';
import { convertReaderFieldsToCase } from '../src/pilot-input.js';
import { buildReviewCard } from '../src/review-card.js';
import { SYNTHETIC_OWNER_POLICY } from '../src/verification.js';

// SIMULATED ONLY: these fixtures exercise concierge conversion mechanics for
// differently phrased form-shaped inputs. They represent no human participant,
// usability result, completion time, owner preference, or accepted correction.

const COMMIT = '7777777777777777777777777777777777777777';
const REPOSITORY = 'https://example.org/simulated-adoption-kb';
let checkoutDir;

const scenarios = [
  {
    id: 'concise typo wording',
    sourcePath: 'guides/routing.md',
    source: '# Routing\n\nThe routre forwards the packet to the next hop.\n',
    form: {
      pageUrl: 'https://example.org/kb/routing',
      exactQuote: 'The routre forwards the packet to the next hop.',
      replacement: 'The router forwards the packet to the next hop.',
      rationale: '“Routre” is a typo; the sentence is referring to a router.',
      factualSource: 'not applicable',
      publicCreditName: '',
      creditConsent: 'no',
    },
    kind: 'typo',
  },
  {
    id: 'explanatory factual wording',
    sourcePath: 'guides/backups.md',
    source: '# Backups\n\nTest restored backups once each year.\n',
    form: {
      pageUrl: 'https://example.org/kb/backups',
      exactQuote: 'Test restored backups once each year.',
      replacement: 'Test restored backups on the schedule defined by the recovery policy.',
      rationale: 'A fixed annual cadence can contradict the owner’s recovery objectives, so the instruction should point to the governing policy.',
      factualSource: 'https://example.org/public-recovery-policy',
      publicCreditName: 'Simulated Reader A',
      creditConsent: 'yes',
    },
    kind: 'factual',
  },
  {
    id: 'direct deletion request',
    sourcePath: 'guides/deprecated.md',
    source: '# Deprecated step\n\nRun the retired command before continuing.\nContinue with the supported workflow.\n',
    form: {
      pageUrl: 'https://example.org/kb/deprecated',
      exactQuote: 'Run the retired command before continuing.',
      replacement: '',
      rationale: 'This step references a command that the page itself marks as retired.',
      factualSource: 'not applicable',
      publicCreditName: '',
      creditConsent: 'no',
    },
    kind: 'wording',
  },
  {
    id: 'informal reader phrasing with emoji',
    sourcePath: 'guides/status.md',
    source: '# Status\n\n✅ This check definately confirms the service is healthy.\n',
    form: {
      pageUrl: 'https://example.org/kb/status',
      exactQuote: '✅ This check definately confirms the service is healthy.',
      replacement: '✅ This check definitely confirms the service is healthy.',
      rationale: 'I noticed “definately” while following the checklist; “definitely” is the intended spelling.',
      factualSource: 'not applicable',
      publicCreditName: 'Simulated Reader B',
      creditConsent: 'no',
    },
    kind: 'typo',
  },
];

beforeAll(async () => {
  checkoutDir = await mkdtemp(path.join(os.tmpdir(), 'correction-adoption-simulated-'));
  for (const scenario of scenarios) {
    const file = path.join(checkoutDir, ...scenario.sourcePath.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, scenario.source, 'utf8');
  }
});

afterAll(async () => {
  if (checkoutDir) await rm(checkoutDir, { recursive: true, force: true });
});

describe('SIMULATED adoption-form conversion cases (not human usability evidence)', () => {
  for (const scenario of scenarios) {
    test(`SIMULATED: ${scenario.id} reaches deterministic no-write review evidence`, async () => {
      const caseData = convertReaderFieldsToCase(scenario.form, {
        repository: REPOSITORY,
        baseCommit: COMMIT,
        sourcePath: scenario.sourcePath,
      }, scenario.kind);

      const evaluation = await evaluateCorrection({
        caseData,
        checkoutDir,
        ownerPolicy: SYNTHETIC_OWNER_POLICY,
        policyRevision: 'simulated-adoption-policy-v1',
      });
      const card = buildReviewCard(evaluation);

      expect(evaluation.case.quote).toBe(scenario.form.exactQuote);
      expect(evaluation.case.replacement).toBe(scenario.form.replacement);
      expect(evaluation.case.rationale).toBe(scenario.form.rationale);
      expect(evaluation.noWrite.sourceWritePerformed).toBe(false);
      expect(card.evidence.scope).toContain('internal agentic evidence only');
      expect(card.evidence.scope).toContain('not a human pilot result');
      expect(card.evidence.status).toContain('pending-owner');
      expect(card.json).not.toContain(scenario.sourcePath);
      expect(card.json).not.toContain(scenario.form.publicCreditName || 'UNREACHABLE-CREDIT-CANARY');
    });
  }
});
