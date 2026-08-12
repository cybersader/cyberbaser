import { expect, test } from 'bun:test';
import { applyProposal, parseProposal } from '@cyberbaser/proposal';
import {
  createForgejoApi,
  createForgejoGitReader,
  readForgejoPullRequestProposal,
} from '../src/index.js';
import {
  CONFIG,
  jsonResponse,
  pullRequestPayload,
  queueFetch,
  repositoryPayload,
  userPayload,
} from './fixtures.js';
import { createGitFixture } from './git-fixture.js';

test('WP4 Lane A hermetically reconstructs one exact proposal from fake Forgejo and real Git', async () => {
  const fixture = await createGitFixture({
    baseText: '# Threat model\n\nTabs\tand trailing spaces stay.  \n\nCorrect teh typo.\n',
    headText: '# Threat model\n\nTabs\tand trailing spaces stay.  \n\nCorrect the typo.\n',
  });
  try {
    const calls = [];
    let tokenCalls = 0;
    const api = createForgejoApi({
      fetch: queueFetch([
        jsonResponse({ version: '16.0.2' }),
        jsonResponse(repositoryPayload()),
        jsonResponse(pullRequestPayload({
          base: {
            ...pullRequestPayload().base,
            sha: fixture.baseSha,
          },
          head: {
            ...pullRequestPayload().head,
            sha: fixture.headSha,
          },
        })),
        jsonResponse(userPayload({ is_admin: false })),
      ], calls),
      getToken: () => {
        tokenCalls += 1;
        return 'acceptance-secret';
      },
    });
    const git = createForgejoGitReader({
      checkout: fixture.checkout,
      execute: fixture.execute,
    });
    const beforeHead = await fixture.git(['rev-parse', 'HEAD']);
    const beforeStatus = await fixture.git(['status', '--porcelain=v1']);

    const result = await readForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      api,
      git,
    });

    expect(calls).toHaveLength(4);
    expect(tokenCalls).toBe(4);
    expect(calls.every(({ options }) => options.method === 'GET')).toBe(true);
    expect(calls.every(({ options }) => options.redirect === 'error')).toBe(true);
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/v1/version',
      '/api/v1/repos/owner/wiki',
      '/api/v1/repos/owner/wiki/pulls/42',
      '/api/v1/users/alice',
    ]);

    const proposal = parseProposal(result.proposalText);
    const baseBytes = Buffer.from('# Threat model\n\nTabs\tand trailing spaces stay.  \n\nCorrect teh typo.\n');
    const headBytes = Buffer.from('# Threat model\n\nTabs\tand trailing spaces stay.  \n\nCorrect the typo.\n');
    expect(applyProposal(baseBytes, proposal)).toEqual(headBytes);
    expect(result.proposal.source.revision).toBe(fixture.baseSha);
    expect(result.proposal.proposalId).toBe(`forgejo-pr:731:42:${fixture.headSha}`);
    expect(result.proposal.submission.evidence).toEqual([]);
    expect(result.verifiedSubject.author).toBe('forgejo:https://forge.example:8443#user=123');
    expect(result.trust.policyStatus).toBe('valid');
    expect(result.trust.classification.route).toBe('auto-merge');
    expect(JSON.stringify(result)).not.toContain('acceptance-secret');

    expect(await fixture.git(['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(await fixture.git(['status', '--porcelain=v1'])).toBe(beforeStatus);
    expect(await fixture.git(['for-each-ref', '--format=%(refname)', 'refs/cyberbaser/forgejo-intake'])).toBe('');
    expect(await fixture.bareGit(['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/main');
  } finally {
    await fixture.cleanup();
  }
});
