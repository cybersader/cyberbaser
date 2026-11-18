#!/usr/bin/env bash
# Run locally what the pull-request workflows in .github/workflows run.
#
#   bun run check            installs, then every unit and fixture suite CI runs
#   bun run check -- --full  also the Rust tests, browser acceptance fixtures and
#                            container builds (needs cargo, Chromium deps, Docker)
#
# Nothing here reads the maintainer's machine: no secrets, no network services
# beyond package registries, no paths outside this checkout and the OS temp dir.
set -euo pipefail
cd "$(dirname "$0")/.."

FULL=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    *) echo "unknown option: $arg (use --full)" >&2; exit 2 ;;
  esac
done

want="$(tr -d '[:space:]' < .bun-version)"
have="$(bun --version)"
if [ "$have" != "$want" ]; then
  echo "warning: Bun $have is installed; CI uses $want (.bun-version)" >&2
fi

step() { printf '\n==> %s\n' "$1"; }

step "install (same order as CI)"
for dir in \
  packages/ofm packages/publish packages/trust packages/projection \
  packages/proposal packages/forgejo-intake packages/proposal-queue \
  packages/proposal-review packages/ledger packages/account-free-intake \
  apps/account-free-intake apps/owner-alpha \
  spikes/federation-fixture spikes/iroh-proposal-transfer; do
  bun install --cwd "$dir" --frozen-lockfile >/dev/null
done
bun install --cwd docs --frozen-lockfile >/dev/null

step "proposal, proposal-queue, proposal-review, ledger, forgejo-intake"
bun test packages/proposal/test
bun test packages/proposal-queue/test
bun test packages/proposal-review/test
bun test packages/ledger/test
bun test packages/forgejo-intake/test

step "account-free intake"
bun test packages/account-free-intake/test
bun test apps/account-free-intake/test
bun test deploy/account-free-intake/test

step "Quartz renderer"
bash renderers/quartz-cyberbase/tests/run.sh

step "federation fixture"
( cd spikes/federation-fixture && bun test && bun run verify )

step "owner app"
bun test apps/owner-alpha/test
bun test deploy/owner-alpha/test

step "iroh proposal transfer (JavaScript side)"
bun test spikes/iroh-proposal-transfer/test
bun test packages/proposal-queue/test/ci-structure.test.js

if [ "$FULL" = 1 ]; then
  step "iroh proposal transfer (Rust, needs cargo)"
  cargo test --locked --manifest-path spikes/iroh-proposal-transfer/Cargo.toml
  bun run spikes/iroh-proposal-transfer/bin/verify.js

  step "owner acceptance fixtures (needs Chromium)"
  ( cd docs && bunx playwright install chromium )
  OWNER_ALPHA_ACCEPTANCE=1 bun test apps/owner-alpha/test/acceptance.test.js
  OWNER_ALPHA_ACCEPTANCE=1 bun test apps/owner-alpha/test/proposal-review-acceptance.test.js
  OWNER_ALPHA_ACCEPTANCE=1 bun test apps/owner-alpha/test/proposal-review-browser.test.js

  step "containers (needs Docker)"
  docker build --file deploy/owner-alpha/Containerfile --tag cyberbaser-owner-alpha:ci .
  OWNER_ALPHA_CONTAINER_IMAGE="$(docker image inspect --format '{{.Id}}' cyberbaser-owner-alpha:ci)" \
    bun test deploy/owner-alpha/test/runtime-acceptance.test.js
  docker build --file deploy/account-free-intake/Containerfile --tag cyberbaser-account-free-intake:ci .
  ACCOUNT_FREE_INTAKE_CONTAINER_IMAGE="$(docker image inspect --format '{{.Id}}' cyberbaser-account-free-intake:ci)" \
    bun test deploy/account-free-intake/test/runtime-acceptance.test.js
fi

step "tracked files"
bash scripts/check-tracked-files.sh

printf '\nAll checks passed%s.\n' "$([ "$FULL" = 1 ] && echo ' (full)' || echo '; CI also runs the --full steps')"
