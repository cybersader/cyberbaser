import { afterEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildProjection,
  candidateOnlyLinkDelta,
  captureRenderedTargetEvidence,
  runLiveCorrection,
} from '../src/live-run.js';
import { SYNTHETIC_OWNER_POLICY } from '../src/verification.js';

const temporaryDirectories = [];
const COMMIT = '6666666666666666666666666666666666666666';
const REPOSITORY = 'https://example.org/adversarial-live-kb';
const SOURCE_PATH = 'docs/public/guide.md';
const QUOTE = 'The incident guide uses the old phrase.';
const REPLACEMENT = 'The incident guide uses the corrected phrase.';

const CASE = Object.freeze({
  repository: REPOSITORY,
  baseCommit: COMMIT,
  sourcePath: SOURCE_PATH,
  publicUrl: 'https://example.org/kb/guide',
  quote: QUOTE,
  replacement: REPLACEMENT,
  rationale: 'The synthetic candidate changes one exact phrase.',
  evidence: ['Synthetic local evidence only.'],
  kind: 'wording',
});

async function temporary(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function createVault() {
  const root = await temporary('correction-adversarial-live-source-');
  await mkdir(path.join(root, 'docs', 'public'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'private'), { recursive: true });
  await writeFile(path.join(root, 'publish.yml'), 'allow:\n  - "docs/public/**"\n', 'utf8');
  await writeFile(path.join(root, SOURCE_PATH), `---\ntitle: Guide\n---\n\n${QUOTE}\n`, 'utf8');
  await writeFile(
    path.join(root, 'docs', 'private', 'secret.md'),
    `---\ntitle: Secret\n---\n\n${QUOTE}\n`,
    'utf8',
  );
  await writeFile(
    path.join(root, 'docs', 'private', 'malformed.md'),
    '--- \n- [Where is the Data](#where-is-the-data)\n--- \n# Where is the Data\n',
    'utf8',
  );
  return root;
}

function fakeCheckout(root) {
  return async () => ({
    root,
    head: COMMIT,
    clean: true,
    origin: `${REPOSITORY}.git`,
    repositoryMatches: true,
    publishConfigPresent: true,
  });
}

function isolatedDependencies({ failBuildLane = null, renderCandidateAsBaseline = false } = {}) {
  const calls = { build: [], setup: [], render: [], cleanup: [] };
  return {
    calls,
    dependencies: {
      async createTemporaryRoot() {
        const root = await temporary('correction-adversarial-live-work-');
        calls.workspace = root;
        return root;
      },
      async cleanupTemporaryRoot(root) {
        calls.cleanup.push(root);
        await rm(root, { recursive: true, force: true });
      },
      async buildProjection({ lane, vaultDir, outputDir }) {
        calls.build.push(lane);
        if (lane === failBuildLane) {
          throw Object.assign(new Error(`injected ${lane} build failure`), {
            code: 'fake-build-failed',
          });
        }
        await cp(vaultDir, outputDir, { recursive: true });
        return {
          mode: 'cyberbaser-select-project-verify',
          selection: { counts: { pages: 1, assets: 0 }, errorCount: 0, sourcePublished: true },
          projection: {
            ok: true,
            counts: { pages: 1, assets: 0 },
            failureCount: 0,
            warningCount: 0,
            verification: { ok: true },
          },
        };
      },
      async setupRenderer({ lane, quartzDir }) {
        calls.setup.push(lane);
        await mkdir(quartzDir, { recursive: true });
        return { renderer: 'fake-quartz', pin: 'v4.5.2-adversarial' };
      },
      async renderSite({ lane, outputDir }) {
        calls.render.push(lane);
        await mkdir(outputDir, { recursive: true });
        const sentence = lane === 'candidate' && !renderCandidateAsBaseline ? REPLACEMENT : QUOTE;
        await writeFile(path.join(outputDir, 'guide.html'), `<!doctype html><p>${sentence}</p>`, 'utf8');
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('adversarial publication and link boundaries', () => {
  test('denies an unpublished/private owner-mapped source path', async () => {
    const vault = await createVault();
    const output = path.join(await temporary('correction-private-projection-'), 'projected');

    await expect(buildProjection({
      vaultDir: vault,
      outputDir: output,
      repositoryRelativePath: 'docs/private/secret.md',
    })).rejects.toMatchObject({ code: 'candidate-not-published' });
    expect(await pathExists(path.join(output, 'docs', 'private', 'secret.md'))).toBe(false);
  });

  test('excludes unpublished malformed frontmatter and fails closed when policy selects it', async () => {
    const vault = await createVault();
    const output = path.join(await temporary('correction-malformed-excluded-'), 'projected');
    const sourcePath = 'docs/private/malformed.md';

    const projected = await buildProjection({
      vaultDir: vault,
      outputDir: output,
      repositoryRelativePath: SOURCE_PATH,
    });
    expect(projected.projection.ok).toBe(true);
    expect(await pathExists(path.join(output, sourcePath))).toBe(false);

    await writeFile(path.join(vault, 'publish.yml'), 'allow:\n  - "docs/private/**"\n', 'utf8');
    const selectedOutput = path.join(await temporary('correction-malformed-published-'), 'projected');
    await expect(buildProjection({
      vaultDir: vault,
      outputDir: selectedOutput,
      repositoryRelativePath: sourcePath,
    })).rejects.toMatchObject({ code: 'candidate-not-published' });
    expect(await pathExists(selectedOutput)).toBe(false);
  });

  test('reports candidate-only link regressions while excluding inherited baseline debt', () => {
    const sharedDebt = {
      page: 'guide.html',
      href: '/kb/inherited-missing',
      decoded: '/kb/inherited-missing',
      class: 'missing-page',
    };
    const baselineOnly = {
      page: 'legacy.html',
      href: '/kb/removed-debt',
      decoded: '/kb/removed-debt',
      class: 'missing-page',
    };
    const candidateOnly = {
      page: 'guide.html',
      href: '/kb/new-regression',
      decoded: '/kb/new-regression',
      class: 'missing-page',
    };

    const delta = candidateOnlyLinkDelta(
      { broken: [sharedDebt, baselineOnly] },
      { broken: [candidateOnly, sharedDebt] },
    );

    expect(delta.candidateOnly).toEqual([candidateOnly]);
    expect(delta.baselineOnly).toEqual([baselineOnly]);
    expect(delta.unchanged).toBe(1);
    expect(delta.candidateOnly).not.toContainEqual(sharedDebt);
    expect(delta.counts).toEqual({
      baseline: 2,
      candidate: 2,
      candidateOnly: 1,
      baselineOnly: 1,
      unchanged: 1,
    });
  });
});

describe('adversarial rendered-target multiplicity', () => {
  test('accepts derivative duplicates only when replacement removes every old-text occurrence', async () => {
    const baselineSiteDir = await temporary('adversarial-render-baseline-');
    const candidateSiteDir = await temporary('adversarial-render-candidate-');
    await writeFile(
      path.join(baselineSiteDir, 'guide.html'),
      `<p>${QUOTE}</p><meta content="${QUOTE}"><script type="application/ld+json">${JSON.stringify({ description: QUOTE })}</script>`,
      'utf8',
    );
    await writeFile(
      path.join(candidateSiteDir, 'guide.html'),
      `<p>${REPLACEMENT}</p><meta content="${REPLACEMENT}"><script type="application/ld+json">${JSON.stringify({ description: REPLACEMENT })}</script>`,
      'utf8',
    );

    const evidence = await captureRenderedTargetEvidence({
      baselineSiteDir,
      candidateSiteDir,
      caseData: CASE,
      basePath: 'kb',
    });
    expect(evidence.baseline.quoteOccurrences).toBe(3);
    expect(evidence.baseline.replacementOccurrences).toBe(0);
    expect(evidence.candidate.quoteOccurrences).toBe(0);
    expect(evidence.candidate.replacementOccurrences).toBe(3);
    expect(evidence.comparable).toEqual({
      sameRenderedPage: true,
      baselineOldTextPresent: true,
      baselineReplacementTextAbsent: true,
      candidateOldTextAbsent: true,
      candidateReplacementSatisfied: true,
    });

    await writeFile(
      path.join(candidateSiteDir, 'guide.html'),
      `<p>${REPLACEMENT}</p><meta content="${QUOTE}"><script type="application/ld+json">${JSON.stringify({ description: REPLACEMENT })}</script>`,
      'utf8',
    );
    await expect(captureRenderedTargetEvidence({
      baselineSiteDir,
      candidateSiteDir,
      caseData: CASE,
      basePath: 'kb',
    })).rejects.toMatchObject({
      code: 'rendered-target-mismatch',
      details: {
        candidate: { quoteOccurrences: 1, replacementOccurrences: 2 },
        comparable: { candidateOldTextAbsent: false },
      },
    });
  });
});

describe('adversarial live-run failure cleanup', () => {
  test('a candidate projection build failure is surfaced and all temporary workspaces are removed', async () => {
    const checkout = await createVault();
    const sourceFile = path.join(checkout, SOURCE_PATH);
    const before = await readFile(sourceFile);
    const injected = isolatedDependencies({ failBuildLane: 'candidate' });

    await expect(runLiveCorrection({
      caseData: CASE,
      checkoutDir: checkout,
      pinnedCommit: COMMIT,
      ownerPolicy: SYNTHETIC_OWNER_POLICY,
      policyRevision: 'adversarial-live-policy-v1',
      basePath: 'kb',
    }, {
      inspectCheckout: fakeCheckout(checkout),
      ...injected.dependencies,
    })).rejects.toMatchObject({ code: 'fake-build-failed' });

    expect(injected.calls.build).toEqual(['baseline', 'candidate']);
    expect(injected.calls.setup).toEqual([]);
    expect(injected.calls.cleanup).toEqual([injected.calls.workspace]);
    expect(await pathExists(injected.calls.workspace)).toBe(false);
    expect((await readFile(sourceFile)).equals(before)).toBe(true);
  });

  test('a rendered-target mismatch is surfaced and cleanup still completes', async () => {
    const checkout = await createVault();
    const sourceFile = path.join(checkout, SOURCE_PATH);
    const before = await readFile(sourceFile);
    const injected = isolatedDependencies({ renderCandidateAsBaseline: true });

    await expect(runLiveCorrection({
      caseData: CASE,
      checkoutDir: checkout,
      pinnedCommit: COMMIT,
      ownerPolicy: SYNTHETIC_OWNER_POLICY,
      policyRevision: 'adversarial-live-policy-v1',
      basePath: 'kb',
    }, {
      inspectCheckout: fakeCheckout(checkout),
      ...injected.dependencies,
    })).rejects.toMatchObject({ code: 'rendered-target-mismatch' });

    expect(injected.calls.render).toEqual(['baseline', 'candidate']);
    expect(injected.calls.cleanup).toEqual([injected.calls.workspace]);
    expect(await pathExists(injected.calls.workspace)).toBe(false);
    expect((await readFile(sourceFile)).equals(before)).toBe(true);
  });
});

describe('deterministic verifier process output', () => {
  test('two fresh verifier processes emit byte-identical JSON with no stderr', async () => {
    const projectDir = path.resolve(import.meta.dir, '..');

    async function runVerifier() {
      const process = Bun.spawn(['bun', 'run', 'bin/verify.js'], {
        cwd: projectDir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...Bun.env, NO_COLOR: '1' },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return { stdout, stderr, exitCode };
    }

    const first = await runVerifier();
    const second = await runVerifier();
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stderr).toBe('');
    expect(second.stderr).toBe('');
    expect(second.stdout).toBe(first.stdout);
    expect(JSON.parse(first.stdout).complete).toBe(true);
  });
});
