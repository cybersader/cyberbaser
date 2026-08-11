import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { createForgejoGitReader } from '../src/index.js';
import { CONFIG, expectCode } from './fixtures.js';
import { createGitFixture } from './git-fixture.js';

async function readFixture(fixture, options = {}) {
  const reader = createForgejoGitReader({
    checkout: fixture.checkout,
    execute: fixture.execute,
    ...(options.reader ?? {}),
  });
  return reader.readPullRequest({
    config: CONFIG,
    pullRequestNumber: 42,
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    remote: 'origin',
    ...(options.input ?? {}),
  });
}

describe('createForgejoGitReader', () => {
  test('reads exact inert objects without changing HEAD, index, worktree, or leaving refs', async () => {
    const fixture = await createGitFixture();
    try {
      const beforeHead = await fixture.git(['rev-parse', 'HEAD']);
      const beforeStatus = await fixture.git(['status', '--porcelain=v1']);
      const beforeIndex = await fixture.git(['write-tree']);
      const evidence = await readFixture(fixture);

      expect(evidence.baseSha).toBe(fixture.baseSha);
      expect(evidence.headSha).toBe(fixture.headSha);
      expect(evidence.path).toBe('docs/notes.md');
      expect(evidence.baseBytes.toString('utf8')).toContain('teh process');
      expect(evidence.headBytes.toString('utf8')).toContain('the process');
      expect(evidence.policy.status).toBe('valid');
      expect(evidence.policy.digest).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
      expect(evidence.policy.config.trusted).toContain('forgejo:https://forge.example:8443#user=123');

      expect(await fixture.git(['rev-parse', 'HEAD'])).toBe(beforeHead);
      expect(await fixture.git(['status', '--porcelain=v1'])).toBe(beforeStatus);
      expect(await fixture.git(['write-tree'])).toBe(beforeIndex);
      expect(await fixture.git(['for-each-ref', '--format=%(refname)', 'refs/cyberbaser/forgejo-intake'])).toBe('');
    } finally {
      await fixture.cleanup();
    }
  });

  test('treats Git pathspec syntax in a valid Markdown filename literally', async () => {
    const fixture = await createGitFixture({ sourcePath: ':(literal)odd.md' });
    try {
      const evidence = await readFixture(fixture);
      expect(evidence.path).toBe(':(literal)odd.md');
      expect(evidence.headBytes.toString('utf8')).toContain('the process');
    } finally {
      await fixture.cleanup();
    }
  });

  test('reports missing and malformed base-bound trust policy without using head policy', async () => {
    for (const [policyText, expected] of [
      [null, 'missing'],
      ['trusted: [\n', 'malformed'],
    ]) {
      const fixture = await createGitFixture({ policyText });
      try {
        const evidence = await readFixture(fixture);
        expect(evidence.policy).toEqual({ status: expected, digest: null, config: null });
      } finally {
        await fixture.cleanup();
      }
    }

    const nonBlobPolicy = await createGitFixture({
      policyText: null,
      mutateBase: async ({ checkout, mkdir, writeFile }) => {
        await mkdir(`${checkout}/.cyberbaser/trust.yml`, { recursive: true });
        await writeFile(`${checkout}/.cyberbaser/trust.yml/entry`, 'not a policy blob\n');
      },
    });
    try {
      const evidence = await readFixture(nonBlobPolicy);
      expect(evidence.policy).toEqual({ status: 'malformed', digest: null, config: null });
    } finally {
      await nonBlobPolicy.cleanup();
    }

    const selfPromoting = await createGitFixture({
      policyText: 'trusted:\n  - nobody\n',
      mutateHead: async ({ checkout, writeFile }) => {
        await writeFile(
          `${checkout}/.cyberbaser/trust.yml`,
          'trusted:\n  - "forgejo:https://forge.example:8443#user=123"\n',
        );
      },
    });
    try {
      await expectCode(() => readFixture(selfPromoting), 'invalid-change-shape');
      expect(await selfPromoting.git(['for-each-ref', '--format=%(refname)', 'refs/cyberbaser/forgejo-intake'])).toBe('');
    } finally {
      await selfPromoting.cleanup();
    }
  });

  test('rejects a stale pull-request head that does not descend from the exact base', async () => {
    const fixture = await createGitFixture();
    try {
      await fixture.git(['switch', '--detach', fixture.baseSha]);
      await writeFile(
        `${fixture.checkout}/docs/notes.md`,
        '# Notes\n\nA carefully reviewed paragraph about teh process.\n',
      );
      await fixture.git(['add', 'docs/notes.md']);
      await fixture.git(['commit', '-m', 'Advance owner base']);
      const advancedBaseSha = await fixture.git(['rev-parse', 'HEAD']);
      await fixture.git(['remote', 'set-url', 'origin', `file://${fixture.bare}`]);
      await fixture.git(['push', 'origin', 'HEAD:refs/heads/main']);
      await fixture.git(['remote', 'set-url', 'origin', CONFIG.repository.url]);

      await expectCode(() => readFixture(fixture, {
        input: { baseSha: advancedBaseSha },
      }), 'pull-request-base-not-ancestor');
      expect(await fixture.git(['for-each-ref', '--format=%(refname)', 'refs/cyberbaser/forgejo-intake'])).toBe('');
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects multiple diff hunks', async () => {
    const baseText = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n') + '\n';
    const headLines = baseText.trimEnd().split('\n');
    headLines[1] = 'changed near start';
    headLines[10] = 'changed near end';
    const fixture = await createGitFixture({ baseText, headText: `${headLines.join('\n')}\n` });
    try {
      await expectCode(() => readFixture(fixture), 'unsupported-hunk-count');
      expect(await fixture.git(['for-each-ref', '--format=%(refname)', 'refs/cyberbaser/forgejo-intake'])).toBe('');
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects multi-file, non-Markdown, and mode-only shapes', async () => {
    const multiFile = await createGitFixture({
      mutateHead: async ({ checkout, writeFile }) => {
        await writeFile(`${checkout}/docs/second.md`, '# Second\n');
      },
    });
    try {
      await expectCode(() => readFixture(multiFile), 'invalid-change-shape');
    } finally {
      await multiFile.cleanup();
    }

    const nonMarkdown = await createGitFixture({
      headText: '# Notes\n\nA paragraph about teh process.\n',
      mutateBase: async ({ checkout, writeFile }) => {
        await writeFile(`${checkout}/notes.txt`, 'old\n');
      },
      mutateHead: async ({ checkout, writeFile }) => {
        await writeFile(`${checkout}/notes.txt`, 'new\n');
      },
    });
    try {
      await expectCode(() => readFixture(nonMarkdown), 'invalid-source-path');
    } finally {
      await nonMarkdown.cleanup();
    }

    const modeChange = await createGitFixture({
      headText: '# Notes\n\nA paragraph about teh process.\n',
      mutateHead: async ({ checkout, chmod }) => {
        await chmod(`${checkout}/docs/notes.md`, 0o755);
      },
    });
    try {
      await expectCode(() => readFixture(modeChange), 'git-mode-changed');
    } finally {
      await modeChange.cleanup();
    }
  });

  test('rejects invalid UTF-8, bounded blobs, mismatched refs, and remote aliases', async () => {
    const invalidUtf8 = await createGitFixture({ headText: Buffer.from([0xff, 0x0a]) });
    try {
      await expectCode(() => readFixture(invalidUtf8), 'invalid-utf8');
    } finally {
      await invalidUtf8.cleanup();
    }

    const oversized = await createGitFixture();
    try {
      await expectCode(() => readFixture(oversized, {
        reader: { maxBlobBytes: 8 },
      }), 'git-blob-too-large');
    } finally {
      await oversized.cleanup();
    }

    const stale = await createGitFixture();
    try {
      await expectCode(() => readFixture(stale, {
        input: { headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      }), 'git-ref-sha-mismatch');
      expect(await stale.git(['for-each-ref', '--format=%(refname)', 'refs/cyberbaser/forgejo-intake'])).toBe('');
    } finally {
      await stale.cleanup();
    }

    const wrongRemote = await createGitFixture();
    try {
      await wrongRemote.git(['remote', 'set-url', 'origin', 'https://forge.example:8443/owner/other.git']);
      await expectCode(() => readFixture(wrongRemote), 'git-remote-mismatch');
    } finally {
      await wrongRemote.cleanup();
    }
  });
});
