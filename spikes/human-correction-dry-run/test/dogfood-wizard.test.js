import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { caseId, stableStringify } from '../src/case.js';
import {
  DogfoodWizardCancelled,
  inspectDogfoodSeries,
  recordWizardOwnerDecision,
  runDogfoodWizard,
} from '../src/dogfood-wizard.js';
import {
  convertPilotSubmission,
  ownerDecisionTemplate,
} from '../src/pilot-input.js';
import {
  attemptPaths,
  initializeAttempt,
  initializeOwnerDogfoodSeries,
} from '../src/pilot-workspace.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../../..');
const PACKAGE_ROOT = path.resolve(PROJECT_ROOT, 'spikes', 'human-correction-dry-run');
const cleanup = [];

async function command(args, cwd, options = {}) {
  const child = Bun.spawn(args, {
    cwd,
    stdin: options.stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function dogfoodSeries() {
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
  };
}

function submission(attemptId = 'OD-01') {
  return {
    schemaVersion: 1,
    instrumentVersion: 'reader-form-v1',
    attemptId,
    openedAt: '2026-07-31T00:00:00.000Z',
    submittedAt: '2026-07-31T00:01:00.000Z',
    elapsedMs: 60_000,
    pageUrl: 'https://cybersader.github.io/cyberbase/guide/',
    exactQuote: 'Owner-selected sentence.',
    replacement: 'Owner-selected sentence corrected.',
    rationale: 'Correct the sentence.',
    factualSource: 'not applicable',
    publicCreditName: '',
    creditConsent: 'no',
  };
}

async function workspaceRoot() {
  const root = await mkdtemp(path.join(PROJECT_ROOT, '.workspace', 'dogfood-wizard-test-'));
  cleanup.push(root);
  return root;
}

async function cyberbaseCheckout() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dogfood-wizard-cyberbase-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n\nOwner-selected sentence.\n', 'utf8');
  for (const args of [
    ['git', 'init', '-q'],
    ['git', 'config', 'user.email', 'test@example.org'],
    ['git', 'config', 'user.name', 'Test User'],
    ['git', 'add', '.'],
    ['git', 'commit', '-q', '-m', 'fixture'],
    ['git', 'remote', 'add', 'origin', 'https://github.com/cybersader/cyberbase.git'],
  ]) {
    const result = await command(args, root);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  }
  return root;
}

async function initializedWorkspace() {
  const workspace = await workspaceRoot();
  await initializeOwnerDogfoodSeries({
    charter: dogfoodSeries(),
    projectRoot: PROJECT_ROOT,
    workspaceRoot: workspace,
  });
  const checkoutDir = await cyberbaseCheckout();
  await initializeAttempt({
    attemptId: 'OD-01',
    profile: 'owner-self-dogfood',
    checkoutDir,
    sourcePath: 'docs/guide.md',
    publicUrl: 'https://cybersader.github.io/cyberbase/guide/',
    sourceAuthorization: 'yes',
    projectRoot: PROJECT_ROOT,
    workspaceRoot: workspace,
  });
  return {
    workspace,
    paths: attemptPaths('OD-01', { projectRoot: PROJECT_ROOT, workspaceRoot: workspace }),
  };
}

async function renderedEligibleWorkspace() {
  const fixture = await initializedWorkspace();
  const input = submission();
  await writeFile(fixture.paths.submission, stableStringify(input), 'utf8');
  const operator = JSON.parse(await readFile(fixture.paths.operator, 'utf8'));
  const mechanicalCaseId = caseId(convertPilotSubmission(input, operator));
  const runDir = path.join(fixture.paths.runs, mechanicalCaseId);
  await mkdir(runDir);
  const template = ownerDecisionTemplate('OD-01', {
    mechanicalCaseId,
    candidateDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
  });
  await writeFile(path.join(runDir, 'status.json'), stableStringify({
    schemaVersion: 2,
    artifactType: 'private-human-correction-pilot-preparation',
    attemptId: 'OD-01',
    mechanicalCaseId,
    profile: 'owner-self-dogfood',
    countsTowardPilot: false,
    evidenceClass: 'owner-self-dogfood',
    countsTowardHumanPilot: false,
    independentOwnerEvidence: false,
    claimBoundary: 'maintainer operational and mechanical evidence only',
    ownerDecisionEligible: true,
    blockingReasons: [],
    noWrite: {
      suppliedCheckoutWritePerformed: false,
      automaticSourceApplicationPerformed: false,
      publicDeploymentPerformed: false,
    },
  }), 'utf8');
  await writeFile(path.join(runDir, 'owner-decision-template.json'), stableStringify(template), 'utf8');
  await writeFile(path.join(runDir, 'render-evidence.json'), stableStringify({
    artifactType: 'private-local-rendered-correction-run',
  }), 'utf8');
  await writeFile(fixture.paths.ownerDecision, stableStringify(template), 'utf8');
  const state = await inspectDogfoodSeries({
    projectRoot: PROJECT_ROOT,
    workspaceRoot: fixture.workspace,
  });
  return { ...fixture, attempt: state.attempts[0] };
}

class ScriptedUi {
  constructor({ selects = [], inputs = [], confirms = [] } = {}) {
    this.selects = [...selects];
    this.inputs = [...inputs];
    this.confirms = [...confirms];
    this.messages = [];
    this.seenChoices = [];
    this.pauses = 0;
    this.resumes = 0;
    this.actionStarts = 0;
    this.actionEnds = 0;
  }

  write(message) { this.messages.push(String(message)); }

  async select(message, choices) {
    this.seenChoices.push({ message, choices });
    if (this.selects.length === 0) throw new Error(`no scripted selection for ${message}`);
    const value = this.selects.shift();
    if (!choices.some((item) => item.value === value)) {
      throw new Error(`selection ${value} is not available for ${message}`);
    }
    return value;
  }

  async input(message) {
    if (this.inputs.length === 0) throw new Error(`no scripted input for ${message}`);
    const value = this.inputs.shift();
    if (value instanceof Error) throw value;
    return value;
  }

  async confirm(message) {
    if (this.confirms.length === 0) throw new Error(`no scripted confirmation for ${message}`);
    return this.confirms.shift();
  }

  async pause() { this.pauses += 1; }
  async resume() { this.resumes += 1; }
  beginAction() { this.actionStarts += 1; }
  endAction() { this.actionEnds += 1; }
}

function fakeState(stage = 'awaiting-submission', attemptId = 'OD-01') {
  const paths = attemptPaths(attemptId);
  const attempt = {
    attemptId,
    obligations: attemptId === 'OD-03' ? ['owner-rejection'] : ['normal-correction'],
    stage,
    stageLabel: stage.replaceAll('-', ' '),
    blockingReasons: [],
    paths,
    mechanicalCaseId: stage.includes('decision') || stage === 'awaiting-decision'
      ? 'DRY-0123456789AB'
      : undefined,
    runDir: path.join(paths.runs, 'DRY-0123456789AB'),
    reviewPath: path.join(paths.runs, 'DRY-0123456789AB', 'owner-rendered-review.html'),
    template: stage === 'awaiting-decision'
      ? ownerDecisionTemplate(attemptId, {
          mechanicalCaseId: 'DRY-0123456789AB',
          candidateDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
        })
      : undefined,
  };
  return {
    series: dogfoodSeries(),
    attempts: [attempt],
    suggestedAttemptId: attemptId,
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('dogfood series inspection', () => {
  test('derives the current declared attempt stages without adopting undeclared folders', async () => {
    const fixture = await initializedWorkspace();
    await mkdir(path.join(fixture.workspace, 'attempts', 'OD-99'), { recursive: true });
    const state = await inspectDogfoodSeries({
      projectRoot: PROJECT_ROOT,
      workspaceRoot: fixture.workspace,
    });
    expect(state.attempts.map((attempt) => [attempt.attemptId, attempt.stage])).toEqual([
      ['OD-01', 'awaiting-submission'],
      ['OD-02', 'not-initialized'],
      ['OD-03', 'not-initialized'],
    ]);
    expect(state.suggestedAttemptId).toBe('OD-01');
  });

  test('fails closed when the generated reader instrument was changed', async () => {
    const fixture = await initializedWorkspace();
    await writeFile(fixture.paths.readerForm, '<script>changed</script>', 'utf8');
    await expect(inspectDogfoodSeries({
      projectRoot: PROJECT_ROOT,
      workspaceRoot: fixture.workspace,
    })).rejects.toMatchObject({ code: 'reader-form-integrity-mismatch' });
  });

  test('distinguishes submitted, prepared, rendered, recorded, and validated stages', async () => {
    const fixture = await initializedWorkspace();
    const input = submission();
    await writeFile(fixture.paths.submission, stableStringify(input), 'utf8');
    let state = await inspectDogfoodSeries({ projectRoot: PROJECT_ROOT, workspaceRoot: fixture.workspace });
    expect(state.attempts[0].stage).toBe('submitted');

    const operator = JSON.parse(await readFile(fixture.paths.operator, 'utf8'));
    const mechanicalCaseId = caseId(convertPilotSubmission(input, operator));
    const runDir = path.join(fixture.paths.runs, mechanicalCaseId);
    await mkdir(runDir);
    const template = ownerDecisionTemplate('OD-01', {
      mechanicalCaseId,
      candidateDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    });
    const status = {
      schemaVersion: 2,
      artifactType: 'private-human-correction-pilot-preparation',
      attemptId: 'OD-01',
      mechanicalCaseId,
      profile: 'owner-self-dogfood',
      countsTowardPilot: false,
      evidenceClass: 'owner-self-dogfood',
      countsTowardHumanPilot: false,
      independentOwnerEvidence: false,
      claimBoundary: 'maintainer operational and mechanical evidence only',
      ownerDecisionEligible: false,
      blockingReasons: ['render-evidence-required'],
      noWrite: {
        suppliedCheckoutWritePerformed: false,
        automaticSourceApplicationPerformed: false,
        publicDeploymentPerformed: false,
      },
    };
    await writeFile(path.join(runDir, 'status.json'), stableStringify(status), 'utf8');
    await writeFile(path.join(runDir, 'owner-decision-template.json'), stableStringify(template), 'utf8');
    await writeFile(fixture.paths.ownerDecision, stableStringify(template), 'utf8');
    state = await inspectDogfoodSeries({ projectRoot: PROJECT_ROOT, workspaceRoot: fixture.workspace });
    expect(state.attempts[0].stage).toBe('prepared');

    status.ownerDecisionEligible = true;
    status.blockingReasons = [];
    await writeFile(path.join(runDir, 'status.json'), stableStringify(status), 'utf8');
    await writeFile(path.join(runDir, 'render-evidence.json'), stableStringify({
      artifactType: 'private-local-rendered-correction-run',
    }), 'utf8');
    state = await inspectDogfoodSeries({ projectRoot: PROJECT_ROOT, workspaceRoot: fixture.workspace });
    expect(state.attempts[0].stage).toBe('awaiting-decision');

    const decision = await recordWizardOwnerDecision({
      attempt: state.attempts[0],
      decision: 'accept',
      reason: 'Owner accepts this bounded candidate.',
      reviewSeconds: 30,
      decidedAt: '2026-07-31T00:02:00.000Z',
    });
    state = await inspectDogfoodSeries({ projectRoot: PROJECT_ROOT, workspaceRoot: fixture.workspace });
    expect(state.attempts[0].stage).toBe('decision-recorded');

    await writeFile(path.join(runDir, 'validated-owner-decision.json'), stableStringify({
      artifactType: 'private-validated-owner-self-dogfood-decision',
      ...decision,
      schemaVersion: 2,
      evidenceClass: 'owner-self-dogfood',
      countsTowardHumanPilot: false,
      independentOwnerEvidence: false,
      ownerDecisionEligibleAtValidation: true,
      sourceWritePerformed: false,
      publicDeploymentPerformed: false,
    }), 'utf8');
    state = await inspectDogfoodSeries({ projectRoot: PROJECT_ROOT, workspaceRoot: fixture.workspace });
    expect(state.attempts[0].stage).toBe('decision-validated');
  });

  test('allows only one concurrent owner-decision replacement', async () => {
    const fixture = await renderedEligibleWorkspace();
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => (
      recordWizardOwnerDecision({
        attempt: fixture.attempt,
        decision: index % 2 === 0 ? 'accept' : 'reject',
        reason: `Concurrent owner decision ${index + 1}.`,
        reviewSeconds: index,
        decidedAt: `2026-07-31T00:02:${String(index).padStart(2, '0')}.000Z`,
      })
    )));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(19);
    expect(rejected.every((outcome) => outcome.reason.code === 'artifact-already-exists')).toBe(true);
    const stored = JSON.parse(await readFile(
      path.join(fixture.attempt.runDir, 'wizard-owner-decision.json'),
      'utf8',
    ));
    expect(['accept', 'reject']).toContain(stored.decision);
    const canonical = JSON.parse(await readFile(fixture.paths.ownerDecision, 'utf8'));
    expect(canonical.decision).toBe('');
  });
});

describe('guided action orchestration', () => {
  test('stops with exact CLI guidance when the charter is missing', async () => {
    const ui = new ScriptedUi();
    const result = await runDogfoodWizard({
      ui,
      inspect: async () => {
        throw Object.assign(new Error('missing charter'), { code: 'dogfood-series-required' });
      },
    });
    expect(result).toEqual({ reason: 'charter-required' });
    expect(ui.messages.join('\n')).toContain('dogfood:series-init');
  });

  test('serves the recommended attempt with a suggested expiry and returns to the menu', async () => {
    const ui = new ScriptedUi({
      selects: ['OD-01', 'serve', '15', 'back', 'exit'],
      confirms: [true],
    });
    const calls = [];
    await runDogfoodWizard({
      ui,
      inspect: async () => fakeState('awaiting-submission'),
      actionOverrides: {
        serve: async (options) => {
          calls.push(options);
          return {
            dnsUrl: 'http://node.example.ts.net:48731/secret',
            ipUrl: 'http://100.64.0.42:48731/secret',
            expiresAt: Date.parse('2026-07-31T00:15:00.000Z'),
            completion: Promise.resolve({ reason: 'served' }),
            stop: async () => {},
          };
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ attemptId: 'OD-01', expiresMinutes: 15 });
    expect(ui.pauses).toBe(1);
    expect(ui.resumes).toBe(1);
    expect(ui.messages.join('\n')).toContain('expiring secret');
  });

  test('cancels attempt initialization before any write or error log', async () => {
    const ui = new ScriptedUi({
      selects: ['OD-02', 'initialize', 'back', 'exit'],
      inputs: ['/clean/checkout', 'docs/guide.md', 'https://example.org/guide/'],
      confirms: [false],
    });
    let initialized = 0;
    let logged = 0;
    await runDogfoodWizard({
      ui,
      inspect: async () => fakeState('not-initialized', 'OD-02'),
      actionOverrides: {
        initializeAttempt: async () => { initialized += 1; },
        recordError: async () => { logged += 1; },
      },
    });
    expect(initialized).toBe(0);
    expect(logged).toBe(0);
  });

  test('records failed initialization globally without creating a phantom attempt', async () => {
    const workspace = await workspaceRoot();
    await initializeOwnerDogfoodSeries({
      charter: dogfoodSeries(),
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    const ui = new ScriptedUi({
      selects: ['OD-02', 'initialize', 'back', 'exit'],
      inputs: ['/definitely/missing/cyberbase', 'docs/guide.md', 'https://example.org/guide/'],
      confirms: [true, true],
    });
    await runDogfoodWizard({ ui, projectRoot: PROJECT_ROOT, workspaceRoot: workspace });
    await expect(access(path.join(workspace, 'attempts', 'OD-02'))).rejects.toMatchObject({ code: 'ENOENT' });
    await access(path.join(workspace, 'logs'));
    expect(ui.messages.join('\n')).toContain('checkout-head-unavailable');
    expect(ui.actionStarts).toBe(1);
    expect(ui.actionEnds).toBe(1);
  });

  test('cancels preparation without running or logging an action', async () => {
    const ui = new ScriptedUi({
      selects: ['OD-01', 'prepare', 'back', 'exit'],
      confirms: [false],
    });
    let prepared = 0;
    let logged = 0;
    await runDogfoodWizard({
      ui,
      inspect: async () => fakeState('submitted'),
      actionOverrides: {
        prepare: async () => { prepared += 1; },
        recordError: async () => { logged += 1; },
      },
    });
    expect(prepared).toBe(0);
    expect(logged).toBe(0);
  });

  test('records a named failure only after a confirmed workflow action', async () => {
    const ui = new ScriptedUi({
      selects: ['OD-01', 'prepare', 'back', 'exit'],
      confirms: [true],
    });
    const logs = [];
    await runDogfoodWizard({
      ui,
      inspect: async () => fakeState('submitted'),
      actionOverrides: {
        prepare: async () => {
          throw Object.assign(new Error('quote occurs twice'), { code: 'quote-ambiguous' });
        },
        recordError: async (value) => { logs.push(value); },
      },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].error.code).toBe('quote-ambiguous');
    expect(ui.messages.join('\n')).toContain('quote-ambiguous');
    expect(ui.actionStarts).toBe(1);
    expect(ui.actionEnds).toBe(1);
  });

  test('requires explicit rejection for the precommitted rejection attempt', async () => {
    const ui = new ScriptedUi({
      selects: ['OD-03', 'record-decision', 'reject', 'back', 'exit'],
      inputs: ['The owner intentionally rejects this candidate.', '20'],
      confirms: [true],
    });
    const recorded = [];
    await runDogfoodWizard({
      ui,
      inspect: async () => fakeState('awaiting-decision', 'OD-03'),
      clock: () => Date.parse('2026-07-31T00:03:00.000Z'),
      actionOverrides: {
        recordDecision: async (value) => {
          recorded.push(value);
          return { decision: value.decision };
        },
      },
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      decision: 'reject',
      reason: 'The owner intentionally rejects this candidate.',
      reviewSeconds: 20,
      decidedAt: '2026-07-31T00:03:00.000Z',
    });
    const decisionMenu = ui.seenChoices.find((entry) => entry.message === 'What is your editorial decision?');
    expect(decisionMenu.choices.map((item) => item.value)).toEqual(['reject', 'cancel']);
  });

  test('guards and logs a confirmed owner-decision failure', async () => {
    const ui = new ScriptedUi({
      selects: ['OD-01', 'record-decision', 'accept', 'back', 'exit'],
      inputs: ['The candidate is acceptable.', '15'],
      confirms: [true],
    });
    const logs = [];
    await runDogfoodWizard({
      ui,
      inspect: async () => fakeState('awaiting-decision'),
      clock: () => Date.parse('2026-07-31T00:03:00.000Z'),
      actionOverrides: {
        recordDecision: async () => {
          throw Object.assign(new Error('another owner session won'), { code: 'artifact-already-exists' });
        },
        recordError: async (value) => { logs.push(value); },
      },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].error.code).toBe('artifact-already-exists');
    expect(ui.actionStarts).toBe(1);
    expect(ui.actionEnds).toBe(1);
  });

  test('does not timestamp or write a decision before final confirmation', async () => {
    const ui = new ScriptedUi({
      selects: ['OD-01', 'record-decision', 'accept', 'back', 'exit'],
      inputs: ['The candidate is acceptable.', '15'],
      confirms: [false],
    });
    let clockCalls = 0;
    let writes = 0;
    await runDogfoodWizard({
      ui,
      inspect: async () => fakeState('awaiting-decision'),
      clock: () => {
        clockCalls += 1;
        return Date.parse('2026-07-31T00:03:00.000Z');
      },
      actionOverrides: { recordDecision: async () => { writes += 1; } },
    });
    expect(clockCalls).toBe(0);
    expect(writes).toBe(0);
  });

  test('EOF during decision entry invokes no writer', async () => {
    const ui = new ScriptedUi({
      selects: ['OD-01', 'record-decision', 'accept'],
      inputs: [new DogfoodWizardCancelled()],
    });
    let writes = 0;
    await expect(runDogfoodWizard({
      ui,
      inspect: async () => fakeState('awaiting-decision'),
      actionOverrides: { recordDecision: async () => { writes += 1; } },
    })).rejects.toBeInstanceOf(DogfoodWizardCancelled);
    expect(writes).toBe(0);
  });
});

describe('guided CLI boundary', () => {
  test('rejects non-TTY and flag-bearing invocations before workspace access', async () => {
    const nonTty = await command(['bun', 'run', 'bin/dogfood.js'], PACKAGE_ROOT, { stdin: 'pipe' });
    expect(nonTty.exitCode).toBe(2);
    expect(nonTty.stderr).toContain('requires an interactive terminal');
    expect(nonTty.stdout).not.toContain('http://');

    const flags = await command(['bun', 'run', 'bin/dogfood.js', '--attempt', 'OD-01'], PACKAGE_ROOT, {
      stdin: 'pipe',
    });
    expect(flags.exitCode).toBe(2);
    expect(flags.stderr).toContain('accepts no flags');
    expect(flags.stdout).not.toContain('http://');
  });
});
