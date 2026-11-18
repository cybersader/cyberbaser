# Contributing

## Prerequisites

- [Bun](https://bun.sh) at the version in [`.bun-version`](.bun-version) (currently 1.3.11). CI uses exactly this version.
- Git. Nothing else is needed for the default check.

## One command

```bash
bun run check
```

It installs every package's dependencies from their lockfiles in the order CI uses, then runs the same test suites the pull-request workflows run (packages, apps, the Quartz renderer, the federation fixture), plus a check that tracked files contain no machine-specific home paths and that every workflow pins the Bun version above. `bun run test` is the same command.

The **Contributor check** workflow runs this command on a GitHub-hosted runner for every pull request, so a green local run should mean a green PR.

A few CI jobs need extra tools and run only with `--full`:

```bash
bun run check -- --full   # adds the Rust tests (cargo), browser acceptance fixtures (Chromium), container builds (Docker)
```

## Pull requests

- Keep one change per pull request, with tests next to the code they cover.
- Do not put paths from your own machine, secrets or personal details in tracked files. Derive locations from `os.homedir()`, `XDG_*` or an environment variable. Agent notes about your own setup go in an untracked `CLAUDE.local.md`.
- Docs live in `docs/` (Astro + Starlight): `cd docs && bun install && bun run dev`.
- By opening a pull request you agree to the [Contributor License Agreement](CLA.md).
