import { afterEach, describe, expect, test } from 'bun:test';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyCorrection, deriveContiguousCorrection } from '@cyberbaser/correction';
import {
  candidateOnlyBrokenLinks,
  deriveVisibleWitnesses,
  extractVisibleText,
  runImmediateChecks,
  runPreApplyChecks,
  runPublicationChecks,
  runRenderChecks,
  targetPageForSlug,
} from '../src/checks.js';
import { OwnerAlphaError } from '../src/errors.js';
import {
  PINNED_QUARTZ_COMMIT,
  PINNED_QUARTZ_REF,
  PINNED_QUARTZ_RENDERER_DIR,
  PINNED_QUARTZ_REPOSITORY,
  renderPinnedQuartz,
  offlineSeedEnvironment,
} from '../src/quartz-renderer.js';

const cleanup = [];

async function temporary(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `owner-alpha-checks-${name}-`));
  cleanup.push(root);
  return root;
}

async function write(root, relativePath, contents) {
  const file = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  return file;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

function policy(overrides = {}) {
  return {
    listen: { host: '127.0.0.1', port: 4317 },
    live: { baseUrl: 'https://cybersader.github.io/cyberbase/' },
    owner: {
      identity: 'owner',
      allowedTrustRoutes: ['auto-merge', 'quick-review'],
    },
    checks: { allowedOfmVerdicts: ['clean'] },
    ...overrides,
  };
}

function trustPolicy() {
  return {
    trusted: ['owner'],
    agents: [],
    caps: {
      lines: 60,
      files: 5,
      proseWords: 25,
      typoLines: 6,
      typoWords: 10,
    },
    allowedNewFolders: [],
    frontmatterAllowlist: [],
  };
}

function correctionFixture(oldText = 'The old phrase is unique.', newText = 'The new phrase is unique.') {
  return exactChangeFixture(`# Page\n\n${oldText}\n`, `# Page\n\n${newText}\n`);
}

function exactChangeFixture(beforeText, edited) {
  const before = Buffer.from(beforeText, 'utf8');
  const operation = deriveContiguousCorrection(before, edited, {
    maxBaseBytes: 4096,
    maxEditedBytes: 4096,
    maxOldBytes: 1024,
    maxReplacementBytes: 1024,
    maxChangedBytes: 1024,
    maxChangedLines: 10,
  });
  return { before, candidate: applyCorrection(before, operation), operation };
}

function ownerOperation(fixture) {
  return {
    schemaVersion: 1,
    artifactType: 'owner-alpha-source-operation',
    source: { relativePath: 'pub/Page.md', slug: 'pub/Page' },
    operationType: 'offset',
    baseByteLength: fixture.operation.baseByteLength,
    baseDigest: fixture.operation.baseDigest,
    start: fixture.operation.start,
    end: fixture.operation.end,
    expectedOldBytesBase64: fixture.operation.expectedOldBytes.toString('base64'),
    replacementBytesBase64: fixture.operation.replacementBytes.toString('base64'),
    candidateByteLength: fixture.operation.candidateByteLength,
    candidateDigest: fixture.operation.candidateDigest,
  };
}

async function publicationFixture() {
  const vault = await temporary('vault');
  await write(vault, 'publish.yml', 'allow:\n  - "pub/**"\n');
  await write(vault, 'pub/Page.md', '# Page\n\nThe old phrase is unique.\n');
  await write(vault, 'private/Secret.md', '# Secret\n');
  return vault;
}

function simpleRenderer({ brokenCandidateLink = false } = {}) {
  return async ({ lane, contentDir, outputDir, targetPage }) => {
    const markdown = await readFile(path.join(contentDir, 'pub', 'Page.md'), 'utf8');
    const body = markdown.split('\n').filter((line) => line && !line.startsWith('# ')).join(' ');
    await mkdir(path.dirname(path.join(outputDir, targetPage)), { recursive: true });
    await writeFile(
      path.join(outputDir, targetPage),
      [
        '<!doctype html><html><head>',
        `<meta name="description" content="metadata ${body}">`,
        `<script>const duplicate = ${JSON.stringify(body)}</script>`,
        '</head><body>',
        `<main><h1>Page</h1><p>${body}</p>${lane === 'candidate' && brokenCandidateLink ? '<a href="./missing">broken</a>' : ''}</main>`,
        '</body></html>',
      ].join(''),
    );
    await writeFile(path.join(outputDir, 'index.html'), `<a href="/${targetPage.replace(/\.html$/u, '')}">Page</a>`);
    return { renderer: 'fixture', lane, outputDir };
  };
}

describe('immediate automatic checks', () => {
  test('requires exact operation reproduction, outside-byte identity, allowed OFM and owner trust route', () => {
    const fixture = correctionFixture();
    const result = runImmediateChecks({
      baseBytes: fixture.before,
      candidateBytes: fixture.candidate,
      operation: fixture.operation,
      sourcePath: 'pub/Page.md',
      config: policy(),
      trustPolicy: trustPolicy(),
    });

    expect(result.ok).toBe(true);
    expect(result.operation).toMatchObject({
      reproducesCandidate: true,
      outsideBytesIdentical: true,
    });
    expect(result.ofm.verdict).toBe('clean');
    expect(result.trust.route).toBe('auto-merge');
  });

  test('accepts the durable owner-alpha operation artifact with canonical base64 byte fields', () => {
    const fixture = correctionFixture();
    const result = runImmediateChecks({
      baseBytes: fixture.before,
      candidateBytes: fixture.candidate,
      operation: ownerOperation(fixture),
      config: policy(),
      trustPolicy: trustPolicy(),
    });
    expect(result.operation.reproducesCandidate).toBe(true);
    expect(result.operation.outsideBytesIdentical).toBe(true);
  });

  test('fails closed when the supplied candidate is not the operation result', async () => {
    const fixture = correctionFixture();
    const tampered = Buffer.concat([fixture.candidate, Buffer.from('tamper')]);
    await expectCode(() => runImmediateChecks({
      baseBytes: fixture.before,
      candidateBytes: tampered,
      operation: fixture.operation,
      sourcePath: 'pub/Page.md',
      config: policy(),
      trustPolicy: trustPolicy(),
    }), 'operation-candidate-mismatch');
  });

  test('blocks a trust route that the durable owner policy does not authorize', async () => {
    const fixture = correctionFixture();
    await expectCode(() => runImmediateChecks({
      baseBytes: fixture.before,
      candidateBytes: fixture.candidate,
      operation: fixture.operation,
      sourcePath: 'pub/Page.md',
      config: policy(),
      trustPolicy: null,
    }), 'trust-route-not-allowed');
  });

  const ownerReview = { type: 'approved-proposal', queueId: 'Q-0f0e0d0c-0b0a-4908-8706-050403020100',
    inputDigest: `sha-256=:${Buffer.alloc(32, 7).toString('base64')}:` };

  test('an explicit owner review satisfies full-review without a trust file, and says so', () => {
    const fixture = correctionFixture();
    const result = runImmediateChecks({ baseBytes: fixture.before, candidateBytes: fixture.candidate,
      operation: fixture.operation, sourcePath: 'pub/Page.md', config: policy(), trustPolicy: null, ownerReview });
    expect(result.trust.route).toBe('full-review');
    expect(result.trust.reasons).toEqual(['no-trust-config']);
    expect(result.trustRequirement).toEqual({ route: 'full-review', satisfiedBy: ownerReview });
  });

  test('an owner review never unlocks a lighter route the owner policy does not allow', async () => {
    // trusted human, non-typo change -> quick-review; policy allows only auto-merge.
    const fixture = correctionFixture('The old phrase is unique and fairly long.', 'A rather different sentence was written here instead, with many more words added so it is clearly no typo fix at all.');
    await expectCode(() => runImmediateChecks({ baseBytes: fixture.before, candidateBytes: fixture.candidate,
      operation: fixture.operation, sourcePath: 'pub/Page.md', trustPolicy: trustPolicy(), ownerReview,
      config: policy({ owner: { identity: 'owner', allowedTrustRoutes: ['auto-merge'] } }) }), 'trust-route-not-allowed');
  });

  test('owner review evidence must be exact', async () => {
    const fixture = correctionFixture();
    for (const bad of [{ ...ownerReview, type: 'owner-direct' }, { ...ownerReview, queueId: 'Q-1' },
      { ...ownerReview, inputDigest: 'sha256:abc' }, { ...ownerReview, extra: true }, 'approved']) {
      await expectCode(() => runImmediateChecks({ baseBytes: fixture.before, candidateBytes: fixture.candidate,
        operation: fixture.operation, sourcePath: 'pub/Page.md', config: policy(), trustPolicy: null, ownerReview: bad }),
      'invalid-owner-review');
    }
  });
});

describe('publication boundary checks', () => {
  test('selects the source, projects verbatim, and explicitly verifies the isolated copy', async () => {
    const vault = await publicationFixture();
    const out = path.join(await temporary('projection'), 'content');
    const result = await runPublicationChecks({
      vaultDir: vault,
      outputDir: out,
      sourcePath: 'pub/Page.md',
    });

    expect(result.sourcePublished).toBe(true);
    expect(result.projection.ok).toBe(true);
    expect(result.verification.ok).toBe(true);
    expect(result.sourceBytesIdentical).toBe(true);
    expect(await readFile(path.join(out, 'pub', 'Page.md'), 'utf8')).toContain('old phrase');
    expect(await exists(path.join(out, 'private', 'Secret.md'))).toBe(false);
  });

  test('blocks a target outside the publication selection', async () => {
    const vault = await publicationFixture();
    const out = path.join(await temporary('projection-private'), 'content');
    await expectCode(() => runPublicationChecks({
      vaultDir: vault,
      outputDir: out,
      sourcePath: 'private/Secret.md',
    }), 'source-not-published');
  });
});

describe('exact rendered target and visible witnesses', () => {
  test('extracts body-visible text without counting head metadata, attributes, scripts or tags', () => {
    const html = [
      '<html><head><meta content="old phrase"><style>.x{content:"old phrase"}</style></head>',
      '<body data-copy="old phrase"><script>"old phrase"</script><p>Old &amp; visible</p></body></html>',
    ].join('');
    expect(extractVisibleText(html)).toBe('Old & visible');
  });

  test('derives short Unicode-safe witnesses unique to their own visible page', () => {
    const result = deriveVisibleWitnesses(
      'Navigation Page The old café phrase is unique Footer',
      'Navigation Page The new café phrase is unique Footer',
    );
    expect(result.old).toContain('old');
    expect(result.new).toContain('new');
    expect(result.counts).toEqual({
      baselineOld: 1,
      baselineNew: 0,
      candidateOld: 0,
      candidateNew: 1,
    });
    expect(result.oldCharacters).toBeLessThanOrEqual(result.maxChars);
    expect(result.newCharacters).toBeLessThanOrEqual(result.maxChars);
  });

  test('checks the same exact target page and permits inherited but not candidate-only broken links', async () => {
    const baseline = await temporary('baseline-site');
    const candidate = await temporary('candidate-site');
    for (const [root, phrase] of [[baseline, 'old phrase'], [candidate, 'new phrase']]) {
      await write(root, 'guide/Page.html', `<body><main>One ${phrase} only.</main><a href="./missing">inherited</a></body>`);
    }

    const result = await runRenderChecks({
      baselineSiteDir: baseline,
      candidateSiteDir: candidate,
      targetPage: 'guide/Page.html',
    });
    expect(result.sameExactTargetPage).toBe(true);
    expect(result.witnesses.counts.candidateOld).toBe(0);
    expect(result.witnesses.counts.candidateNew).toBe(1);
    expect(result.links.delta.counts).toMatchObject({ candidateOnly: 0, unchanged: 1 });
  });

  test('uses the full broken tuple for a deterministic candidate-only delta', () => {
    const inherited = { page: 'a.html', href: './missing', decoded: './missing', class: 'missing-page' };
    const added = { page: 'b.html', href: './asset.png', decoded: './asset.png', class: 'missing-asset' };
    const delta = candidateOnlyBrokenLinks(
      { broken: [inherited] },
      { broken: [added, inherited] },
    );
    expect(delta.candidateOnly).toEqual([added]);
    expect(delta.counts).toEqual({
      baseline: 1,
      candidate: 2,
      candidateOnly: 1,
      baselineOnly: 0,
      unchanged: 1,
    });
  });

  test('maps only exact safe renderer slugs to HTML paths', async () => {
    expect(targetPageForSlug('pub/Page')).toBe('pub/Page.html');
    expect(targetPageForSlug('')).toBe('index.html');
    await expectCode(() => Promise.resolve(targetPageForSlug('../outside')), 'invalid-rendered-slug');
  });
});

describe('composed isolated pre-apply checks', () => {
  test('uses an injected renderer, leaves the real checkout untouched, and always removes temporary copies', async () => {
    const checkout = await publicationFixture();
    const fixture = correctionFixture();
    await write(checkout, 'pub/Page.md', fixture.before);
    const temporaryRoot = await temporary('owned-temp-root');
    await rm(temporaryRoot, { recursive: true, force: true });
    let cleanupCalled = false;

    const result = await runPreApplyChecks({
      config: policy(),
      checkoutDir: checkout,
      baseBytes: fixture.before,
      operation: ownerOperation(fixture),
      trustPolicy: trustPolicy(),
      renderer: simpleRenderer(),
    }, {
      createTemporaryRoot: async () => temporaryRoot,
      cleanupTemporaryRoot: async (root) => {
        cleanupCalled = true;
        await rm(root, { recursive: true, force: true });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.publication.selectedSetUnchanged).toBe(true);
    expect(result.publication.addressMapUnchanged).toBe(true);
    expect(result.renderer.isolatedWorkspaces).toBe(true);
    expect(result.rendered.witnesses.counts).toMatchObject({
      baselineOld: 1,
      candidateOld: 0,
      candidateNew: 1,
    });
    expect(result.cleanup.completed).toBe(true);
    expect(cleanupCalled).toBe(true);
    expect(await exists(temporaryRoot)).toBe(false);
    expect((await readFile(path.join(checkout, 'pub', 'Page.md'))).equals(fixture.before)).toBe(true);
  });

  test('a candidate-only broken link blocks before apply while source isolation and cleanup still hold', async () => {
    const checkout = await publicationFixture();
    const fixture = correctionFixture();
    await write(checkout, 'pub/Page.md', fixture.before);
    const temporaryRoot = await temporary('failure-temp-root');
    await rm(temporaryRoot, { recursive: true, force: true });
    let cleanupCalled = false;

    await expectCode(() => runPreApplyChecks({
      config: policy(),
      checkoutDir: checkout,
      sourcePath: 'pub/Page.md',
      baseBytes: fixture.before,
      candidateBytes: fixture.candidate,
      operation: fixture.operation,
      trustPolicy: trustPolicy(),
      targetPage: 'pub/Page.html',
      renderer: simpleRenderer({ brokenCandidateLink: true }),
    }, {
      createTemporaryRoot: async () => temporaryRoot,
      cleanupTemporaryRoot: async (root) => {
        cleanupCalled = true;
        await rm(root, { recursive: true, force: true });
      },
    }), 'candidate-broken-links-added');

    expect(cleanupCalled).toBe(true);
    expect(await exists(temporaryRoot)).toBe(false);
    expect((await readFile(path.join(checkout, 'pub', 'Page.md'))).equals(fixture.before)).toBe(true);
  });
});

describe('pre-apply publication effects', () => {
  async function prepare(fixture) {
    const checkoutDir = await publicationFixture();
    await write(checkoutDir, 'pub/Page.md', fixture.before);
    return {
      config: policy(),
      checkoutDir,
      sourcePath: 'pub/Page.md',
      baseBytes: fixture.before,
      candidateBytes: fixture.candidate,
      operation: fixture.operation,
      trustPolicy: trustPolicy(),
      targetPage: 'pub/Page.html',
      renderer: () => { throw new Error('publication refusal must come before rendering'); },
    };
  }

  test('blocks an edited note from moving even if the operation layer was bypassed', async () => {
    // Supply the exact candidate directly, instead of asking the owner edit route to authorize it.
    const inputs = await prepare(exactChangeFixture(
      '---\nslug: pub/old-address\n---\n# Page\n',
      '---\nslug: pub/new-address\n---\n# Page\n',
    ));
    const error = await expectCode(() => runPreApplyChecks(inputs), 'address-map-changed');
    expect(error.details).toEqual({
      added: 0,
      removed: 0,
      moved: 1,
      editedSource: { from: 'pub/old-address.md', to: 'pub/new-address.md' },
    });
  });

  test('reports only counts for another note moving across the isolated trees', async () => {
    const inputs = await prepare(correctionFixture());
    await write(inputs.checkoutDir, 'pub/Other.md', '---\nslug: pub/other-before\n---\n# Another note\n');
    const error = await expectCode(() => runPreApplyChecks(inputs, {
      // Projection rejects collisions rather than reassigning a different note's URL.
      // Model a second source drifting between the two copies, then run real selection/projection.
      copyCheckout: async (source, destination) => {
        await cp(source, destination, { recursive: true });
        if (path.basename(path.dirname(destination)) === 'candidate') {
          await write(destination, 'pub/Other.md', '---\nslug: pub/other-after\n---\n# Another note\n');
        }
      },
    }), 'address-map-changed');
    expect(error.details).toEqual({ added: 0, removed: 0, moved: 1 });
  });

  for (const lane of ['baseline', 'candidate']) {
    test(`fails closed when projection rejects an invalid ${lane} page target`, async () => {
      const good = '---\nslug: pub/valid\n---\n# Page\n';
      const bad = '---\nslug: ../invalid\n---\n# Page\n';
      const inputs = await prepare(lane === 'baseline'
        ? exactChangeFixture(bad, good)
        : exactChangeFixture(good, bad));
      const error = await expectCode(() => runPreApplyChecks(inputs), 'projection-failed');
      expect(error.details.failures).toMatchObject([{ kind: 'slug', path: 'pub/Page.md' }]);
    });
  }

  test('keeps the existing selected-set failure for a body edit that publishes an asset', async () => {
    const inputs = await prepare(correctionFixture('The old phrase is unique.', 'The old phrase is unique.\n\n![Diagram](../private/diagram.png)'));
    await write(inputs.checkoutDir, 'private/diagram.png', 'synthetic image bytes');
    const error = await expectCode(() => runPreApplyChecks(inputs), 'published-set-changed');
    expect(error.details).toEqual({});
  });

  test('keeps the existing unpublished-source failure for the candidate', async () => {
    const inputs = await prepare(exactChangeFixture('# Page\n', '---\npublish: false\n---\n# Page\n'));
    await expectCode(() => runPreApplyChecks(inputs), 'source-not-published');
  });
});

describe('pinned Quartz integration', () => {
  test('the real helper is fixed to the measured wrapper and pin', async () => {
    expect(PINNED_QUARTZ_REF).toBe('v4.5.2');
    expect(PINNED_QUARTZ_COMMIT).toBe('4923affa7722dfc751f1074348e6dad214fe0c08');
    expect(PINNED_QUARTZ_REPOSITORY).toBe('https://github.com/jackyzha0/quartz.git');
    expect(PINNED_QUARTZ_RENDERER_DIR.endsWith(path.join('renderers', 'quartz-cyberbase', path.sep))).toBe(true);
    expect(typeof renderPinnedQuartz).toBe('function');
  });

  test('rejects malformed suggestion form inputs before any renderer command runs', async () => {
    const root = await temporary('bad-suggestions');
    const base = {
      contentDir: path.join(root, 'content'),
      outputDir: path.join(root, 'output'),
      workspaceDir: path.join(root, 'workspace'),
      ownerOrigin: 'http://127.0.0.1:4317',
    };
    const valid = {
      intakeOrigin: 'http://127.0.0.1:4319',
      bindingDigest: `sha-256=:${Buffer.alloc(32, 1).toString('base64')}:`,
      sourceRepository: 'https://github.com/cybersader/cyberbase.git',
      sourceRevision: 'a'.repeat(40),
    };
    for (const suggestions of [
      'enabled',
      { ...valid, intakeOrigin: 'https://intake.example' },
      { ...valid, intakeOrigin: 'http://8.8.8.8:4319' },
      { ...valid, bindingDigest: 'sha256:abc' },
      { ...valid, sourceRepository: 'git@github.com:cybersader/cyberbase.git' },
      { ...valid, sourceRevision: 'main' },
    ]) {
      const code = typeof suggestions === 'string' || suggestions.intakeOrigin !== valid.intakeOrigin
        ? (typeof suggestions === 'string' ? 'invalid-render-suggestions' : 'private-network-origin-required')
        : 'invalid-render-suggestions';
      await expectCode(() => renderPinnedQuartz({ ...base, suggestions }), code);
    }
  });

  test('container rendering fails closed instead of fetching when the immutable seed is absent', async () => {
    const root = await temporary('missing-container-seed');
    const previous = process.env.OWNER_ALPHA_STATE_PROFILE;
    process.env.OWNER_ALPHA_STATE_PROFILE = 'rootless-test-v1';
    try {
      await expectCode(() => offlineSeedEnvironment(path.join(root, 'absent-seed')), 'quartz-seed-missing');
    } finally {
      if (previous === undefined) delete process.env.OWNER_ALPHA_STATE_PROFILE;
      else process.env.OWNER_ALPHA_STATE_PROFILE = previous;
    }
  });

  const realQuartzTest = process.env.OWNER_ALPHA_REAL_QUARTZ === '1' ? test : test.skip;
  realQuartzTest('renders a tiny isolated baseline/candidate fixture through pinned Quartz', async () => {
    const checkout = await publicationFixture();
    const fixture = correctionFixture();
    await write(checkout, 'pub/Page.md', fixture.before);
    const result = await runPreApplyChecks({
      config: policy(),
      checkoutDir: checkout,
      sourcePath: 'pub/Page.md',
      baseBytes: fixture.before,
      candidateBytes: fixture.candidate,
      operation: fixture.operation,
      trustPolicy: trustPolicy(),
      targetSlug: 'pub/Page',
    });
    expect(result.renderer.baseline.revision).toBe(PINNED_QUARTZ_COMMIT);
    expect(result.rendered.targetPage).toBe('pub/Page.html');
  }, 600_000);
});
