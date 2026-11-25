#!/bin/bash
# Runs as root inside the disposable systemd container (see run.sh), with no
# network but loopback. A private-only install with the site's own renderer,
# on copies of a real vault: install --site private --renderer, setup against a
# stand-in GitHub holding the vault as a private repository, "Keep it private",
# pair the owner's phone (the Obsidian plugin's own code, headless) and enrol
# it, then one New post with a cover photo: the phone sends it, approves it,
# the publisher pushes exactly that commit, and the node rebuilds its private
# site from it and confirms the new page there (private-site-live). Nothing
# touches GitHub Pages or any deployment API.
#
# No GitHub client ID is given to install: setup creates the owner's own GitHub
# App from a manifest on the stand-in GitHub's pages (Create, Install,
# Authorize), and the test checks that the app's private key and webhook secret
# never reach any disk or log, and its client secret stays with the publisher.
#
# Mounted by run.sh: /test/renderer (assembled renderer copy), /test/content
# (Git clone of the vault), /test/post (note.md, cover.jpg).
set -u
PROGRAM=/test/cyberbaser
SEED=/test/quartz-seed.tar.zst
FAKE_PORT=48080
RELAY_PORT=48081
PHONE_PORT=48090
RELAY="http://127.0.0.1:$RELAY_PORT/"
REPO=cybersader/cyberchief
QUARTZ=4923affa7722dfc751f1074348e6dad214fe0c08
FINGERPRINT="build,quartz.config.ts,quartz.layout.ts,package.json,package-lock.json,quartz/components/cyberchief,quartz/styles/custom.scss,quartz/cyberbase,cyberbase-patches,cyberchief-patches,quartz/plugins/cyberchief,quartz/static/fonts,quartz/static/logo,quartz/static/photos,quartz/static/favicon.svg,quartz/static/icon.png"
TOPIC='Threats & response'
TITLE='Patch the edge first'
NOTE="$TOPIC/$TITLE/$TITLE.md"
COVER="$TOPIC/$TITLE/$TITLE cover.jpg"
PAGE_PATH=/threats-and-response/patch-the-edge-first
TOKEN_RE='gh[ur]_CANARY[0-9a-f]{36}'
PEM_RE='BEGIN RSA PRIVATE KEY|FAKEPEMCANARY|whsCANARY'
REGISTRATION=/var/lib/cyberbaser-publisher/forge/github-app-registration.json
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL $*"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
refused() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$name (was allowed)"; else pass "$name"; fi; }
as_node() { setpriv --reuid=cyberbaser --regid=cyberbaser-share --init-groups --reset-env -- env PATH=/opt/cyberbaser/libexec:/usr/local/bin:/usr/bin:/bin HOME=/var/lib/cyberbaser/home "$@"; }
browser() { BUN_BE_BUN=1 $PROGRAM /var/tmp/cb-test/owner-browser.mjs "$@"; }
json_field() { sed -n "s/.*\"$1\":\"\\{0,1\\}\\([^\",}]*\\).*/\\1/p" | head -1; }
wait_active() { for _ in $(seq 1 120); do [ "$(systemctl is-active "$1")" = active ] && return 0; sleep 0.5; done; return 1; }
journal_has() { journalctl -u "$1" --no-pager -o cat | grep -q -- "$2"; }
wait_journal() { for _ in $(seq 1 240); do journal_has "$1" "$2" && return 0; sleep 0.5; done; return 1; }
hosted_main() { git -C "$HOSTED" rev-parse main; }
phone() { local body="${2:-}"; [ -n "$body" ] || body='{}'; curl -s --max-time 900 -X POST -H 'Content-Type: application/json' --data-binary "$body" "http://127.0.0.1:$PHONE_PORT/$1"; }
json() { BUN_BE_BUN=1 $PROGRAM -e "$1" "${@:2}"; }
HOSTED=/srv/gh/$REPO.git
CHECKOUT=/var/lib/cyberbaser-shared/notes/notes
CONFIG=/var/lib/cyberbaser/config/owner-alpha.json
SITE=/var/lib/cyberbaser-shared/workspace/owner-alpha/site
RENDERER=/var/lib/cyberbaser/renderers/cyberchief
READER=http://127.0.0.1:4318

until systemctl is-system-running --quiet 2>/dev/null || [ "$(systemctl is-system-running 2>/dev/null)" = degraded ]; do sleep 0.5; done
mkdir -p /var/tmp/cb-test && install -m 0644 /test/scripts/owner-browser.mjs /test/scripts/phone.mjs /test/scripts/signing-device.mjs /var/tmp/cb-test/
# As the node, with the job store where the node service sees it (as in setup-e2e.sh).
device() {
  systemd-run --quiet --wait --pipe --collect --uid=cyberbaser --gid=cyberbaser-share \
    -p UMask=0007 -p BindPaths=/var/lib/cyberbaser-shared/workspace:/opt/cyberbaser/.workspace -p RuntimeMaxSec=180 \
    -E CYBERBASER_SHARED_STORE=group -E PATH=/opt/cyberbaser/libexec:/usr/local/bin:/usr/bin:/bin -E HOME=/var/lib/cyberbaser/home \
    -E BUN_BE_BUN=1 /opt/cyberbaser/bin/cyberbaser /var/tmp/cb-test/signing-device.mjs "$@"
}
git config --global user.name Synthetic; git config --global user.email synthetic@example.invalid
git config --global init.defaultBranch main
git config --global --add safe.directory '*'

echo "== a stand-in GitHub holding a copy of the vault as a private repository"
mkdir -p "$(dirname "$HOSTED")"
git clone -q --bare /test/content "$HOSTED" && git -C "$HOSTED" remote remove origin
BASE=$(hosted_main)
SAMPLES=$(git -C "$HOSTED" grep -l '^sample: true' main -- '*.md' | sed 's/^main://')
[ "$(printf '%s\n' "$SAMPLES" | grep -c .)" -gt 0 ] && pass "the vault copy has $(printf '%s\n' "$SAMPLES" | grep -c .) sample notes" || fail "no sample notes in the copy"
systemd-run --quiet --unit=fake-github -p WorkingDirectory=/srv -E FAKE_GITHUB_PORT=$FAKE_PORT -E BUN_BE_BUN=1 -E HOME=/srv \
  -E PATH=/usr/bin:/bin $PROGRAM /src/apps/owner-alpha/test/fake-github.js /srv/gh
for _ in $(seq 1 60); do curl -fs -o /dev/null "http://127.0.0.1:$FAKE_PORT/_control/report" && break; sleep 0.25; done
curl -fs -X POST -H 'Content-Type: application/json' -d "{\"polls\":[\"authorization_pending\",\"ok\"],\"installations\":\"exact\",\"repository\":\"$REPO\",\"anonymousRead\":false,\"requireInstall\":true}" \
  "http://127.0.0.1:$FAKE_PORT/_control/scenario" >/dev/null
refused "the private repository is refused without a token" git -c credential.helper= ls-remote "http://127.0.0.1:$FAKE_PORT/git/$REPO.git"
systemd-run --quiet --unit=test-relay bash -c "sleep infinity | /src/bin/loopback-relay $RELAY_PORT"
check "the test Iroh relay answers" bash -c "for _ in \$(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:$RELAY_PORT/ && exit 0; sleep 0.25; done; exit 1"
cat > /usr/local/bin/git <<SHIM
#!/bin/bash
args=("\$@"); i=0
while [ \$i -lt \${#args[@]} ]; do
  case "\${args[\$i]}" in --git-dir|-C|-c) i=\$((i+2));; --no-pager|--no-replace-objects) i=\$((i+1));; --*=*) i=\$((i+1));; *) break;; esac
done
case "\${args[\$i]:-}" in ls-remote|push|fetch)
  exec /usr/bin/git "\${args[@]:0:\$i}" -c protocol.http.allow=always -c url.http://127.0.0.1:$FAKE_PORT/git/.insteadOf=https://github.com/ "\${args[@]:\$i}";;
esac
exec /usr/bin/git "\$@"
SHIM
chmod 0755 /usr/local/bin/git

echo "== install: private site, with the site's own renderer"
refused "install refuses a renderer without its pinned Quartz commit" $PROGRAM install --site private \
  --renderer /test/renderer --renderer-name cyberchief --renderer-quartz-commit "$(printf 'a%.0s' $(seq 40))" --renderer-fingerprint "$FINGERPRINT"
check "and changed nothing" test ! -e /etc/cyberbaser/install.json
$PROGRAM install --quartz-seed "$SEED" --github-origin "http://127.0.0.1:$FAKE_PORT" --iroh-relay "$RELAY" \
  --site private --renderer /test/renderer --renderer-name cyberchief --renderer-quartz-commit "$QUARTZ" --renderer-fingerprint "$FINGERPRINT" \
  | tee /tmp/install.out
LINK=$(sed -n 's/^Open this to finish setup: //p' /tmp/install.out)
[ -n "$LINK" ] && pass "install printed one setup link" || fail "install printed one setup link"
[ "$(stat -c '%U %a' "$RENDERER")" = "cyberbaser 700" ] && pass "the renderer copy is the node's, owner-only" || fail "renderer owner $(stat -c '%U %a' "$RENDERER")"
[ "$(find "$RENDERER" ! -type l -perm /022 | wc -l)" = 0 ] && pass "nothing in it is group or other writable" || fail "writable renderer files"
[ "$(find "$RENDERER" ! -type l ! -user cyberbaser | wc -l)" = 0 ] && pass "every file in it belongs to the node" || fail "renderer file owners"
[ "$(find "$RENDERER" -type l -lname '/*' | wc -l)" = 0 ] && pass "no link in it points outside" || fail "absolute links in renderer"
[ "$(sha256sum < /test/renderer/build)" = "$(sha256sum < "$RENDERER/build")" ] && pass "the build entry is the one given" || fail "build entry differs"
grep -q '"publication": "private-site"' /var/lib/cyberbaser/layout.json && grep -q '"directory": "/var/lib/cyberbaser/renderers/cyberchief"' /var/lib/cyberbaser/layout.json \
  && pass "the layout names the private site and the renderer" || { fail "layout"; cat /var/lib/cyberbaser/layout.json; }
check "publisher in setup mode" wait_journal cyberbaser-publisher.service 'ready for setup'
refused "the publisher account cannot read the renderer" setpriv --reuid=cyberbaser-publisher --regid=cyberbaser-share --clear-groups -- ls "$RENDERER"
ENROLL=$(sed -n 's/^  Code: \([0-9A-Z-]*\).*/\1/p' /tmp/install.out | head -1)
[ -n "$ENROLL" ] && pass "install printed a first-device code" || fail "no first-device code"
systemctl show -p RestrictNamespaces --value cyberbaser-node.service | tee /tmp/ns.out
grep -qw user /tmp/ns.out && grep -qw net /tmp/ns.out && ! grep -qw mnt /tmp/ns.out && pass "the node may make only user and network namespaces" || fail "node namespaces"

grep -q '"clientId"' /etc/cyberbaser/install.json && fail "the install record names a client ID" || pass "install took no GitHub client ID"

echo "== setup: create the GitHub App on GitHub, install it, the private repository, Keep it private"
browser setup-private "$LINK" "$REPO" /tmp/owner.cookie | tee /tmp/setup.out
grep -q '"ok":true' /tmp/setup.out && pass "setup ran to the phone step" || fail "setup to the phone step"
grep -q '"manifest":{"formAllowed":true,"replayRefused":true,"githubClicks":3}' /tmp/setup.out \
  && pass "the owner clicked only GitHub's Create, Install and Authorize; a replayed return was refused" || fail "manifest flow"
[ "$(stat -c '%U %a' "$REGISTRATION" 2>/dev/null)" = "cyberbaser-publisher 600" ] && pass "the app registration is the publisher's, owner-only" \
  || fail "registration $(stat -c '%U %a' "$REGISTRATION" 2>&1)"
grep -q '"createdBy":"manifest"' "$REGISTRATION" && pass "the publisher records the app as created by manifest" || fail "createdBy"
APP_CLIENT=$(sed -n 's/.*"clientId":"\(Iv[0-9A-Za-z.]*\)".*/\1/p' "$REGISTRATION")
[ -n "$APP_CLIENT" ] && pass "the created app's client ID is $APP_CLIENT" || fail "no client ID in the registration"
grep -q '"publishYmlKept":true' /tmp/setup.out && pass "the vault's own publish.yml is kept, no starter" || fail "publish.yml"
grep -q '"privateOffered":true' /tmp/setup.out && pass "the website step offers Keep it private with the node's address" || fail "private offer"
[ "$(hosted_main)" = "$BASE" ] && pass "nothing reached GitHub during setup" || fail "setup pushed"

echo "== pair the phone, then Done"
systemd-run --quiet --unit=test-phone -E BUN_BE_BUN=1 -E HOME=/tmp $PROGRAM /var/tmp/cb-test/phone.mjs $PHONE_PORT
check "the phone runs" bash -c "for _ in \$(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:$PHONE_PORT/ && exit 0; sleep 0.25; done; exit 1"
browser pair-start /setup owner-device full 'My phone' /tmp/owner.cookie > /tmp/pair.out
PAIR_CODE=$(json_field code < /tmp/pair.out); PAIR_ID=$(json_field enrollmentId < /tmp/pair.out)
phone pair "{\"code\":\"$PAIR_CODE\"}" > /tmp/phone-words.out
browser pair-confirm /setup "$PAIR_ID" /tmp/owner.cookie > /tmp/pair-confirm.out
PHONE_WORDS=$(sed -n 's/.*"words":\(\[[^]]*\]\).*/\1/p' /tmp/phone-words.out); NODE_WORDS=$(sed -n 's/.*"words":\(\[[^]]*\]\).*/\1/p' /tmp/pair-confirm.out)
[ -n "$PHONE_WORDS" ] && [ "$PHONE_WORDS" = "$NODE_WORDS" ] && pass "phone and setup page show the same four words" || { fail "pairing words"; cat /tmp/phone-words.out /tmp/pair-confirm.out; }
phone paired | grep -q '"publish"' && pass "the phone is paired with publish approval" || fail "phone paired"
browser step continue /tmp/owner.cookie | grep -q '"step":"agent"' && pass "on to Pair an agent" || fail "phone continue"
browser step skip /tmp/owner.cookie | tee /tmp/done.out | grep -q '"step":"done"' && pass "setup ran start to Done" || { fail "Done"; cat /tmp/done.out; }
browser landed /tmp/owner.cookie | grep -q '"ok":true' && pass "the owner lands in the node signed in" || { fail "landed"; journalctl -u cyberbaser-node.service --no-pager -o cat | tail -20; }
grep -q '"provider": "private-site"' "$CONFIG" && pass "the node config publishes to the private site" || fail "config provider"
grep -q '"baseUrl": "https://cyberchief.me/"' "$CONFIG" && pass "its page identity is the vault's own site address" || fail "config live.baseUrl"
grep -q '"name": "cyberchief"' "$CONFIG" && pass "and builds with the cyberchief renderer" || fail "config renderer"
grep -q "\"clientId\": \"$APP_CLIENT\"" "$CONFIG" && pass "the node config names the created app's public client ID" || fail "config client ID"
! grep -q 'github-pages\|deploy-pages\|"environment"' "$CONFIG" && pass "with no Pages environment or workflow" || fail "config names Pages"
check "the publisher switched to normal mode" wait_journal cyberbaser-publisher.service 'owner-alpha publisher ready'

echo "== the phone becomes the signing device"
PUBLISHER=$(device publisher | json_field publisher)
ENROL_LINK=$(printf 'cyberbaser-enroll:v1?publisher=%s&code=%s' "$PUBLISHER" "$ENROLL")
phone enrol "{\"link\":\"$ENROL_LINK\"}" | tee /tmp/enrol.out | grep -q '"ok":true' && pass "the phone enrolled with the printed code" || { fail "enrol"; cat /tmp/enrol.out; }

echo "== the private site: built by the cyberchief renderer, offline, samples held back"
for _ in $(seq 1 600); do [ -f "$SITE/owner-alpha-site-manifest.json" ] && break; sleep 1; done
grep -q '"name": *"cyberchief"' "$SITE/owner-alpha-site-manifest.json" 2>/dev/null && pass "the node built its private site with the cyberchief renderer" \
  || { fail "private site build"; journalctl -u cyberbaser-node.service --no-pager -o cat | grep -iE 'renderer|site|build' | tail -20; }
curl -fs "$READER/" -H 'Host: 127.0.0.1:4318' -o /tmp/home.html && grep -q 'Cyberchief' /tmp/home.html && pass "the node serves it at $READER/" || fail "reader home"
SAMPLE_SEEN=0
while IFS= read -r sample; do
  [ -n "$sample" ] || continue
  line=$(git -C "$HOSTED" show "main:$sample" | awk 'BEGIN{f=0} /^---$/{f++; next} f>=2 && length($0) >= 50 && $0 !~ /^[#>|!-]/ {print; exit}' | cut -c1-60)
  [ -n "$line" ] && grep -rqF -- "$line" "$SITE" --include='*.html' && { SAMPLE_SEEN=$((SAMPLE_SEEN + 1)); echo "  sample shown: $sample"; }
done <<< "$SAMPLES"
[ "$SAMPLE_SEEN" = 0 ] && pass "no sample note's text appears anywhere on the private site" || fail "$SAMPLE_SEEN sample notes on the site"
for address in /threats-and-response/running-a-tabletop-exercise /about /contact; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$READER$address")
  [ "$code" = 404 ] && pass "the sample page $address answers 404" || fail "sample page $address answers $code"
done

echo "== New post from the phone, with a cover photo"
NOTE_JSON=$(json 'const fs=require("fs");process.stdout.write(JSON.stringify({path:process.argv[1],text:fs.readFileSync("/test/post/note.md","utf8"),publishYml:fs.readFileSync(process.argv[3],"utf8"),siteYml:fs.readFileSync(process.argv[4],"utf8"),image:{path:process.argv[2],file:"/test/post/cover.jpg"}}))' \
  "$NOTE" "$COVER" "$CHECKOUT/publish.yml" "$CHECKOUT/.cyberbaser/site.yml")
phone newPost "$NOTE_JSON" | tee /tmp/newpost.out
BUNDLE=$(json_field bundleId < /tmp/newpost.out)
grep -q '"kind":"publishing"' /tmp/newpost.out && [ -n "$BUNDLE" ] && pass "the post was sent and waits for approval ($BUNDLE)" || fail "new post"
grep -q "\"address\":\"$PAGE_PATH\"" /tmp/newpost.out && pass "at the address the form showed ($PAGE_PATH)" || fail "address"
[ "$(hosted_main)" = "$BASE" ] && pass "nothing pushed before approval" || fail "pushed before approval"
APPROVE_JSON=$(json 'const fs=require("fs");process.stdout.write(JSON.stringify({path:process.argv[1],publishYml:fs.readFileSync(process.argv[2],"utf8"),siteYml:fs.readFileSync(process.argv[3],"utf8")}))' \
  "$NOTE" "$CHECKOUT/publish.yml" "$CHECKOUT/.cyberbaser/site.yml")
phone approveIncluding "$APPROVE_JSON" | tee /tmp/approve.out
grep -q '"ok":true' /tmp/approve.out && pass "the phone approved exactly the note and its cover" || fail "approve"
for _ in $(seq 1 240); do [ "$(hosted_main)" != "$BASE" ] && break; sleep 0.5; done
AFTER=$(hosted_main)
[ "$AFTER" != "$BASE" ] && [ "$(git -C "$HOSTED" rev-parse main^)" = "$BASE" ] && pass "the publisher pushed one commit" || fail "push"
[ "$(git -C "$HOSTED" diff --name-only "$BASE" main | sort | tr '\n' '|')" = "$(printf '%s\n%s\n' "$COVER" "$NOTE" | sort | tr '\n' '|')" ] \
  && pass "it holds exactly the note and its cover" || { fail "pushed files"; git -C "$HOSTED" diff --name-only "$BASE" main; }

echo "== Live on the private site"
STEP=""
for _ in $(seq 1 300); do
  phone progress "{\"bundleId\":\"$BUNDLE\"}" > /tmp/progress.out
  STEP=$(json_field step < /tmp/progress.out)
  [ "$STEP" = live ] || [ "$STEP" = failed ] && break
  sleep 3
done
cat /tmp/progress.out; echo
[ "$STEP" = live ] && pass "the phone's progress reads Live" || { fail "progress $STEP"; journalctl -u cyberbaser-node.service --no-pager -o cat | tail -30; }
grep -q '"site":"private"' /tmp/progress.out && pass "on the private site" || fail "site private"
grep -q "\"url\":\"$READER$PAGE_PATH\"" /tmp/progress.out && pass "with the node's private link" || fail "private link"
curl -fs "$READER$PAGE_PATH" -o /tmp/post.html && grep -qF "$TITLE" /tmp/post.html && pass "the node serves the new page" || fail "new page served"
JOB=/var/lib/cyberbaser-shared/workspace/owner-alpha/store/jobs/OA-$BUNDLE
grep -rqs '"evidence": *"private-site-live"' "$JOB" && pass "the job's live evidence is private-site-live" || { fail "live evidence"; ls -R "$JOB" 2>&1 | head; }
grep -rqs '"provider": *"private-site"' "$JOB" && pass "its deployment is the node's private build" || fail "deployment evidence"
[ "$(git -c safe.directory='*' -C "$CHECKOUT" rev-parse HEAD)" = "$AFTER" ] && pass "the notes copy is at the pushed commit" || fail "checkout head"
grep -q "\"head\": *\"$AFTER\"" "$SITE/owner-alpha-site-manifest.json" && pass "the private site is built from it" || fail "manifest head"
IMG=$(grep -o "src=\"[^\"]*cover[^\"]*\"" /tmp/post.html | head -1)
echo "  cover on the page: ${IMG:-none}"

echo "== GitHub was used for Git only"
curl -fs "http://127.0.0.1:$FAKE_PORT/_control/report" > /tmp/report.json
grep -o '"routes":\[[^]]*\]' /tmp/report.json
grep -o '"routes":\[[^]]*\]' /tmp/report.json | grep -qiE 'pages|actions|deployments|environments|workflows' && fail "a Pages, Actions or deployment API was called" \
  || pass "no Pages, Actions or deployment API was called"
journalctl --no-pager -o cat | grep -qaE "$TOKEN_RE" && fail "the journal holds the token" || pass "the journal holds no token"
grep -o '"manifest":{[^}]*' /tmp/report.json | head -1
grep -q '"converted":1,"refusedConversions":0,"installs":1,"authorizations":1,"webExchanges":1' /tmp/report.json \
  && pass "GitHub converted one app, saw one install and one web sign-in" || fail "manifest report"
[ "$(grep -rlsaE "$PEM_RE" /var/lib/cyberbaser-publisher /var/lib/cyberbaser /var/lib/cyberbaser-shared /etc/cyberbaser /run/cyberbaser /run/cyberbaser-publisher /tmp /var/tmp | wc -l)" = 0 ] \
  && pass "the app's private key and webhook secret are on no disk" || { fail "private key on disk"; grep -rlsaE "$PEM_RE" /var/lib /etc/cyberbaser /tmp /var/tmp | head; }
journalctl --no-pager -o cat | grep -qaE "$PEM_RE|cbsCANARY" && fail "the journal holds an app secret" || pass "the journal holds no app secret or key"
[ "$(grep -rlsa cbsCANARY /var/lib/cyberbaser /var/lib/cyberbaser-shared /etc/cyberbaser /tmp /var/tmp | wc -l)" = 0 ] \
  && pass "the client secret is only in the publisher's state" || fail "client secret outside the publisher"
[ "$(grep -rlsa cbsCANARY /var/lib/cyberbaser-publisher)" = "$REGISTRATION" ] && pass "and there only in its registration file" || fail "client secret elsewhere in the publisher"
[ "$(grep -rlsaE "$TOKEN_RE" "$RENDERER" "$SITE" | wc -l)" = 0 ] && pass "the renderer and the private site hold no credential" || fail "credential in renderer/site"

systemd-analyze security cyberbaser-node.service 2>/dev/null | tail -1 | sed 's/^/node unit: /'
echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
