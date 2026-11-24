#!/bin/bash
# Runs as root inside the disposable systemd container (see setup-e2e-run.sh),
# with no network but loopback. The whole first run on an installed machine:
# install, the printed setup link, sign in to a stand-in GitHub, pick a private
# repository, the publisher mirrors it and the node copies it, publish a
# starter publish.yml through the publisher, finish, land in the node signed
# in, one synthetic agent proposal over the local signed socket, approve and
# apply, the publisher pushes. Then the isolation checks and a restart with
# GitHub down. Synthetic data only.
set -u
PROGRAM=/test/cyberbaser
SEED=/test/quartz-seed.tar.zst
FAKE_PORT=48080
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
CHECKOUT=/var/lib/cyberbaser-shared/notes/notes
MIRROR=/var/lib/cyberbaser-shared/mirror/notes.git
HOSTED=/srv/gh/cybersader/cyberbase.git

until systemctl is-system-running --quiet 2>/dev/null || [ "$(systemctl is-system-running 2>/dev/null)" = degraded ]; do sleep 0.5; done
mkdir -p /var/tmp/cb-test && install -m 0644 /test/scripts/owner-browser.mjs /test/scripts/agent-lane.mjs /test/scripts/signing-device.mjs /var/tmp/cb-test/
device() { as_node env BUN_BE_BUN=1 /opt/cyberbaser/bin/cyberbaser /var/tmp/cb-test/signing-device.mjs "$@"; }
PHONE=/var/lib/cyberbaser/phone.json
# As the node, with the job store where the node service sees it (as save-job in install-test.sh).
device_store() {
  systemd-run --quiet --wait --pipe --collect --uid=cyberbaser --gid=cyberbaser-share \
    -p UMask=0007 -p BindPaths=/var/lib/cyberbaser-shared/workspace:/opt/cyberbaser/.workspace -p RuntimeMaxSec=120 \
    -E CYBERBASER_SHARED_STORE=group -E PATH=/opt/cyberbaser/libexec:/usr/local/bin:/usr/bin:/bin -E HOME=/var/lib/cyberbaser/home \
    -E BUN_BE_BUN=1 /opt/cyberbaser/bin/cyberbaser /var/tmp/cb-test/signing-device.mjs "$@"
}
git config --global user.name Synthetic; git config --global user.email synthetic@example.invalid
git config --global init.defaultBranch main

echo "== a stand-in GitHub on loopback with one private repository"
mkdir -p /srv/work/Garden /srv/work/Journal /srv/gh/cybersader
printf '# Roses\n\nPrune the roses in March.\n' > /srv/work/Garden/Roses.md
printf '# Tulips\n\nPlant tulips in autumn.\n' > /srv/work/Garden/Tulips.md
printf '# Private\n\nNot for the website.\n' > /srv/work/Journal/Private.md
printf '# Home\n\nSee [[Garden/Roses]].\n' > /srv/work/Home.md
# The owner's trust policy (an existing vault convention): the owner is trusted.
mkdir -p /srv/work/.cyberbaser && printf 'trusted: [cybersader]\nagents: []\n' > /srv/work/.cyberbaser/trust.yml
git -C /srv/work init -q && git -C /srv/work add -A && git -C /srv/work commit -qm 'synthetic notes'
git init -q --bare "$HOSTED" && git -C /srv/work push -q "$HOSTED" main
BASE=$(git -C "$HOSTED" rev-parse main)
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

# Test-only: the handed-off node prints a fingerprint of the session it adopted.
mkdir -p /etc/systemd/system/cyberbaser-node.service.d
printf '[Service]\nEnvironment=CYBERBASER_TEST_SESSION_MARK=1\n' > /etc/systemd/system/cyberbaser-node.service.d/test.conf

echo "== install"
$PROGRAM install --quartz-seed "$SEED" --github-client-id "$CLIENT_ID" --github-origin "http://127.0.0.1:$FAKE_PORT" --iroh-relay none | tee /tmp/install.out
LINK=$(sed -n 's/^Open this to finish setup: //p' /tmp/install.out)
[ -n "$LINK" ] && pass "install printed one setup link" || fail "install printed one setup link"
check "publisher service runs before any config" wait_active cyberbaser-publisher.service
check "the publisher started in setup mode" wait_journal cyberbaser-publisher.service 'ready for setup'
check "no node config yet" test ! -e /var/lib/cyberbaser/config/owner-alpha.json
[ "$(stat -c '%U:%G %a' /var/lib/cyberbaser-shared/mirror)" = "cyberbaser-publisher:cyberbaser-share 750" ] && pass "mirror folder: publisher-owned, group read-only" || fail "mirror folder $(stat -c '%U:%G %a' /var/lib/cyberbaser-shared/mirror)"

echo "== signed publish: the first device, by the code the installer printed"
ENROLL=$(sed -n 's/^  Code: \([0-9A-Z-]*\).*/\1/p' /tmp/install.out | head -1)
RECOVERY=$(sed -n '/If you ever lose every device/{n;s/^  //p}' /tmp/install.out | head -1)
[ -n "$ENROLL" ] && [ -n "$RECOVERY" ] && pass "install printed a first-device code and a recovery code" || fail "install printed codes"
journalctl --no-pager -o cat | grep -qF "$RECOVERY" && fail "the journal holds the recovery code" || pass "the recovery code is nowhere in the journal"
refused "the node cannot read the publisher's owner keys" as_node ls /var/lib/cyberbaser-publisher/owners
curl -fs http://127.0.0.1:4319/enroll | grep -qF "$ENROLL" && pass "the publisher's own page shows the code on this computer" || fail "enroll page"
refused "that page refuses the node account" as_node curl -fs -o /dev/null http://127.0.0.1:4319/enroll
curl -fs -H 'Origin: http://127.0.0.1:4317' http://127.0.0.1:4319/enroll >/dev/null && fail "a script from the web app read the code" || pass "a script from the web app cannot read the code"
device forged-enroll AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH | grep -q '"code":"owner-enrollment-refused"' && pass "a node-made code enrolls nothing" || fail "forged enrollment"
device enroll "$ENROLL" "$PHONE" phone | tee /tmp/enroll.out | grep -q '"ok":true' && pass "the stand-in device enrolled with the printed code" || { fail "enroll"; cat /tmp/enroll.out; }
device forged-enroll "$ENROLL" | grep -q '"code":"owner-enrollment-closed"' && pass "the code works once" || fail "code reuse"

echo "== setup in the owner's browser"
browser setup-signed "$LINK" /tmp/owner.cookie | tee /tmp/setup.out
grep -q '"ok":true' /tmp/setup.out && pass "setup ran to the notes step" || fail "setup to notes"
grep -q '"multiSelect":true' /tmp/setup.out && pass "Your notes shows an unchecked multi-select and a Show the file disclosure" || fail "multi-select markup"
grep -q '"unsignedStarterRefused":true' /tmp/setup.out && pass "the node cannot publish the starter publish.yml without the owner's signature" || fail "unsigned starter"
[ "$(git -C "$HOSTED" rev-parse main)" = "$BASE" ] && pass "nothing reached GitHub" || fail "unsigned starter pushed"
device starter-forged Garden | grep -q '"code":"owner-approval-invalid"' && pass "a starter signed with the node's own key is refused" || fail "forged starter"
device starter "$PHONE" Garden | tee /tmp/starter.out | grep -q '"receiptVerified":true' && pass "the device signed the starter and verified the publisher's receipt" || { fail "signed starter"; cat /tmp/starter.out; }
browser setup-finish /tmp/owner.cookie | grep -q '"ok":true' && pass "setup ran start to Done" || fail "setup ran start to Done"
check "the notes copy exists" test -d "$CHECKOUT/.git"
[ "$(stat -c %U "$CHECKOUT")" = cyberbaser ] && pass "the notes copy belongs to the node" || fail "notes copy owner"
[ "$(git -c safe.directory='*' -C "$CHECKOUT" remote get-url origin)" = "https://github.com/cybersader/cyberbase.git" ] && pass "the copy's remote is the plain HTTPS URL" || fail "copy remote"
[ "$(git -c safe.directory='*' -C "$MIRROR" config --list --local | grep -cE 'remote\.|url|credential|helper')" = 0 ] && pass "the mirror config names no remote, URL or helper" || fail "mirror config"
[ "$(stat -c %U "$MIRROR")" = cyberbaser-publisher ] && pass "the mirror belongs to the publisher" || fail "mirror owner"
refused "the node cannot write into the mirror" as_node touch "$MIRROR/objects/x"
STARTER=$(git -C "$HOSTED" rev-parse main)
[ "$STARTER" != "$BASE" ] && [ "$(git -C "$HOSTED" rev-parse main^)" = "$BASE" ] && pass "one commit was pushed to GitHub" || fail "starter push"
[ "$(git -C "$HOSTED" diff-tree --no-commit-id --name-status -r main)" = "$(printf 'A\tpublish.yml')" ] && pass "it adds exactly publish.yml" || fail "starter diff"
git -C "$HOSTED" show main:publish.yml | grep -qx '  - "Garden/\*\*"' && ! git -C "$HOSTED" show main:publish.yml | grep -q Journal && pass "publish.yml lists only the folder picked" || fail "starter content"
[ "$(git -c safe.directory='*' -C "$CHECKOUT" rev-parse HEAD)" = "$STARTER" ] && [ "$(git -c safe.directory='*' -C "$MIRROR" rev-parse main)" = "$STARTER" ] && pass "copy and mirror are at that commit" \
  || fail "copy/mirror head: starter $STARTER copy $(git -c safe.directory='*' -C "$CHECKOUT" rev-parse HEAD 2>&1) mirror $(git -c safe.directory='*' -C "$MIRROR" rev-parse main 2>&1)"

echo "== hand-off at Done"
browser landed /tmp/owner.cookie | tee /tmp/landed.out
grep -q '"ok":true' /tmp/landed.out && pass "the owner lands in the node signed in, with the setup cookie" \
  || { fail "landed signed in"; journalctl -u cyberbaser-node.service --no-pager -o cat | grep -E 'session from setup|running|could not' ; }
cat > /var/tmp/cb-test/probe.mjs <<'PROBE'
import { forgeRequest } from '/src/apps/owner-alpha/src/publisher/forge-control.js';
try { console.log(JSON.stringify(await forgeRequest({ socketPath: '/run/cyberbaser-publisher/publisher.sock', op: 'fetch', timeoutMs: 60000 }))); }
catch (error) { console.log('fetch refused', error.code); }
PROBE
chmod 0644 /var/tmp/cb-test/probe.mjs
echo "probe as node: $(as_node env BUN_BE_BUN=1 /opt/cyberbaser/bin/cyberbaser /var/tmp/cb-test/probe.mjs 2>&1 | tail -1)"
check "the node config was written, owner-only" bash -c '[ "$(stat -c "%U %a" /var/lib/cyberbaser/config/owner-alpha.json)" = "cyberbaser 600" ]'
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$LINK")
[ "$STATUS" != 303 ] && [ "$STATUS" != 200 ] && pass "the setup link no longer works ($STATUS)" || fail "setup link still answers ($STATUS)"
check "the publisher switched to normal mode" wait_journal cyberbaser-publisher.service 'owner-alpha publisher ready'
[ "$(git -c safe.directory='*' -C "$CHECKOUT" config user.name)" = cybersader ] && pass "commits in the copy carry the owner's name" || fail "copy identity"

echo "== one agent proposal over the local signed socket"
as_node env BUN_BE_BUN=1 /opt/cyberbaser/bin/cyberbaser /var/tmp/cb-test/agent-lane.mjs /var/lib/cyberbaser/config/owner-alpha.json \
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
grep -q '"state":"awaiting-approval"' /tmp/approve.out && pass "the applied change waits for the owner's device" || fail "job waits for approval"
[ "$(git -C "$HOSTED" rev-parse main)" = "$STARTER" ] && pass "unsigned, nothing was pushed" || fail "unsigned job pushed"
device_store sign-job "$PHONE" /var/lib/cyberbaser/config/owner-alpha.json "$JOB" | grep -q '"ok":true' && pass "the device signed exactly that commit" || fail "sign job"
systemctl restart cyberbaser-node.service
for _ in $(seq 1 240); do [ "$(git -C "$HOSTED" rev-parse main)" != "$STARTER" ] && break; sleep 0.5; done
AFTER=$(git -C "$HOSTED" rev-parse main)
[ "$AFTER" != "$STARTER" ] && [ "$(git -C "$HOSTED" rev-parse main^)" = "$STARTER" ] && pass "approved and applied: the publisher pushed one commit" || { fail "push after approve"; journalctl -u cyberbaser-node.service --no-pager -o cat | tail -5; }
git -C "$HOSTED" show main:Garden/Roses.md | grep -q 'in late winter' && pass "GitHub has the agent's change" || fail "change on GitHub"
[ "$AFTER" = "$(git -c safe.directory='*' -C "$CHECKOUT" rev-parse HEAD)" ] && pass "the pushed commit is the node's commit" || fail "pushed commit differs"
[ "$AFTER" = "$(git -c safe.directory='*' -C "$MIRROR" rev-parse main)" ] && pass "the mirror moved to it" || fail "mirror after push"
git -C "$HOSTED" diff --stat "$STARTER" main | grep -q '1 file changed' && pass "only that note changed" || fail "untouched files"

echo "== devices: add, revoke, recovery code once"
LAPTOP=/var/lib/cyberbaser/laptop.json; FRESH=/var/lib/cyberbaser/fresh.json
device add "$PHONE" "$LAPTOP" laptop | grep -q '"ok":true' && pass "the phone allowed a second device" || fail "add device"
device revoke "$LAPTOP" phone | grep -q '"ok":true' && pass "the second device removed the phone" || fail "revoke"
device revoke "$PHONE" laptop | grep -q '"code":"owner-key-refused"' && pass "the removed phone can change nothing" || fail "revoked key still works"
device recover "$RECOVERY" "$FRESH" fresh | grep -q '"ok":true' && pass "the recovery code set up a replacement device" || fail "recovery"
device devices | grep -q '"active":\["fresh"\]' && pass "only the replacement device can publish now" || fail "devices after recovery"
device recover "$RECOVERY" /var/lib/cyberbaser/again.json again | grep -q '"code":"owner-key-refused"' && pass "the recovery code works once" || fail "recovery reuse"

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
for _ in $(seq 1 240); do journalctl -u cyberbaser-node.service --since "$SINCE" --no-pager -o cat | grep -q 'GitHub: cannot reach it now' && break; sleep 0.5; done
journalctl -u cyberbaser-node.service --since "$SINCE" --no-pager -o cat | grep -q 'GitHub: cannot reach it now' && pass "the node started and says it cannot reach GitHub" || { fail "offline start"; journalctl -u cyberbaser-node.service --since "$SINCE" --no-pager -o cat | tail -5; }
check "the node answers the owner address" bash -c '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4317/owner/review)" = 403 ]'
check "the reader site still answers" curl -fsS -o /dev/null -H "Host: 127.0.0.1:4318" http://127.0.0.1:4318/cyberbase/Garden/Roses
# The sign-in link prints after job recovery; the applied job above waits on a
# deployment check this stand-in GitHub cannot answer, so it may take long.
BOOT=""
for _ in $(seq 1 240); do
  BOOT=$(journalctl -u cyberbaser-node.service --since "$SINCE" --no-pager -o cat | sed -n 's/^Owner alpha bootstrap: //p' | tail -1)
  [ -n "$BOOT" ] && break; sleep 0.5
done
if [ -n "$BOOT" ]; then
  rm -f /tmp/owner.cookie
  browser sign-in "$BOOT" /tmp/owner.cookie >/dev/null
  browser page /owner/review /tmp/owner.cookie | tee /tmp/offline.out
  grep -q '"ok":true' /tmp/offline.out && pass "the owner signs in and is served with GitHub down" || fail "offline serve"
  grep -q '"unreachable":true' /tmp/offline.out && pass "Proposals shows the quiet Can't reach GitHub line" || fail "offline notice"
else
  echo "INFO offline: no sign-in link within 120 s; it prints once the resumed job's deployment check gives up"
fi

systemd-analyze security cyberbaser-node.service 2>/dev/null | tail -1 | sed 's/^/node unit: /'
systemd-analyze security cyberbaser-publisher.service 2>/dev/null | tail -1 | sed 's/^/publisher unit: /'
echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
