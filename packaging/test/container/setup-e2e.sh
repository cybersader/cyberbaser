#!/bin/bash
# Runs as root inside the disposable systemd container (see run.sh), with no
# network but loopback. The whole first install with owner-signed publishing:
# install, the printed setup link, sign in to a stand-in GitHub, pick a private
# repository (the publisher fetches it), choose public folders (the starter
# publish.yml waits as the first signed publish), pair the owner's phone (the
# Obsidian plugin's own code, headless), pair an agent, Done; the phone enrols
# with the publisher's one-time code and approves the starter, which is
# pushed. Then one agent proposal over the local signed socket, approved and
# applied; the job waits for the phone's signature and the publisher pushes
# exactly that commit. Then the refusals a compromised node might try, device
# recovery, the token canary and a restart with GitHub down. Synthetic data only.
set -u
PROGRAM=/test/cyberbaser
SEED=/test/quartz-seed.tar.zst
FAKE_PORT=48080
RELAY_PORT=48081
PHONE_PORT=48090
RELAY="http://127.0.0.1:$RELAY_PORT/"
CLIENT_ID=Iv23liFAKEcyberbaser
TOKEN_RE='gh[ur]_CANARY[0-9a-f]{36}'
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
CHECKOUT=/var/lib/cyberbaser-shared/notes/notes
MIRROR=/var/lib/cyberbaser-shared/mirror/notes.git
HOSTED=/srv/gh/cybersader/cyberbase.git
CONFIG=/var/lib/cyberbaser/config/owner-alpha.json

until systemctl is-system-running --quiet 2>/dev/null || [ "$(systemctl is-system-running 2>/dev/null)" = degraded ]; do sleep 0.5; done
mkdir -p /var/tmp/cb-test && install -m 0644 /test/scripts/owner-browser.mjs /test/scripts/agent-lane.mjs /test/scripts/signing-device.mjs \
  /test/scripts/phone.mjs /var/tmp/cb-test/
# As the node, with the job store where the node service sees it (as save-job in install-test.sh).
device() {
  systemd-run --quiet --wait --pipe --collect --uid=cyberbaser --gid=cyberbaser-share \
    -p UMask=0007 -p BindPaths=/var/lib/cyberbaser-shared/workspace:/opt/cyberbaser/.workspace -p RuntimeMaxSec=180 \
    -E CYBERBASER_SHARED_STORE=group -E PATH=/opt/cyberbaser/libexec:/usr/local/bin:/usr/bin:/bin -E HOME=/var/lib/cyberbaser/home \
    -E BUN_BE_BUN=1 /opt/cyberbaser/bin/cyberbaser /var/tmp/cb-test/signing-device.mjs "$@"
}
# The owner's phone (phone.mjs): one JSON request, one JSON reply.
phone() { local body="${2:-}"; [ -n "$body" ] || body='{}'; curl -s --max-time 300 -X POST -H 'Content-Type: application/json' -d "$body" "http://127.0.0.1:$PHONE_PORT/$1"; }
FRESH=/var/lib/cyberbaser/fresh.json
git config --global user.name Synthetic; git config --global user.email synthetic@example.invalid
git config --global init.defaultBranch main

echo "== a stand-in GitHub on loopback with one private repository, and a test Iroh relay"
mkdir -p /srv/work/Garden /srv/work/Journal /srv/gh/cybersader
printf '# Roses\n\nPrune the roses in March.\n' > /srv/work/Garden/Roses.md
printf '# Tulips\n\nPlant tulips in autumn.\n' > /srv/work/Garden/Tulips.md
printf '# Private\n\nNot for the website.\n' > /srv/work/Journal/Private.md
printf '# Home\n\nSee [[Garden/Roses]].\n' > /srv/work/Home.md
# The owner's trust policy (an existing vault convention): the owner is trusted.
mkdir -p /srv/work/.cyberbaser && printf 'trusted: [cybersader]\nagents: []\n' > /srv/work/.cyberbaser/trust.yml
git -C /srv/work init -q && git -C /srv/work add -A && git -C /srv/work commit -qm 'synthetic notes'
git init -q --bare "$HOSTED" && git -C /srv/work push -q "$HOSTED" main
BASE=$(hosted_main)
start_fake() {
  systemd-run --quiet --unit=fake-github -p WorkingDirectory=/srv -E FAKE_GITHUB_PORT=$FAKE_PORT -E BUN_BE_BUN=1 -E HOME=/srv \
    -E PATH=/usr/bin:/bin $PROGRAM /src/apps/owner-alpha/test/fake-github.js /srv/gh
  for _ in $(seq 1 60); do curl -fs -o /dev/null "http://127.0.0.1:$FAKE_PORT/_control/report" && break; sleep 0.25; done
  curl -fs -X POST -H 'Content-Type: application/json' -d '{"polls":["authorization_pending","ok"],"installations":"exact","anonymousRead":false}' \
    "http://127.0.0.1:$FAKE_PORT/_control/scenario" >/dev/null
}
start_fake
check "the stand-in GitHub answers" curl -fs -o /dev/null "http://127.0.0.1:$FAKE_PORT/_control/report"
refused "the private repository is refused without a token" git -c credential.helper= ls-remote "http://127.0.0.1:$FAKE_PORT/git/cybersader/cyberbase.git"
# Test-only: an Iroh relay on loopback (the real install uses n0's public relay). It runs until its stdin closes.
systemd-run --quiet --unit=test-relay bash -c "sleep infinity | /src/bin/loopback-relay $RELAY_PORT"
check "the test Iroh relay answers" bash -c "for _ in \$(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:$RELAY_PORT/ && exit 0; sleep 0.25; done; exit 1"
# Test-only: GitHub's Git URL goes to the stand-in. Transport commands only; nothing else changes.
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

echo "== install"
$PROGRAM install --quartz-seed "$SEED" --github-client-id "$CLIENT_ID" --github-origin "http://127.0.0.1:$FAKE_PORT" --iroh-relay "$RELAY" | tee /tmp/install.out
LINK=$(sed -n 's/^Open this to finish setup: //p' /tmp/install.out)
[ -n "$LINK" ] && pass "install printed one setup link" || fail "install printed one setup link"
check "publisher service runs before any config" wait_active cyberbaser-publisher.service
check "the publisher started in setup mode" wait_journal cyberbaser-publisher.service 'ready for setup'
check "no node config yet" test ! -e "$CONFIG"
[ "$(stat -c '%U:%G %a' /var/lib/cyberbaser-shared/mirror)" = "cyberbaser-publisher:cyberbaser-share 750" ] && pass "mirror folder: publisher-owned, group read-only" || fail "mirror folder $(stat -c '%U:%G %a' /var/lib/cyberbaser-shared/mirror)"
ENROLL=$(sed -n 's/^  Code: \([0-9A-Z-]*\).*/\1/p' /tmp/install.out | head -1)
RECOVERY=$(sed -n '/If you ever lose every device/{n;s/^  //p}' /tmp/install.out | head -1)
[ -n "$ENROLL" ] && [ -n "$RECOVERY" ] && pass "install printed a first-device code and a recovery code" || fail "install printed codes"
journalctl --no-pager -o cat | grep -qF "$RECOVERY" && fail "the journal holds the recovery code" || pass "the recovery code is nowhere in the journal"
refused "the node cannot read the publisher's owner keys" as_node ls /var/lib/cyberbaser-publisher/owners
curl -fs http://127.0.0.1:4319/enroll | grep -qF "$ENROLL" && pass "the publisher's own page shows the code on this computer" || fail "enroll page"
refused "that page refuses the node account" as_node curl -fs -o /dev/null http://127.0.0.1:4319/enroll
curl -fs -H 'Origin: http://127.0.0.1:4317' http://127.0.0.1:4319/enroll >/dev/null && fail "a script from the web app read the code" || pass "a script from the web app cannot read the code"

echo "== setup in the owner's browser: GitHub, the private repository, public folders"
browser setup-to-phone "$LINK" /tmp/owner.cookie | tee /tmp/setup.out
grep -q '"ok":true' /tmp/setup.out && pass "setup ran to the phone step" || fail "setup to the phone step"
grep -q '"multiSelect":true' /tmp/setup.out && pass "Your notes shows an unchecked multi-select and a Show the file disclosure" || fail "multi-select markup"
grep -q '"starterWaiting":true' /tmp/setup.out && pass "the starter publish.yml waits for the owner's phone" || fail "starter waits"
[ "$(hosted_main)" = "$BASE" ] && pass "nothing reached GitHub during setup" || fail "setup pushed"
check "the notes copy exists" test -d "$CHECKOUT/.git"
[ "$(stat -c %U "$CHECKOUT")" = cyberbaser ] && pass "the notes copy belongs to the node" || fail "notes copy owner"
[ "$(git -c safe.directory='*' -C "$CHECKOUT" remote get-url origin)" = "https://github.com/cybersader/cyberbase.git" ] && pass "the copy's remote is the plain HTTPS URL" || fail "copy remote"
[ "$(git -c safe.directory='*' -C "$MIRROR" config --list --local | grep -cE 'remote\.|url|credential|helper')" = 0 ] && pass "the mirror config names no remote, URL or helper" || fail "mirror config"
[ "$(stat -c %U "$MIRROR")" = cyberbaser-publisher ] && pass "the mirror belongs to the publisher" || fail "mirror owner"
refused "the node cannot write into the mirror" as_node touch "$MIRROR/objects/x"
SC=$(sed -n 's/.*"starterCommit": *"\([0-9a-f]\{40\}\)".*/\1/p' "$(find /var/lib/cyberbaser -name setup.json | head -1)" | head -1)
[ -n "$SC" ] && [ "$(git -c safe.directory='*' -C "$CHECKOUT" rev-parse "$SC^")" = "$BASE" ] && pass "the starter is one prepared commit on the repository's head" || fail "starter commit ($SC)"

echo "== pair the owner's phone (the plugin's own code), then an agent, then Done"
systemd-run --quiet --unit=test-phone -E BUN_BE_BUN=1 -E HOME=/tmp $PROGRAM /var/tmp/cb-test/phone.mjs $PHONE_PORT
check "the phone runs" bash -c "for _ in \$(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:$PHONE_PORT/ && exit 0; sleep 0.25; done; exit 1"
browser phone-page /tmp/owner.cookie > /tmp/phone-page.out
grep -q '"access":"full"' /tmp/phone-page.out && pass "the phone step preselects the access that may approve publishing" || { fail "phone access"; cat /tmp/phone-page.out; }
ACCESS=$(json_field access < /tmp/phone-page.out)
browser pair-start /setup owner-device "${ACCESS:-review}" 'My phone' /tmp/owner.cookie > /tmp/pair.out
PAIR_CODE=$(json_field code < /tmp/pair.out); PAIR_ID=$(json_field enrollmentId < /tmp/pair.out)
phone pair "{\"code\":\"$PAIR_CODE\"}" > /tmp/phone-words.out
browser pair-confirm /setup "$PAIR_ID" /tmp/owner.cookie > /tmp/pair-confirm.out
PHONE_WORDS=$(sed -n 's/.*"words":\(\[[^]]*\]\).*/\1/p' /tmp/phone-words.out); NODE_WORDS=$(sed -n 's/.*"words":\(\[[^]]*\]\).*/\1/p' /tmp/pair-confirm.out)
[ -n "$PHONE_WORDS" ] && [ "$PHONE_WORDS" = "$NODE_WORDS" ] && pass "phone and setup page show the same four words" || { fail "pairing words"; cat /tmp/phone-words.out /tmp/pair-confirm.out; }
phone paired | grep -q '"publish"' && pass "the phone is paired with publish approval" || fail "phone paired"
browser phone-page /tmp/owner.cookie > /tmp/phone-page.out
grep -q '"enrolFrame":true' /tmp/phone-page.out && grep -q '"frameAllowed":true' /tmp/phone-page.out && pass "the phone step then shows the publisher's own code frame" || { fail "enrol frame"; cat /tmp/phone-page.out; }
browser step continue /tmp/owner.cookie | grep -q '"step":"agent"' && pass "on to Pair an agent" || fail "phone continue"
browser pair-start /setup agent propose 'My agent' /tmp/owner.cookie > /tmp/pair.out
PAIR_CODE=$(json_field code < /tmp/pair.out); PAIR_ID=$(json_field enrollmentId < /tmp/pair.out)
useradd -m synthetic-agent
systemd-run --quiet --unit=test-agent-pair --uid=synthetic-agent -E HOME=/home/synthetic-agent /opt/cyberbaser/bin/cyberbaser pair "$PAIR_CODE" --state /home/synthetic-agent/agent-pairing.json
browser pair-confirm /setup "$PAIR_ID" /tmp/owner.cookie | grep -q '"ok":true' && pass "the agent paired after the owner compared words" || fail "agent pair confirm"
check "the agent kept its pairing" bash -c 'for _ in $(seq 1 60); do test -s /home/synthetic-agent/agent-pairing.json && exit 0; sleep 0.5; done; exit 1'
browser step continue /tmp/owner.cookie | tee /tmp/done.out | grep -q '"step":"done"' && pass "setup ran start to Done" || { fail "Done"; cat /tmp/done.out; }
sleep 2
browser devices /tmp/owner.cookie > /tmp/devices.out
grep -qE '"devices":\[("owner-device","agent"|"agent","owner-device")\]' /tmp/devices.out && grep -q '"pairings":0' /tmp/devices.out \
  && pass "Done left exactly one phone and one agent, no second pairing open" || { fail "devices after Done"; cat /tmp/devices.out; }

echo "== hand-off at Done"
browser landed /tmp/owner.cookie | tee /tmp/landed.out
grep -q '"ok":true' /tmp/landed.out && pass "the owner lands in the node signed in, with the setup cookie" \
  || { fail "landed signed in"; journalctl -u cyberbaser-node.service --no-pager -o cat | tail -8; }
check "the node config was written, owner-only" bash -c '[ "$(stat -c "%U %a" '"$CONFIG"')" = "cyberbaser 600" ]'
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$LINK")
[ "$STATUS" != 303 ] && [ "$STATUS" != 200 ] && pass "the setup link no longer works ($STATUS)" || fail "setup link still answers ($STATUS)"
check "the publisher switched to normal mode" wait_journal cyberbaser-publisher.service 'owner-alpha publisher ready'
[ "$(git -c safe.directory='*' -C "$CHECKOUT" config user.name)" = cybersader ] && pass "commits in the copy carry the owner's name" || fail "copy identity"
device starter-unsigned "$SC" | grep -q '"ok":false' && pass "the node cannot push the starter without a signature" || fail "unsigned starter"
device starter-forged "$CONFIG" "$SC" | grep -q '"code":"owner-approval-invalid"' && pass "nor with one made with the node's own key" || fail "node-signed starter"
[ "$(hosted_main)" = "$BASE" ] && pass "nothing reached GitHub" || fail "starter pushed unsigned"

echo "== the phone becomes the signing device, with the publisher's one-time code"
PUBLISHER=$(device publisher | json_field publisher)
FAKE_CODE=$(printf 'cyberbaser-enroll:v1?publisher=%s&code=%s' "$PUBLISHER" AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH)
phone enrol "{\"link\":\"$FAKE_CODE\"}" | grep -q '"ok":false' && pass "a code the node substituted enrols nothing" || fail "substituted code"
device forged-enroll AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH | grep -q '"code":"owner-enrollment-refused"' && pass "a node-made code enrols no node key either" || fail "forged enrollment"
ENROL_LINK=$(printf 'cyberbaser-enroll:v1?publisher=%s&code=%s' "$PUBLISHER" "$ENROLL")
phone enrolNoTap "{\"link\":\"$ENROL_LINK\"}" | grep -q '"code":"tap-required"' && pass "no tap, no enrolment" || fail "enrol without tap"
phone enrol "{\"link\":\"$ENROL_LINK\"}" | tee /tmp/enrol.out | grep -q '"ok":true' && pass "the phone enrolled with the printed code" || { fail "enrol"; cat /tmp/enrol.out; }
device forged-enroll "$ENROLL" | grep -q '"code":"owner-enrollment-closed"' && pass "the code works once" || fail "code reuse"

echo "== the starter publish.yml: approved on the phone, pushed by the publisher"
phone approve '{"paths":["publish.yml"]}' | tee /tmp/starter.out | grep -q '"ok":true' && pass "the phone was asked to approve exactly publish.yml" || { fail "starter offered"; cat /tmp/starter.out; }
for _ in $(seq 1 120); do [ "$(hosted_main)" != "$BASE" ] && break; sleep 0.5; done
STARTER=$(hosted_main)
[ "$STARTER" = "$SC" ] && pass "the publisher pushed exactly the prepared starter commit" || fail "starter push ($STARTER vs $SC)"
[ "$(git -C "$HOSTED" diff-tree --no-commit-id --name-status -r main)" = "$(printf 'A\tpublish.yml')" ] && pass "it adds exactly publish.yml" || fail "starter diff"
git -C "$HOSTED" show main:publish.yml | grep -qx '  - "Garden/\*\*"' && ! git -C "$HOSTED" show main:publish.yml | grep -q Journal && pass "publish.yml lists only the folder picked" || fail "starter content"
for _ in $(seq 1 40); do [ "$(git -c safe.directory='*' -C "$MIRROR" rev-parse main 2>/dev/null)" = "$STARTER" ] && [ "$(git -c safe.directory='*' -C "$CHECKOUT" rev-parse HEAD)" = "$STARTER" ] && break; sleep 0.5; done
[ "$(git -c safe.directory='*' -C "$CHECKOUT" rev-parse HEAD)" = "$STARTER" ] && [ "$(git -c safe.directory='*' -C "$MIRROR" rev-parse main)" = "$STARTER" ] && pass "copy and mirror are at that commit" || fail "copy/mirror head after starter"
phone lastApproved | sed -n 's/^{"ok":true,"record":\(.*\)}$/\1/p' > /tmp/starter-record.json
install -o cyberbaser -g cyberbaser-share -m 0640 /tmp/starter-record.json /var/lib/cyberbaser/home/starter-record.json

echo "== one agent proposal over the local signed socket"
as_node env BUN_BE_BUN=1 CB_TEST_NETWORK_TIMEOUT_MS=45000 /opt/cyberbaser/bin/cyberbaser /var/tmp/cb-test/agent-lane.mjs "$CONFIG" \
  /var/lib/cyberbaser/agent Garden/Roses.md 'in March' 'in late winter' > /tmp/agent-lane.out 2>&1 && pass "a synthetic agent key and snapshot" || { fail "agent lane"; cat /tmp/agent-lane.out; }
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart cyberbaser-node.service
wait_journal cyberbaser-node.service 'Owner alpha bootstrap: ' >/dev/null
BOOT=$(journalctl -u cyberbaser-node.service --since "$SINCE" --no-pager -o cat | sed -n 's/^Owner alpha bootstrap: //p' | tail -1)
[ -n "$BOOT" ] && pass "the node restarted with the agent lane" || { fail "node restart"; journalctl -u cyberbaser-node.service --no-pager -o cat | tail -5; }
check "the signed socket is up" bash -c 'for _ in $(seq 1 60); do test -S /run/cyberbaser/signed.sock && exit 0; sleep 0.5; done; exit 1'
as_node env BUN_BE_BUN=1 /opt/cyberbaser/bin/cyberbaser /src/apps/owner-alpha/bin/agent-propose.js /var/lib/cyberbaser/agent/capture.json \
  Garden/Roses.md /var/lib/cyberbaser/agent/snapshot /var/lib/cyberbaser/agent/key.json /run/cyberbaser/signed.sock > /tmp/propose.out 2>&1
QUEUE=$(json_field queueId < /tmp/propose.out)
[ -n "$QUEUE" ] && pass "the proposal was accepted ($QUEUE)" || { fail "proposal"; cat /tmp/propose.out; }
rm -f /tmp/owner.cookie
browser sign-in "$BOOT" /tmp/owner.cookie | grep -q '"ok":true' && pass "owner signed in again with the one-time link" || fail "sign-in"
browser approve "$QUEUE" /tmp/owner.cookie | tee /tmp/approve.out
JOB=$(json_field jobId < /tmp/approve.out)
grep -q '"state":"awaiting-approval"' /tmp/approve.out && pass "Apply: the job waits for the owner's signature" || fail "job waits for approval"
[ "$(hosted_main)" = "$STARTER" ] && pass "unsigned, nothing was pushed" || fail "unsigned job pushed"

echo "== what a compromised node might try, each with no push"
device attempt-forged "$CONFIG" "$JOB" | tee /tmp/a1.out | grep -q '"ok":false,"code":"owner-approval-' && pass "an approval the node forged under the phone's key ID is refused ($(json_field code < /tmp/a1.out))" || { fail "forged approval"; cat /tmp/a1.out; }
device attempt "$CONFIG" "$JOB" /var/lib/cyberbaser/home/starter-record.json | tee /tmp/a2.out | grep -q '"ok":false,"code":"owner-approval-' && pass "the phone's already used starter signature, replayed, is refused ($(json_field code < /tmp/a2.out))" || { fail "replay"; cat /tmp/a2.out; }
OTHER=$(device other-commit "$CONFIG" "$JOB" | json_field commit)
device intent "$CONFIG" "$OTHER" | sed -n 's/^{"ok":true,"intent":\(.*\)}$/{"intent":\1}/p' > /tmp/other-intent.json
phone signIntent "$(cat /tmp/other-intent.json)" | sed -n 's/^{"ok":true,"record":\(.*\)}$/\1/p' > /tmp/other-record.json
install -o cyberbaser -g cyberbaser-share -m 0640 /tmp/other-record.json /var/lib/cyberbaser/home/other-record.json
device attempt "$CONFIG" "$JOB" /var/lib/cyberbaser/home/other-record.json | tee /tmp/a3.out | grep -q '"ok":false,"code":"owner-approval-' && pass "a real signature for a different commit is refused ($(json_field code < /tmp/a3.out))" || { fail "other commit"; cat /tmp/a3.out; }
[ "$(hosted_main)" = "$STARTER" ] && pass "after all three, GitHub is unchanged" || fail "an attack pushed"
device job-commit "$CONFIG" "$JOB" | grep -q '"state":"awaiting-approval"' && pass "the job still waits for the owner" || fail "job state after attacks"

echo "== the phone approves; the publisher pushes exactly that commit"
COMMIT=$(device job-commit "$CONFIG" "$JOB" | json_field commit)
phone approve '{"paths":["Garden/Roses.md"]}' | tee /tmp/phone-approve.out | grep -q '"ok":true' && pass "the phone was asked to approve exactly Garden/Roses.md" || { fail "phone approve"; cat /tmp/phone-approve.out; }
grep -q 'late winter' /tmp/phone-approve.out && pass "and it showed the words that change" || fail "approval preview"
for _ in $(seq 1 120); do [ "$(hosted_main)" != "$STARTER" ] && break; sleep 0.5; done
AFTER=$(hosted_main)
[ "$AFTER" = "$COMMIT" ] && [ "$(git -C "$HOSTED" rev-parse main^)" = "$STARTER" ] && pass "the publisher pushed exactly the signed commit" || { fail "push after approve"; journalctl -u cyberbaser-node.service --no-pager -o cat | tail -5; }
git -C "$HOSTED" show main:Garden/Roses.md | grep -q 'in late winter' && pass "GitHub has the agent's change" || fail "change on GitHub"
git -C "$HOSTED" diff --stat "$STARTER" main | grep -q '1 file changed' && pass "only that note changed" || fail "untouched files"
[ "$AFTER" = "$(git -c safe.directory='*' -C "$MIRROR" rev-parse main)" ] && pass "the mirror moved to it" || fail "mirror after push"
browser job "$JOB" /tmp/owner.cookie > /tmp/status.out
STATE=$(json_field state < /tmp/status.out)
[ -n "$STATE" ] && ! printf '%s' "$STATE" | grep -qE '^(awaiting-approval|pushing|failed|manual-intervention|null)$' && pass "status shows the job past its push ($(json_field state < /tmp/status.out))" || { fail "status"; cat /tmp/status.out; }

echo "== recovery: a new device by the recovery code, once; the old phone is out"
device recover "$RECOVERY" "$FRESH" fresh | grep -q '"ok":true' && pass "the recovery code set up a replacement device" || fail "recovery"
device devices | grep -q '"active":\["fresh"\]' && pass "only the replacement device can publish now" || fail "devices after recovery"
device recover "$RECOVERY" /var/lib/cyberbaser/again.json again | grep -q '"code":"owner-key-refused"' && pass "the recovery code works once" || fail "recovery reuse"
# A second change, an owner Save. One publish runs at a time: it starts once the
# first job's deployment check (which the stand-in GitHub cannot answer) gives up.
JOB2=OA-OWNER-SAVE-2
for _ in $(seq 1 30); do
  device owner-save "$CONFIG" "$JOB2" Garden/Tulips.md 'in autumn' 'in October' > /tmp/save2.out
  grep -q '"code":"lock-busy"' /tmp/save2.out || break; sleep 5
done
grep -q '"state":"awaiting-approval"' /tmp/save2.out && pass "a second change, an owner Save, waits for a signature ($JOB2)" || { fail "second job"; cat /tmp/save2.out; }
COMMIT2=$(device job-commit "$CONFIG" "$JOB2" | json_field commit)
device intent "$CONFIG" "$COMMIT2" | sed -n 's/^{"ok":true,"intent":\(.*\)}$/{"intent":\1}/p' > /tmp/j2-intent.json
phone signIntent "$(cat /tmp/j2-intent.json)" | sed -n 's/^{"ok":true,"record":\(.*\)}$/\1/p' > /tmp/revoked-record.json
install -o cyberbaser -g cyberbaser-share -m 0640 /tmp/revoked-record.json /var/lib/cyberbaser/home/revoked-record.json
device attempt "$CONFIG" "$JOB2" /var/lib/cyberbaser/home/revoked-record.json | tee /tmp/a4.out | grep -q '"ok":false,"code":"owner-approval-' && pass "the revoked phone's signature for exactly that commit is refused ($(json_field code < /tmp/a4.out))" || { fail "revoked device"; cat /tmp/a4.out; }
[ "$(hosted_main)" = "$AFTER" ] && pass "nothing was pushed" || fail "revoked device pushed"
device sign-record "$FRESH" "$CONFIG" "$JOB2" | sed -n 's/^{"ok":true,"record":\(.*\)}$/\1/p' > /tmp/fresh-record.json
install -o cyberbaser -g cyberbaser-share -m 0640 /tmp/fresh-record.json /var/lib/cyberbaser/home/fresh-record.json
device attempt "$CONFIG" "$JOB2" /var/lib/cyberbaser/home/fresh-record.json | tee /tmp/a5.out | grep -q '"ok":true' && pass "the replacement device's approval publishes" || { fail "fresh device push"; cat /tmp/a5.out; }
[ "$(hosted_main)" = "$COMMIT2" ] && [ "$(git -C "$HOSTED" rev-parse main^)" = "$AFTER" ] && pass "exactly that commit, on top of the last one" || fail "fresh push commit"

echo "== the node account cannot read the GitHub token anywhere"
check "positive control: the token exists in the publisher's state" bash -c "grep -rqaE '$TOKEN_RE' /var/lib/cyberbaser-publisher/forge"
NODE=$(systemctl show -p MainPID --value cyberbaser-node.service)
as_node bash -c "grep -rlsaE '$TOKEN_RE' / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null" > /tmp/node-files.out
[ ! -s /tmp/node-files.out ] && pass "no readable file holds it (canary over the whole disk as the node)" || { fail "node can read the token in:"; cat /tmp/node-files.out; }
as_node bash -c "for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do grep -lsaE '$TOKEN_RE' \$f; done" > /tmp/node-proc.out
[ ! -s /tmp/node-proc.out ] && pass "no process environment or command line it can read holds it" || { fail "node reads token in proc"; cat /tmp/node-proc.out; }
grep -rlsaE "$TOKEN_RE" /proc/$NODE/root/tmp /proc/$NODE/root/var/tmp > /tmp/node-tmp.out 2>/dev/null
[ ! -s /tmp/node-tmp.out ] && pass "nor the node service's private temporary folders" || fail "node private tmp"
grep -sqaE "$TOKEN_RE" /proc/$NODE/environ && fail "node environment holds it" || pass "the node's own environment does not hold it"
[ "$(grep -rlsaE "$TOKEN_RE" "$CHECKOUT" "$MIRROR" | wc -l)" = 0 ] && pass "the notes copy and the mirror hold no credential" || fail "credential in copy/mirror"
git -c safe.directory='*' -C "$CHECKOUT" config --list | grep -qiE 'credential|@github|x-access-token' && fail "copy config names a credential" || pass "the copy's Git config names no credential"
git -c safe.directory='*' -C "$CHECKOUT" reflog | grep -qaE "$TOKEN_RE|x-access-token" && fail "copy reflog" || pass "the copy's reflog names no credential"
journalctl --no-pager -o cat | grep -qaE "$TOKEN_RE" && fail "the journal holds the token" || pass "the journal holds no token"

echo "== restart with GitHub down"
systemctl stop fake-github.service
SINCE=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart cyberbaser-publisher.service cyberbaser-node.service
check "the publisher starts offline" wait_journal cyberbaser-publisher.service 'owner-alpha publisher ready'
# The sign-in link prints before job recovery finishes (a pushed job waits on a
# deployment check this stand-in GitHub cannot answer); owner acts that could
# conflict are held back until recovery settles.
BOOT=""
for _ in $(seq 1 60); do
  BOOT=$(journalctl -u cyberbaser-node.service --since "$SINCE" --no-pager -o cat | sed -n 's/^Owner alpha bootstrap: //p' | tail -1)
  [ -n "$BOOT" ] && break; sleep 0.5
done
[ -n "$BOOT" ] && pass "the sign-in link printed at once (within 30 s)" || fail "no sign-in link within 30 s"
journalctl -u cyberbaser-node.service --since "$SINCE" --no-pager -o cat | grep -q 'GitHub: cannot reach it now' && pass "the node started and says it cannot reach GitHub" || { fail "offline start"; journalctl -u cyberbaser-node.service --since "$SINCE" --no-pager -o cat | tail -5; }
check "the reader site still answers" curl -fsS -o /dev/null -H "Host: 127.0.0.1:4318" http://127.0.0.1:4318/cyberbase/Garden/Roses
if [ -n "$BOOT" ]; then
  rm -f /tmp/owner.cookie
  browser sign-in "$BOOT" /tmp/owner.cookie >/dev/null
  browser page /owner/review /tmp/owner.cookie | tee /tmp/offline.out
  grep -q '"ok":true' /tmp/offline.out && pass "the owner signs in and is served with GitHub down" || fail "offline serve"
  grep -q '"unreachable":true' /tmp/offline.out && pass "Proposals shows the quiet Can't reach GitHub line" || fail "offline notice"
  browser post "/api/review/$QUEUE/apply" /tmp/owner.cookie | tee /tmp/held.out
  grep -q '"message":"Finishing an earlier publish. Try again in a moment."' /tmp/held.out && pass "a publish action says Finishing an earlier publish while recovery runs" || fail "recovery notice"
fi

systemd-analyze security cyberbaser-node.service 2>/dev/null | tail -1 | sed 's/^/node unit: /'
systemd-analyze security cyberbaser-publisher.service 2>/dev/null | tail -1 | sed 's/^/publisher unit: /'
echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
