import { afterEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildProjection,
  candidateOnlyLinkDelta,
  inspectCheckout,
  runLiveCorrection,
} from '../src/live-run.js';
import { buildLiveReviewCard } from '../src/live-review-card.js';
import { SYNTHETIC_OWNER_POLICY } from '../src/verification.js';

const temporaryDirectories = [];
const COMMIT = '3333333333333333333333333333333333333333';
const REPOSITORY = 'https://example.org/owner/public-kb';
const SOURCE_PATH = 'docs/guide.md';
const QUOTE = 'This guide assigns responsibilites, processes, and escalation paths.';
const REPLACEMENT = 'This guide assigns responsibilities, processes, and escalation paths.';

const CASE = Object.freeze({
  repository: REPOSITORY,
  baseCommit: COMMIT,
  sourcePath: SOURCE_PATH,
  publicUrl: 'https://example.org/kb/guide',
  quote: QUOTE,
  replacement: REPLACEMENT,
  rationale: 'The exact replacement corrects one unambiguous spelling error.',
  evidence: ['The local test fixture contains the exact quote once.'],
  kind: 'typo',
});

async function temporary(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function command(args, cwd) {
  const process = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout.trim();
}

async function createVault() {
  const root = await temporary('correction-live-source-');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
  await writeFile(path.join(root, SOURCE_PATH), `---\ntitle: Guide\n---\n\n${QUOTE}\n`, 'utf8');
  await writeFile(path.join(root, 'private.md'), '# Private\n', 'utf8');
  return root;
}

function fakeCheckout(root, { publishConfigPresent = true } = {}) {
  return async () => ({
    root,
    head: COMMIT,
    clean: true,
    origin: `${REPOSITORY}.git`,
    repositoryMatches: true,
    publishConfigPresent,
  });
}

function injectedLaneFunctions({
  candidateOnlyLink = true,
  failCandidateRender = false,
  projectionMode = 'cyberbaser-select-project-verify',
} = {}) {
  const calls = { build: [], setup: [], render: [], cleanup: [] };
  return {
    calls,
    dependencies: {
      async createTemporaryRoot() {
        const root = await temporary('correction-live-work-');
        calls.workspace = root;
        return root;
      },
      async cleanupTemporaryRoot(root) {
        calls.cleanup.push(root);
        await rm(root, { recursive: true, force: true });
      },
      async buildProjection({ lane, vaultDir, outputDir }) {
        calls.build.push(lane);
        await cp(vaultDir, outputDir, { recursive: true });
        return {
          mode: projectionMode,
          selection: { counts: { pages: 1, assets: 0 }, errorCount: 0, sourcePublished: true },
          projection: { ok: true, counts: { pages: 1, assets: 0 }, failureCount: 0, warningCount: 0, verification: { ok: true } },
        };
      },
      async setupRenderer({ lane, quartzDir }) {
        calls.setup.push(lane);
        await mkdir(quartzDir, { recursive: true });
        return { renderer: 'fake-quartz', pin: 'v4.5.2-test' };
      },
      async renderSite({ lane, contentDir, outputDir }) {
        calls.render.push(lane);
        if (failCandidateRender && lane === 'candidate') {
          throw Object.assign(new Error('injected candidate render failure'), { code: 'fake-render-failed' });
        }
        await mkdir(outputDir, { recursive: true });
        const source = await readFile(path.join(contentDir, SOURCE_PATH), 'utf8');
        const sentence = source.includes(REPLACEMENT) ? REPLACEMENT : QUOTE;
        const candidateLink = candidateOnlyLink && lane === 'candidate'
          ? '<a href="/kb/candidate-only">candidate only</a>'
          : '';
        await writeFile(
          path.join(outputDir, 'guide.html'),
          `<!doctype html><p>${sentence}</p><a href="/kb/shared-missing">shared</a>${candidateLink}`,
          'utf8',
        );
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('isolated live correction lane', () => {
  test('uses injected fake build/render lanes, reports candidate-only links, and cleans up', async () => {
    const checkout = await createVault();
    const sourceFile = path.join(checkout, SOURCE_PATH);
    const sourceBefore = await readFile(sourceFile);
    const injected = injectedLaneFunctions();

    const liveRun = await runLiveCorrection({
      caseData: CASE,
      checkoutDir: checkout,
      pinnedCommit: COMMIT,
      ownerPolicy: SYNTHETIC_OWNER_POLICY,
      policyRevision: 'test-live-policy-v1',
      basePath: 'kb',
    }, {
      inspectCheckout: fakeCheckout(checkout),
      ...injected.dependencies,
    });

    expect(injected.calls.build).toEqual(['baseline', 'candidate']);
    expect(injected.calls.setup).toEqual(['baseline', 'candidate']);
    expect(injected.calls.render).toEqual(['baseline', 'candidate']);
    expect(injected.calls.cleanup).toEqual([injected.calls.workspace]);
    expect(await pathExists(injected.calls.workspace)).toBe(false);
    expect((await readFile(sourceFile)).equals(sourceBefore)).toBe(true);

    expect(liveRun.siteChecks.linkDelta.counts).toEqual({
      baseline: 1,
      candidate: 2,
      candidateOnly: 1,
      baselineOnly: 0,
      unchanged: 1,
    });
    expect(liveRun.siteChecks.linkDelta.candidateOnly).toEqual([{
      page: 'guide.html',
      href: '/kb/candidate-only',
      decoded: '/kb/candidate-only',
      class: 'missing-page',
    }]);
    expect(liveRun.renderedTarget.comparable).toEqual({
      sameRenderedPage: true,
      baselineOldTextPresent: true,
      baselineReplacementTextAbsent: true,
      candidateOldTextAbsent: true,
      candidateReplacementSatisfied: true,
    });
    expect(liveRun.sourceCheckout.cleanBefore).toBe(true);
    expect(liveRun.sourceCheckout.cleanAfter).toBe(true);
    expect(liveRun.sourceCheckout.sourceBytesUnchangedAfter).toBe(true);
    expect(liveRun.cleanup).toEqual({ completed: true, temporaryWorkspacesRetained: false });

    const card = buildLiveReviewCard(liveRun);
    expect(card.evidence.rendering.linkDelta.counts.candidateOnly).toBe(1);
    expect(card.json).not.toContain(checkout);
    expect(card.json).not.toContain(injected.calls.workspace);
    expect(card.html).toContain('No source write or public deployment has occurred.');
    expect(card.html).toContain('Exact proposed change');
    expect(card.html).not.toContain('Exact approved change');
    expect(card.html).not.toMatch(/<script\b|\s(?:src|href|action)\s*=/iu);
  });

  test('cleans all temporary lanes in a finally path after a render failure', async () => {
    const checkout = await createVault();
    const sourceFile = path.join(checkout, SOURCE_PATH);
    const sourceBefore = await readFile(sourceFile);
    const injected = injectedLaneFunctions({ failCandidateRender: true });

    await expect(runLiveCorrection({
      caseData: CASE,
      checkoutDir: checkout,
      pinnedCommit: COMMIT,
      ownerPolicy: SYNTHETIC_OWNER_POLICY,
      policyRevision: 'test-live-policy-v1',
      basePath: 'kb',
    }, {
      inspectCheckout: fakeCheckout(checkout),
      ...injected.dependencies,
    })).rejects.toMatchObject({ code: 'fake-render-failed' });

    expect(injected.calls.cleanup).toEqual([injected.calls.workspace]);
    expect(await pathExists(injected.calls.workspace)).toBe(false);
    expect((await readFile(sourceFile)).equals(sourceBefore)).toBe(true);
  });

  test('missing pinned publication policy stops before temporary copies or renderer work', async () => {
    const checkout = await createVault();
    const sourceFile = path.join(checkout, SOURCE_PATH);
    const sourceBefore = await readFile(sourceFile);
    const calls = { temporary: 0, copy: 0, setup: 0, render: 0 };

    await expect(runLiveCorrection({
      caseData: CASE,
      checkoutDir: checkout,
      pinnedCommit: COMMIT,
      ownerPolicy: SYNTHETIC_OWNER_POLICY,
      policyRevision: 'test-live-policy-v1',
      basePath: 'kb',
    }, {
      inspectCheckout: fakeCheckout(checkout, { publishConfigPresent: false }),
      async createTemporaryRoot() { calls.temporary += 1; },
      async copyVault() { calls.copy += 1; },
      async setupRenderer() { calls.setup += 1; },
      async renderSite() { calls.render += 1; },
    })).rejects.toMatchObject({ code: 'publication-boundary-policy-missing' });

    expect(calls).toEqual({ temporary: 0, copy: 0, setup: 0, render: 0 });
    expect((await readFile(sourceFile)).equals(sourceBefore)).toBe(true);
  });

  test('nonstandard projection evidence stops before renderer setup', async () => {
    const checkout = await createVault();
    const injected = injectedLaneFunctions({ projectionMode: 'legacy-verbatim-copy' });

    await expect(runLiveCorrection({
      caseData: CASE,
      checkoutDir: checkout,
      pinnedCommit: COMMIT,
      ownerPolicy: SYNTHETIC_OWNER_POLICY,
      policyRevision: 'test-live-policy-v1',
      basePath: 'kb',
    }, {
      inspectCheckout: fakeCheckout(checkout),
      ...injected.dependencies,
    })).rejects.toMatchObject({ code: 'publication-boundary-evidence-invalid' });

    expect(injected.calls.build).toEqual(['baseline', 'candidate']);
    expect(injected.calls.setup).toEqual([]);
    expect(injected.calls.render).toEqual([]);
    expect(injected.calls.cleanup).toEqual([injected.calls.workspace]);
  });

  test('rejects an explicit commit that differs from the frozen case', async () => {
    const checkout = await createVault();
    await expect(runLiveCorrection({
      caseData: CASE,
      checkoutDir: checkout,
      pinnedCommit: '4444444444444444444444444444444444444444',
      ownerPolicy: SYNTHETIC_OWNER_POLICY,
      policyRevision: 'test-live-policy-v1',
    }, {
      inspectCheckout: fakeCheckout(checkout),
    })).rejects.toMatchObject({ code: 'case-commit-mismatch' });
  });
});

describe('live lane deterministic primitives', () => {
  test('computes a deterministic delta over page/href/decoded/class', () => {
    const shared = { page: 'z.html', href: '/shared', decoded: '/shared', class: 'missing-page' };
    const baselineOnly = { page: 'a.html', href: '/old', decoded: '/old', class: 'missing-page' };
    const candidateOnly = { page: 'b.html', href: '/new', decoded: '/new', class: 'missing-page' };
    const delta = candidateOnlyLinkDelta(
      { broken: [shared, baselineOnly] },
      { broken: [candidateOnly, shared] },
    );
    expect(delta.tuple).toEqual(['page', 'href', 'decoded', 'class']);
    expect(delta.candidateOnly).toEqual([candidateOnly]);
    expect(delta.baselineOnly).toEqual([baselineOnly]);
    expect(delta.unchanged).toBe(1);
    expect(Object.isFrozen(delta.candidateOnly)).toBe(true);
  });

  test('rejects a projection without publish.yml before creating output', async () => {
    const vault = await temporary('correction-policy-free-vault-');
    const output = path.join(await temporary('correction-policy-free-output-'), 'projected');
    await mkdir(path.join(vault, 'docs'), { recursive: true });
    await writeFile(path.join(vault, SOURCE_PATH), `# Guide\n\n${QUOTE}\n`, 'utf8');

    await expect(buildProjection({
      vaultDir: vault,
      outputDir: output,
      repositoryRelativePath: SOURCE_PATH,
    })).rejects.toMatchObject({ code: 'publication-boundary-policy-missing' });
    expect(await pathExists(output)).toBe(false);
  });

  test('composes current select, project, and verifyProjection without Quartz', async () => {
    const vault = await createVault();
    const output = path.join(await temporary('correction-projection-'), 'projected');
    const result = await buildProjection({
      vaultDir: vault,
      outputDir: output,
      repositoryRelativePath: SOURCE_PATH,
    });
    expect(result.mode).toBe('cyberbaser-select-project-verify');
    expect(result.selection.sourcePublished).toBe(true);
    expect(result.projection.ok).toBe(true);
    expect(result.projection.verification.ok).toBe(true);
    expect(await pathExists(path.join(output, SOURCE_PATH))).toBe(true);
    expect(await pathExists(path.join(output, 'private.md'))).toBe(false);
  });

  test('verifies a real local Git checkout is pinned, clean, and origin-bound', async () => {
    const repository = await temporary('correction-git-checkout-');
    await command(['git', 'init', '-q'], repository);
    await command(['git', 'config', 'user.email', 'test@example.org'], repository);
    await command(['git', 'config', 'user.name', 'Test User'], repository);
    await writeFile(path.join(repository, 'guide.md'), '# Guide\n', 'utf8');
    await command(['git', 'add', 'guide.md'], repository);
    await command(['git', 'commit', '-q', '-m', 'fixture'], repository);
    await command(['git', 'remote', 'add', 'origin', `${REPOSITORY}.git`], repository);
    const head = await command(['git', 'rev-parse', 'HEAD'], repository);

    const inspected = await inspectCheckout({ checkoutDir: repository, pinnedCommit: head, repository: REPOSITORY });
    expect(inspected.head).toBe(head);
    expect(inspected.clean).toBe(true);
    expect(inspected.repositoryMatches).toBe(true);

    await writeFile(path.join(repository, 'guide.md'), '# Changed\n', 'utf8');
    await expect(inspectCheckout({ checkoutDir: repository, pinnedCommit: head, repository: REPOSITORY }))
      .rejects.toMatchObject({ code: 'checkout-not-clean' });
  });

  test('rejects working publish.yml bytes hidden from Git status', async () => {
    const repository = await temporary('correction-policy-bytes-');
    await command(['git', 'init', '-q'], repository);
    await command(['git', 'config', 'user.email', 'test@example.org'], repository);
    await command(['git', 'config', 'user.name', 'Test User'], repository);
    await mkdir(path.join(repository, 'docs'), { recursive: true });
    await writeFile(path.join(repository, SOURCE_PATH), `# Guide\n\n${QUOTE}\n`, 'utf8');
    await writeFile(path.join(repository, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
    await command(['git', 'add', '.'], repository);
    await command(['git', 'commit', '-q', '-m', 'fixture'], repository);
    await command(['git', 'remote', 'add', 'origin', `${REPOSITORY}.git`], repository);
    const head = await command(['git', 'rev-parse', 'HEAD'], repository);

    await command(['git', 'update-index', '--assume-unchanged', 'publish.yml'], repository);
    await writeFile(path.join(repository, 'publish.yml'), 'allow:\n  - "private/**"\n', 'utf8');
    expect(await command(['git', 'status', '--porcelain=v1', '--untracked-files=all'], repository)).toBe('');
    await expect(inspectCheckout({
      checkoutDir: repository,
      pinnedCommit: head,
      repository: REPOSITORY,
      sourcePath: SOURCE_PATH,
    })).rejects.toMatchObject({ code: 'publication-policy-not-at-pinned-commit' });
  });

  test('rejects a clean checkout containing a tracked symbolic link', async () => {
    const repository = await temporary('correction-git-symlink-');
    await command(['git', 'init', '-q'], repository);
    await command(['git', 'config', 'user.email', 'test@example.org'], repository);
    await command(['git', 'config', 'user.name', 'Test User'], repository);
    await writeFile(path.join(repository, 'guide.md'), '# Guide\n', 'utf8');
    await symlink('guide.md', path.join(repository, 'guide-link.md'));
    await command(['git', 'add', 'guide.md', 'guide-link.md'], repository);
    await command(['git', 'commit', '-q', '-m', 'fixture with symlink'], repository);
    await command(['git', 'remote', 'add', 'origin', `${REPOSITORY}.git`], repository);
    const head = await command(['git', 'rev-parse', 'HEAD'], repository);

    await expect(inspectCheckout({ checkoutDir: repository, pinnedCommit: head, repository: REPOSITORY }))
      .rejects.toMatchObject({ code: 'checkout-symlink-rejected' });
  });
});
