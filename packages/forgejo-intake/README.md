# `@cyberbaser/forgejo-intake`

Read-only Forgejo pull-request adapter for the canonical `@cyberbaser/proposal` contract.

The package binds one open Forgejo 16 pull request to exact API metadata and inert Git objects, requires one modified existing Markdown file and one diff hunk, derives one bounded exact splice, emits one canonical proposal, and passes a separately verified Forgejo-local subject into `@cyberbaser/trust`.

It does not install a Forgejo workflow, create or merge pull requests, write source, push refs, retain a queue, manage accounts or sessions, deploy content, or authorize acceptance. Owner-alpha remains the selected direct writer.

## API

```js
import {
  createForgejoApi,
  createForgejoGitReader,
  readForgejoPullRequestProposal,
} from '@cyberbaser/forgejo-intake';

const result = await readForgejoPullRequestProposal({
  config,
  pullRequestNumber: 42,
  api: createForgejoApi({ fetch, getToken }),
  git: createForgejoGitReader({ checkout }),
});
```

`result.proposalText` is the only canonical durable artifact. Carrier metadata, the receiver-verified subject, base-policy status, and trust classification are frozen in-memory presentation values.

The adapter reads credentials only through the explicit `getToken` callback. Tokens are requested per API call and never enter configuration, URLs, returned evidence, or error details. Git access uses the caller's already isolated local checkout and configured read-only remote.

## Version 1 envelope

- Forgejo major 16.
- One open, non-draft pull request.
- One active account, with explicitly flagged bots rejected.
- One modified existing `.md` file.
- One Git diff hunk and one exact contiguous splice.
- 4 MiB per base/head blob.
- 64 KiB old/replacement/change span.
- Base-bound trust policy only.
- No mutation or retention.

## Evidence boundary

The package is designed for hermetic injected-API and local bare-Git acceptance. Passing those tests does not prove a live Forgejo installation, edit-link flow, non-admin contributor usability, production compatibility, account-free intake, required-check enforcement, attribution, or production authority.

## Development

```bash
bun install --frozen-lockfile
bun test
```
