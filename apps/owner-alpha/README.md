# `@cyberbaser/owner-alpha`

Private local owner-alpha operation of Cyberbaser's owner-controlled change boundary.

**The idea:** your machine runs your wiki as a small personal server and browser clients use the rendered wiki. Browse and search, click **Edit** on a page, fix the text, then click **Save and publish** once. The server verifies the change, applies it to the vault, commits, pushes, watches the deployment, and confirms the fix on the live site. The default `127.0.0.1` address keeps the whole interaction on one machine. A private numeric address is the intended multi-device route, but a physical-device Save remains an explicit pending validation criterion. The vault, Git, and credentials remain on the server.

The app rebuilds and serves the configured Quartz owner site plus an exact-Markdown editor on that one owner-chosen private numeric IPv4 address. One **Save and publish** action starts the automatic, durable pipeline. The browser does not choose roots, remotes, commands, URLs, refspecs, or separate Apply/Commit/Push/Deploy approvals.

The implementation includes:

- strict local configuration and a deterministic SHA-256 policy revision;
- an ignored workspace with a strictly contained private store;
- create-once and atomic-replacement JSON artifacts;
- a nonblocking Linux `flock` held by a child process, not by lock-file existence;
- an explicit durable job state machine with legal transitions and restart classifications;
- separate private-address Bun origins for the unprivileged Quartz reader and privileged owner editor/API;
- exact Host/Origin checks, one-time bootstrap capabilities with console re-arm, per-device session and CSRF tokens, strict CSP, bounded requests, and symlink/hard-link-safe static serving;
- durable-before-acknowledgement Save acceptance and classified startup recovery;
- an automatic source-check, exact-apply, commit, push, deployment, live-confirmation, and local-rebuild pipeline.

## Deployment story

The intended topology has three roles. The **server machine** holds everything sensitive: the vault checkout, Git credentials, the durable policy, and job evidence. A **browser client** holds only a session cookie. A configured **deployment provider** observes the exact pushed commit through either GitHub Actions or Forgejo Actions; GitHub remains the current production dogfood authority and Pages host. The Forgejo branch is implemented for an isolated phase-one fixture only. It does not move production remotes, edit links, workflows, hosting, or authority. Its opt-in real-engine gate is currently blocked before resource creation because adversarial review disproved the planned same-UID host runner as a credential and container-socket isolation boundary. Multi-device physical operation is not yet claimed by the automated or container acceptance evidence.

The app has two operator shapes. The bare-metal launchers below remain useful for local development and the established owner workflow. WP2 also packages the same server as a hardened Linux/amd64 OCI image with explicit rootless and rootful Docker Engine profiles. The container path uses Linux host networking, an exact numeric private address, a read-write `/vault` bind, a read-only config bind, a named state volume, and an external HTTPS credential-helper socket. See [`deploy/owner-alpha/README.md`](../../deploy/owner-alpha/README.md) and the canonical [container deployment guide](../../docs/src/content/docs/development/owner-alpha-container-deployment.mdx).

Bare-metal day one:

1. Copy `owner-alpha.example.json` to `owner-alpha.local.json` (mode 0600), point it at your vault checkout.
2. Run the launcher (`Cyberbase Wiki.cmd` on Windows/WSL, or `bun run wiki`). First start builds the full local site — minutes; later starts reuse the verified cache — seconds.
3. Your browser opens on the wiki, already signed in via a one-time link the launcher consumed for you.
4. For an additional browser session: type `b` in the server terminal and consume the printed one-time link in a separate browser context. Physical-device use remains pending validation.

Daily use is then just: browse, Edit, Save. Between Save and live: local checks including a double render (seconds to a few minutes) → exact apply + commit + push (seconds) → GitHub Actions build and Pages deploy, watched not driven (3–5 minutes) → live-text confirmation → local wiki rebuild → `completed`. You can close the browser after Save; the job is durable on the server, and `/owner/jobs/<id>` shows progress. Stopping the server mid-job is safe: the next start resumes only states that are provably safe to resume and holds anything ambiguous for you.

The local wiki you browse is served by the server machine and is separate from the public site; the public site changes only through the pushed commit and the vault's own CI, exactly as a manual Obsidian push would.

## Runtime

- Bun
- JavaScript ESM
- Linux util-linux `flock`
- no frontend framework
- no database
- workspace-local Cyberbaser packages only

## Configuration

Copy `owner-alpha.example.json` to `owner-alpha.local.json` and replace the example repository path. The real file is already covered by the repository-wide `*.local.json` ignore rule. The active config must be owned by the current user and inaccessible to group or other users (mode `0600` on Linux).

```bash
cp apps/owner-alpha/owner-alpha.example.json apps/owner-alpha/owner-alpha.local.json
chmod 600 apps/owner-alpha/owner-alpha.local.json
```

The schema is closed at every level. Unknown or missing keys fail validation. It requires:

- one exact private numeric IPv4 listener host and owner port; the reader port is derived as owner port + 1. Accepted host ranges are loopback `127.0.0.0/8`, RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and RFC 6598 shared address space `100.64.0.0/10`. Hostnames, IPv6, wildcard, public addresses, exact range endpoints, and port 80 on either origin are rejected. `127.0.0.1` remains the default;
- one exact absolute repository path;
- one exact credential-free HTTPS remote, remote name, and branch;
- one exact credential-free live URL;
- one strict provider branch: the existing GitHub Actions repository/name/path/environment contract, or a Forgejo Actions API origin, repository slug, `.forgejo/workflows/*.yml` path, job set, terminal deployment job, and matching branch;
- one project-relative ignored workspace and a store strictly below it;
- explicit include/exclude path policy, ordered size ceilings, and known checks;
- the fail-closed checks `source-path`, `source-size`, `base-digest`, `exact-old-bytes`, and `outside-splice-identity`.

The workflow repository must match the configured remote and the workflow branch must match the source branch. `owner-alpha.example.json` preserves the existing GitHub branch and its pinned policy revision. `owner-alpha.forgejo.example.json` shows the separate Forgejo branch: canonical standard-port HTTPS remote, exact same-origin `/api/v1`, no subpath installation, `.forgejo/workflows/*.yml`, configured job set, and explicit deployment job. The live URL remains independent owner policy.

Both examples contain no credentials. Forgejo observation is anonymous by default. Tests may inject a read-only token callback that reads a mode-`0600` file on every request, but the normal server and WP2 container do not expose a production private-observation credential feature. Credential-shaped keys and common credential-bearing values are rejected from config and JSON artifacts.

```js
import {
  loadOwnerAlphaConfig,
  computePolicyRevision,
} from '@cyberbaser/owner-alpha';

const config = await loadOwnerAlphaConfig(
  new URL('../owner-alpha.local.json', import.meta.url),
);
const policyRevision = computePolicyRevision(config);
```

The policy revision covers the exact remote identity, branch, live URL, workflow identity, complete two-origin listen identity, and path/size/check policy. It intentionally excludes only machine-local repository and workspace paths. Changing either loopback port changes the durable policy identity.

## Ignored store and artifacts

`defineStoreContext()` requires `workspaceRoot` below `projectRoot` and `storeRoot` strictly below the workspace. `prepareStore()` rejects symlink components, verifies the destination with `git check-ignore --no-index`, creates private directories, and rechecks real-path containment.

Artifact APIs are JSON-only:

- `createJsonArtifactOnce()` writes a synced temporary file and hard-links it into place, so an existing immutable artifact is never overwritten.
- `replaceJsonArtifactAtomic()` requires an existing regular file, writes and syncs a same-directory temporary file, renames it atomically, and syncs the parent directory.
- `readJsonArtifact()` rejects symlinks, non-regular files, extra hard links, oversized files, and invalid JSON.

All artifact files are created with mode `0600`. Persistent lock files may remain present; their existence never means the lock is held.

## Child-held `flock`

`withFileLock()` starts `flock --exclusive --nonblock ... cat`. The child confirms lock ownership through its pipe and remains alive for the callback. Closing the pipe releases the kernel lock, including when the callback throws. Contention fails with `OwnerAlphaError` code `lock-busy` instead of waiting.

## Durable job state

Every Save creates an `accepted` job and records a contiguous history inside its atomically replaced state artifact. Save is the owner authority event; there are no routine approval states.

```text
accepted
  -> preflighting
  -> checking
  -> rendering
  -> ready-to-apply
  -> applying
  -> source-applied
  -> committing
  -> committed
  -> pushing
  -> pushed
  -> discovering-run
  -> run-bound
  -> monitoring-deployment
  -> deployment-succeeded
  -> verifying-live
  -> live-confirmed
  -> rebuilding-local
  -> completed
```

Exceptional terminal states are `blocked-pre-apply`, `deployment-failed`, `manual-intervention`, `cancelled`, and `failed`. A `live-verification-failed` job permits only the bounded read-only live check to be repeated.

Recovery classification is part of every validated state. At startup, the server safely enumerates durable jobs in stable order and sequentially resumes only states classified for automatic recovery. Read-only checks can restart, exact durable effects resume at the next boundary, and ambiguous application states stop for manual intervention. In particular, an interrupted `applying` state without durable `source-applied` evidence is never replayed automatically.

`transitionDurableJob()` reloads state under the child-held lock, validates the legal transition, and atomically replaces the state artifact. Immutable edit-session and exact-operation artifacts are durable before the `accepted` journal is created or the Save request receives `202`. The pipeline then persists immutable evidence for pre-apply checks, exact source application, commit, push, Actions run binding, deployment, live witness, and local rebuild.

## Local server

Start the private server with the local config path (the default is `owner-alpha.local.json`):

```bash
bun run --cwd apps/owner-alpha start
# or, from a native Linux filesystem
bun run apps/owner-alpha/src/server.js /absolute/path/to/owner-alpha.local.json
```

The launcher detects a WSL-mounted `/mnt/*` project and mirrors only the runtime code into a marked private cache under `${XDG_CACHE_HOME:-$HOME/.cache}/cyberbaser/owner-alpha-runtime`. Quartz, the ignored job store, and all derived site output then use Linux ext4 rather than the many-small-file path on NTFS. The canonical Cyberbase source remains the exact checkout in `owner-alpha.local.json`; the mirror never becomes another content authority. Set `OWNER_ALPHA_RUNTIME_ROOT` only to choose another private Linux runtime directory.

Startup verifies the canonical checkout against the actual remote branch. It reuses a complete local site only when its manifest, policy revision, immutable Quartz commit and repository, owner origin, runtime-resource digest, rendered-output digest, HTML count, source commit, branch, and remote still match. Otherwise it selects and projects published content, builds Quartz v4.5.2 at commit `4923affa7722dfc751f1074348e6dad214fe0c08` in owner mode, validates the output, and only then binds the servers.

The CLI prints two addresses:

- reader: `http://<listen.host>:4318/cyberbase/` for the configured default owner port;
- a one-time owner bootstrap URL on `http://<listen.host>:4317/`.

Treat every bootstrap URL as an expiring secret. Each one can establish one device session, redirects to the reader site, and is not persisted. Entering `b` followed by Enter in the server terminal prints a fresh one-time sign-in link for another device; issuing a new link replaces any unused one but never signs out devices that already bootstrapped. Each device receives its own session cookie and CSRF token. Restarting the process revokes every session; that restart is also the only revocation mechanism, so restart if a sign-in link may have been consumed by someone other than you. Quartz owner links cross from the unprivileged reader origin to the privileged owner origin with this exact absolute shape (shown for the loopback default):

```text
http://127.0.0.1:4317/owner/edit?relativePath=<repo-relative-markdown-path>&slug=<renderer-slug>
```

The edit session is held server-side for ten minutes. The page renders the exact LF-only Markdown in one textarea. Save returns only after the exact immutable session and operation plus the `accepted` state are durable, then redirects to `/owner/jobs/<job-id>` while the automatic pipeline continues. It never reports a timeout while an accepted mutation may continue. A pre-acceptance rejection returns an error instead of issuing a phantom job URL. JSON status is available at `/api/jobs/<job-id>`.

Both listeners bind exactly the validated private host (never a wildcard; startup fails if the address is not assigned to the machine) and require the exact `Host`. The reader origin is GET/HEAD-only and has no owner or API routes. Privileged routes require an HttpOnly `SameSite=Strict` device-session cookie; state-changing requests additionally require the exact owner `Origin` and that device's CSRF token. The static reader site comes only from the configured workspace site directory and rejects traversal, symlinks, and hard links. Clean Quartz URLs safely fall back to the corresponding `.html` file. Rendered Markdown scripts remain confined to the reader origin and receive no owner session or CORS authority path.

## Private-network operation

The default `127.0.0.1` config serves one machine. The multi-device design uses one owner-chosen private numeric IPv4 address that is assigned inside the environment running Bun, but physical-device Save evidence remains pending. Changing the address changes the durable policy revision and the embedded edit-link origin, so the first start after an address change performs a full site rebuild.

**Plain-HTTP warning.** The app speaks HTTP, not HTTPS. On any non-loopback address, the bootstrap token, session cookie, source Markdown, edits, and job responses cross the network unencrypted at the application layer; the exact Host/Origin checks, CSRF, and cookie flags do not prevent an on-path peer from reading or altering traffic. Use only loopback or an encrypted private network you genuinely trust. A LAN is only as trustworthy as every peer and switch on it. Never port-forward these ports to the public Internet, and never expose them through a public reverse proxy.

**WSL note.** The configured numeric address must exist inside the environment running Bun. An address assigned only to the Windows host is not automatically visible inside WSL; the selected private-network transport must place that address in WSL's namespace, or the environment must provide equivalent mirrored networking. This is environment setup, not Cyberbaser behavior.

## Tests

From the repository root:

```bash
bun test apps/owner-alpha/test
bun run --cwd apps/owner-alpha test:deployment
```

`test:deployment` is the focused cross-provider regression entry point. It runs strict GitHub and Forgejo configuration, both provider paths through the generic dispatcher, persisted-binding recovery, Forgejo adapter contracts, fixture structure, cleanup-negative cases, and the opt-in skip contract. `test:forgejo` remains an alias for compatibility. Neither command starts Forgejo or pulls an image unless the separately documented four-input real gate is explicitly enabled. See [`deploy/forgejo-phase-1/README.md`](../../deploy/forgejo-phase-1/README.md).

The normal suite leaves the effectful browser acceptance test skipped. Run the hermetic rehearsal explicitly with:

```bash
OWNER_ALPHA_ACCEPTANCE=1 bun test apps/owner-alpha/test/acceptance.test.js
```

That rehearsal launches the real owner and reader servers, drives the real browser modules with Playwright, uses a temporary checkout and local bare remote, performs exact apply/commit/push effects, and proves startup recovery from a durable accepted job. Deployment, live confirmation, and local rebuild are deterministic fixtures. It does not mutate the real Cyberbase or publish to an external network.

The scoped tests cover strict schema rejection, policy hashing, credential rejection, ignored containment, symlink/hard-link and traversal defense, create-once races, atomic replacement, child-held lock contention/release, every legal state-machine path, terminal behavior, recovery classification, dual-origin browser authority, exact Git publication, and durable concurrent transitions.

WP2 deployment tests run separately:

```bash
bun test deploy/owner-alpha/test
```

Image-level cases also require an immutable local image identity through `OWNER_ALPHA_CONTAINER_IMAGE`. The final WP2 evidence used a real rootless Linux Docker Engine and native ext4-backed storage; an actual rootful-daemon run, a physical-device Save, an external-forge/live-site Save from the container, and registry publication remain unclaimed.
