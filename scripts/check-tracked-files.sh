#!/usr/bin/env bash
# Fails when tracked files carry something tied to one person's machine, or
# when workflows drift from the pinned Bun version. Runs in CI and in
# `bun run check`.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0

# Real home-directory paths. Placeholders used in docs (/home/owner, /home/user,
# /home/runner, /home/you) are fine; URLs that merely contain /home/ are not
# matched because the path must start a token.
if git grep -n -I -E "(^|[[:space:]\"'\`=(])(/home/|/Users/|/mnt/c/Users/|[A-Za-z]:\\\\Users\\\\)" -- ':!*.lock' ':!*.lockb' \
  | grep -v -E "(/home|/Users)/(owner|user|runner|you|example)(/|[\"'\`[:space:]]|$)"; then
  echo "error: tracked files above contain a machine-specific home path; derive it from os.homedir(), XDG or an env var" >&2
  status=1
fi

# Every workflow pins the Bun version in .bun-version.
want="$(tr -d '[:space:]' < .bun-version)"
if git grep -n -E "bun-version:" -- .github/workflows | grep -v -E "bun-version: '?${want//./\\.}'?[[:space:]]*$"; then
  echo "error: workflow Bun versions above differ from .bun-version ($want)" >&2
  status=1
fi

[ "$status" = 0 ] && echo "tracked files: no machine paths; workflows pin Bun $want"
exit "$status"
