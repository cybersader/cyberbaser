import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyProposal, parseProposal } from '@cyberbaser/proposal';
import {
  createTokenFileReader,
  formatLiveCheckReport,
  loadForgejoIntakeConfig,
  runForgejoLiveCheck,
} from '../src/index.js';
import { parseArguments } from '../bin/forgejo-live-check.js';
import {
  CONFIG,
  jsonResponse,
  pullRequestPayload,
  queueFetch,
  repositoryPayload,
  userPayload,
} from './fixtures.js';
import { createGitFixture } from './git-fixture.js';

function forgeResponses(fixture, overrides = {}) {
  return [
    jsonResponse({ version: overrides.version ?? '16.0.5' }),
    jsonResponse(repositoryPayload()),
    jsonResponse(pullRequestPayload({
      base: { ...pullRequestPayload().base, sha: fixture.baseSha },
      head: { ...pullRequestPayload().head, sha: fixture.headSha },
      ...(overrides.pullRequest ?? {}),
    })),
    jsonResponse(userPayload({ is_admin: false })),
  ];
}

test('the live check reconstructs one real-shaped pull request, reports in plain words, and leaves the clone untouched', async () => {
  const fixture = await createGitFixture({
    baseText: '# Handbook\n\nHandover happens at 09:00 local time.\n',
    headText: '# Handbook\n\nHandover happens at 09:00 UTC.\n',
  });
  try {
    const calls = [];
    const before = { head: await fixture.git(['rev-parse', 'HEAD']), status: await fixture.git(['status', '--porcelain=v1']) };
    const outcome = await runForgejoLiveCheck({
      config: CONFIG,
      checkout: fixture.checkout,
      pullRequestNumber: 42,
      fetch: queueFetch(forgeResponses(fixture), calls),
      getToken: () => 'live-secret',
      execute: fixture.execute,
    });
    expect(outcome.ok).toBe(true);
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/v1/version',
      '/api/v1/repos/owner/wiki',
      '/api/v1/repos/owner/wiki/pulls/42',
      '/api/v1/users/alice',
    ]);
    expect(outcome.report).toMatchObject({
      outcome: 'reconstructed',
      forge: { origin: 'https://forge.example:8443', version: '16.0.5' },
      repository: { fullName: 'owner/wiki', id: '731', baseBranch: 'main' },
      pullRequest: { number: 42, baseSha: fixture.baseSha },
      author: { subject: 'forgejo:https://forge.example:8443#user=123', type: 'human' },
      change: { path: 'docs/notes.md', oldPreview: 'local time', replacementPreview: 'UTC' },
      proposal: { proposalId: `forgejo-pr:731:42:${fixture.headSha}` },
      trust: { policyStatus: 'valid', route: 'auto-merge' },
    });
    const text = formatLiveCheckReport(outcome.report);
    expect(text).toContain('RECONSTRUCTED as one exact proposal');
    expect(text).toContain('Before: “local time”');
    expect(text).toContain('Nothing was queued, decided, written, pushed, or published.');
    expect(JSON.stringify(outcome)).not.toContain('live-secret');
    expect(text).not.toContain('live-secret');
    const proposal = parseProposal(outcome.result.proposalText);
    expect(applyProposal(Buffer.from('# Handbook\n\nHandover happens at 09:00 local time.\n'), proposal))
      .toEqual(Buffer.from('# Handbook\n\nHandover happens at 09:00 UTC.\n'));

    expect(await fixture.git(['rev-parse', 'HEAD'])).toBe(before.head);
    expect(await fixture.git(['status', '--porcelain=v1'])).toBe(before.status);
    expect(await fixture.git(['for-each-ref', '--format=%(refname)', 'refs/cyberbaser/forgejo-intake'])).toBe('');
  } finally {
    await fixture.cleanup();
  }
});

test('a refusal is reported as data with the adapter code, not thrown, and an unsupported forge version refuses first', async () => {
  const fixture = await createGitFixture();
  try {
    const draft = await runForgejoLiveCheck({
      config: CONFIG,
      checkout: fixture.checkout,
      pullRequestNumber: 42,
      fetch: queueFetch(forgeResponses(fixture, { pullRequest: { draft: true } })),
      execute: fixture.execute,
    });
    expect(draft.ok).toBe(false);
    expect(draft.report.outcome).toBe('refused');
    expect(typeof draft.report.refusal.code).toBe('string');
    expect(formatLiveCheckReport(draft.report)).toContain(`REFUSED: ${draft.report.refusal.code}`);

    const calls = [];
    const wrongVersion = await runForgejoLiveCheck({
      config: CONFIG,
      checkout: fixture.checkout,
      pullRequestNumber: 42,
      fetch: queueFetch(forgeResponses(fixture, { version: '17.0.0' }), calls),
      execute: fixture.execute,
    });
    expect(wrongVersion.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await fixture.git(['for-each-ref', '--format=%(refname)', 'refs/cyberbaser/forgejo-intake'])).toBe('');
  } finally {
    await fixture.cleanup();
  }
});

test('config and token files are read strictly, and the command line requires the three inputs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cyberbaser-live-check-'));
  try {
    const configFile = path.join(root, 'lane-a.json');
    await writeFile(configFile, JSON.stringify(CONFIG));
    expect((await loadForgejoIntakeConfig(configFile)).repository.fullName).toBe('owner/wiki');
    await writeFile(path.join(root, 'bad.json'), '{not json');
    await expect(loadForgejoIntakeConfig(path.join(root, 'bad.json'))).rejects.toMatchObject({ code: 'invalid-config-file' });

    const tokenFile = path.join(root, 'token');
    await writeFile(tokenFile, 'secret-token\n', { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    expect(await createTokenFileReader(tokenFile)()).toBe('secret-token');
    await chmod(tokenFile, 0o644);
    await expect(createTokenFileReader(tokenFile)()).rejects.toMatchObject({ code: 'token-file-too-open' });

    expect(parseArguments(['--config', 'c.json', '--checkout', '/clone', '--pull', '7', '--json']))
      .toEqual({ config: 'c.json', checkout: '/clone', pull: '7', tokenFile: null, json: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
