# Owner-alpha OCI deployment

This directory packages the private owner-alpha wiki as one Linux/amd64 OCI image with two explicit Docker Engine profiles. It is an owner-operated deployment for one exact private numeric IPv4 address. It is not a public intake service, hosted product, or wildcard-bound web application.

The operator path is intentionally strict: build or obtain one immutable image, prepare three host inputs plus one named state volume, start an external HTTPS credential broker, select exactly one runtime identity profile, validate, initialize, and start. The image is not published during WP2, so the current path begins with a local build.

For the product boundary and Save behavior, see [`apps/owner-alpha/README.md`](../../apps/owner-alpha/README.md). The canonical operator guide is [Owner-alpha container deployment](../../docs/src/content/docs/development/owner-alpha-container-deployment.mdx). Docker's own background is in [host networking](https://docs.docker.com/engine/network/drivers/host/) and [rootless mode](https://docs.docker.com/engine/security/rootless/).

WP3's disposable Forgejo Actions gate is a separate package and lifecycle under [`deploy/forgejo-phase-1/`](../forgejo-phase-1/README.md). It does not add Forgejo, a runner, observer credentials, published-site TLS, or fixture cleanup duties to this WP2 Compose package. The default owner-alpha container remains anonymous-only for deployment observation.

## Supported deployment contract

- Linux Docker Engine on amd64.
- `network_mode: host`; no `ports:` and no ordinary bridge publishing.
- One exact owner-selected numeric IPv4 address assigned inside the Linux network namespace used by Bun.
- Loopback (`127.0.0.1`) or an accepted private range only. No hostname, wildcard, public address, IPv6 address, or public port forward.
- Rootless Docker profile: container `0:0` maps to the unprivileged host user who owns the vault.
- Rootful Docker profile: the main process runs as the vault owner's exact nonzero numeric UID/GID.
- HTTPS Git remote authentication through an operator-supplied Unix-socket credential broker only.
- Read-only image root, dropped capabilities, `no-new-privileges`, engine logging disabled, and no mutable pull or production build stanza.

Docker Desktop is outside the v1 support contract. A Docker daemon inside another Linux environment is acceptable only when the selected address is actually assigned in that Linux namespace and the vault, Docker storage, state volume, and rendering work use native Linux storage.

## What has been verified

WP2 mechanical acceptance has passed on Linux/amd64 with a rootless Docker Engine and native ext4-backed storage. The tests built the image, inspected its immutable contents, exercised the rootless runtime identity, exercised numeric nonzero identity and profile-bound state mechanics, drove a two-browser Save against a temporary checkout and local bare Git remote, replaced the container, and checked restart classifications and bootstrap non-retention.

That evidence is deliberately narrower than a production claim:

- the fixture Save did not push to an external forge or verify a public live site;
- the real Cyberbase Save completed on 2026-08-02 through the bare-metal owner-alpha route, not through this container;
- no physical-phone Save has been completed through the container;
- the available final review daemon was rootless, so an actual rootful-daemon run remains pending even though the rootful numeric-identity and state-volume mechanics passed;
- no registry image was published, no service was installed, and no external vault was used during WP2.

## Operator story: clean Linux host

### 1. Prepare the host

Install a local Linux Docker Engine and the Docker Compose plugin. Choose exactly one profile:

| Profile | Docker daemon | Runtime identity | When to use it |
|---|---|---|---|
| `rootless` | Rootless Docker | Container `0:0`, mapped to the ordinary daemon user | The daemon user owns the vault and the selected address is visible through real host networking |
| `rootful` | Rootful Docker | Exact nonzero vault-owner UID/GID | The vault belongs to a specific host user and the main process must run as that user |

Do not select `rootless` against a rootful daemon or `rootful` against a rootless daemon. `owner-alpha-compose.sh` checks the local Unix-socket engine and rejects the mismatch.

The vault must be an exact, clean Git worktree root on a native Linux filesystem. Its branch and credential-free HTTPS remote must match the config. The runtime identity must own and be able to write the vault, and the repository must already have `user.name` and `user.email`. Enabled Git hooks remain enabled, so their required executables must also exist in the image or the owner must make a separate explicit policy change.

Choose the listener address before building the owner site. Both the owner port and adjacent reader port must be unused. With the default owner port, the origins are:

```text
http://<private-ip>:4317/              owner editor and API
http://<private-ip>:4318/cyberbase/    unprivileged reader
```

The exact address must appear in the Linux namespace used by Docker host networking. Never substitute `0.0.0.0`.

### 2. Build a local immutable image

From the repository root:

```bash
docker buildx build \
  --platform linux/amd64 \
  --file deploy/owner-alpha/Containerfile \
  --tag cyberbaser-owner-alpha:wp2 \
  --load \
  .

docker image inspect --format '{{.Id}}' cyberbaser-owner-alpha:wp2
```

Record the returned `sha256:...` image ID. The temporary tag is only a local build name. Put the immutable image ID, not the tag, in the operator environment. The Compose file uses `pull_policy: never` and has no `build:` stanza.

The build downloads the pinned base images, exact Debian snapshot packages, Bun dependency closure, and the pinned Quartz seed. Production rendering later uses the read-only seed and does not run `git fetch`, `npm ci`, or an `npx` install fallback.

### 3. Prepare the credential-free config

Copy the tracked container example to an operator-controlled path:

```bash
install -d -m 700 /home/owner/.config/cyberbaser
install -m 600 \
  deploy/owner-alpha/owner-alpha.container.example.json \
  /home/owner/.config/cyberbaser/owner-alpha.local.json
```

Edit only non-secret policy and deployment values. Required container-specific values include:

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 4317
  },
  "repository": {
    "checkout": "/vault"
  },
  "workspace": {
    "root": ".workspace/owner-alpha",
    "store": ".workspace/owner-alpha/store",
    "site": ".workspace/owner-alpha/site",
    "cache": ".workspace/owner-alpha/cache"
  }
}
```

Replace `127.0.0.1` only with the exact accepted private numeric IPv4 address assigned in the Linux namespace. Keep the Git remote credential-free. Do not add tokens, passwords, private keys, bootstrap capabilities, or helper output.

At startup, the read-only source config is copied without following symlinks into a private `/run/owner-alpha` tmpfs file. The application loads only that process-owned, mode-`0600`, one-link copy.

### 4. Start the external HTTPS credential broker

WP2 includes the in-image Git credential-helper client, not a production host broker. The operator must provide a broker that listens at an exact Unix socket named `helper.sock`, returns credentials only for the configured HTTPS host and repository path, applies its own access controls, and keeps credentials in memory.

The socket directory must:

- contain only `helper.sock`;
- be a real, non-symlink directory owned by the selected runtime host identity;
- expose no token file, private key, home directory, general Git config, SSH agent, or Docker socket;
- deny access to other users.

SSH remotes and SSH-agent-only authentication are not supported by schema version 1. Private-repository deployment observation is also unsupported because the current GitHub HTTP observation adapter sends no authorization header.

### 5. Prepare the operator environment

Copy the example to a mode-`0600` operator file:

```bash
install -m 600 \
  deploy/owner-alpha/operator.env.example \
  /home/owner/.config/cyberbaser/owner-alpha.env
```

Set:

- `OWNER_ALPHA_PROFILE` to exactly `rootless` or `rootful`;
- `OWNER_ALPHA_IMAGE` to the local `sha256:...` image ID or an immutable `repository@sha256:...` digest;
- absolute native-Linux paths for the vault, config, and socket directory;
- one dedicated named volume and profile marker;
- the vault owner's numeric UID/GID for rootful mode;
- an executable `/tmp` tmpfs large enough for two vault copies and two isolated renderer workspaces. The baseline example is `4g`, and startup requires at least 2 GiB free.

Use a new named state volume when changing profile or runtime UID/GID. The initializer never recursively re-owns an existing volume and refuses a mismatched profile marker.

### 6. Validate, initialize, and start

Set the absolute env-file path for each management command:

```bash
OWNER_ALPHA_ENV_FILE=/home/owner/.config/cyberbaser/owner-alpha.env \
  deploy/owner-alpha/owner-alpha-compose.sh validate

OWNER_ALPHA_ENV_FILE=/home/owner/.config/cyberbaser/owner-alpha.env \
  deploy/owner-alpha/owner-alpha-compose.sh init

OWNER_ALPHA_ENV_FILE=/home/owner/.config/cyberbaser/owner-alpha.env \
  deploy/owner-alpha/owner-alpha-compose.sh start
```

`validate` checks the local engine, profile, immutable image, exact bind sources, ownership, modes, socket shape, and Compose expansion. `init` prepares only the named state volume with no network, vault, config, or credential mount. `start` runs detached and waits for health. Health requires startup recovery to finish and an exact-Host request to the reader origin to succeed.

The runtime mount contract is:

| Host or managed resource | Container location | Access |
|---|---|---:|
| Exact vault worktree root | `/vault` | Read-write bind; only writable host bind |
| Credential-free source config | `/config/owner-alpha.local.json` | Read-only bind |
| Profile-bound durable state | `/opt/cyberbaser/.workspace` | Named volume |
| Credential broker socket directory | `/run/owner-alpha-credentials` | Read-only bind containing only `helper.sock` |
| Staged active config and readiness | `/run/owner-alpha` | Private, size-bounded, non-executable tmpfs |
| Render scratch space | `/tmp` | Private, size-bounded, executable tmpfs |
| Application and Quartz seed | `/opt/cyberbaser` | Read-only image root |

### 7. Attach and bootstrap a browser

Detached startup deliberately does not retain the initial bootstrap capability. Attach to the live TTY and request a replacement:

```bash
OWNER_ALPHA_ENV_FILE=/home/owner/.config/cyberbaser/owner-alpha.env \
  deploy/owner-alpha/owner-alpha-compose.sh bootstrap
```

Enter `b`, press Enter, consume the one-time URL in a fresh browser context, then detach without stopping the service using `Ctrl-p Ctrl-q`. A new unused capability replaces the previous unused capability. Restart revokes every browser session and capability.

The selected logging model is part of the security contract: Docker logging is `none`, detached systemd startup does not pipe output into a journal, and bootstrap links are visible only in the active attachment.

### 8. Use the Save pipeline

Browse the reader origin, open **Edit**, change one existing tracked UTF-8 LF Markdown body, and select **Save and publish** once. The accepted job becomes durable before the browser receives success. The server then runs the configured source, exact-byte, OFM, trust, publication, projection, render, and link checks; applies one exact operation; creates one single-parent, one-path commit; pushes normally; observes deployment; verifies the live witness; and rebuilds the local wiki.

Outbound access is still required for the configured Git remote, deployment observation, and live verification. The production pipeline is not fully offline even though application dependencies and Quartz are frozen in the image.

### 9. Recover after restart

Use replacement restart when changing the image or deliberately revoking sessions:

```bash
OWNER_ALPHA_ENV_FILE=/home/owner/.config/cyberbaser/owner-alpha.env \
  deploy/owner-alpha/owner-alpha-compose.sh restart
```

Readiness is absent until durable recovery finishes. Safe states resume at their proven boundary: accepted work restarts checks, committed work resumes at push, already-pushed work resumes observation, and live-verification failures repeat only the read-only live check. An interrupted `applying` state without durable source-applied evidence becomes `manual-intervention`; containerization does not turn ambiguity into an automatic replay.

The named volume survives container replacement. Process-memory sessions and capabilities do not.

### 10. Upgrade without mutable pulls

1. Build or obtain the replacement image.
2. Inspect and record its immutable image ID or repository digest.
3. Update only `OWNER_ALPHA_IMAGE` in the mode-`0600` operator env file.
4. Run `validate`.
5. Run `restart`.
6. Check `status`, attach if a new bootstrap is needed, and verify the expected reader origin.

Do not use `latest`, a tag-only production reference, `docker compose pull`, or an in-place package installation. The old image remains locally available for an explicit rollback until the operator removes it.

### 11. Optional systemd operation

Tracked examples exist for both profiles:

- `systemd/user/cyberbaser-owner-alpha.service` for rootless Docker;
- `systemd/system/cyberbaser-owner-alpha.service` for rootful Docker.

They call the same management helper, start detached, and keep bootstrap output out of the journal. Installing or enabling either unit is an operator action and was not performed during WP2 acceptance.

### 12. Stop and tear down

Stop the selected service without deleting durable state:

```bash
OWNER_ALPHA_ENV_FILE=/home/owner/.config/cyberbaser/owner-alpha.env \
  deploy/owner-alpha/owner-alpha-compose.sh stop
```

Removing the named state volume is destructive: it deletes job evidence, the local site, caches, renderer workspace, and process home. Do it only after deliberate review and any required backup. Removing the image or operator files does not alter the vault, but the vault remains the authoritative source and must never be deleted as part of container cleanup.

## Deliberate limits

WP2 does not claim Docker Desktop, bridge publishing, SSH remotes, Podman, multi-architecture images, in-image TLS, public Internet exposure, a fully offline production pipeline, private-repository deployment observation, graceful automatic replay of interrupted source application, external forge/live-site acceptance, physical-device Save evidence, registry publication, or installed/enabled services.
