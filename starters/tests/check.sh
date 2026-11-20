#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd -P)
cd "$root"
t=$(mktemp -d); trap 'rm -rf -- "$t"' EXIT
cp -R starters/example-vault "$t/vault"
cp -R "$t/vault" "$t/original"
bash starters/build.sh both "$t/vault" "$t/sites"
diff -qr "$t/original" "$t/vault"
python3 -I starters/tests/check-fixture.py "$t/sites"
# Independent expected public set, not another invocation of the selector.
mkdir -p "$t/expected/field-notes" "$t/expected/assets"
cp "$t/original/README.md" "$t/expected/"
cp "$t/original/field-notes/tide-pools.md" "$t/expected/field-notes/"
cp "$t/original/assets/tide.png" "$t/expected/assets/"
python3 -I starters/tests/check-solid-projection.py "$t/expected" "$t/sites/solid"
node docs/starter-tests/readers.mjs "$t/sites"
if bash starters/build.sh quartz "$t/vault" "$t/sites"; then exit 1; fi
if bash starters/build.sh solid "$t/vault" "$t/vault/out"; then exit 1; fi
test ! -e "$t/vault/out"
mkdir "$t/broken"; printf 'allow: [\n' > "$t/broken/publish.yml"
if bash starters/build.sh both "$t/broken" "$t/failed-site"; then exit 1; fi
test ! -e "$t/failed-site"
echo 'Both starter builds and boundary checks passed.'
