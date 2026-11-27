#!/bin/bash
# Runs as root inside the disposable systemd container (see run.sh). Installs
# the program, checks the two-account isolation with real accounts, pushes one
# synthetic job to a local bare remote, then uninstalls, reinstalls and checks
# that the installer refuses a setup it did not make. Synthetic data only.
set -u
PROGRAM=/test/cyberbaser
SEED=/test/quartz-seed.tar.zst
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL $*"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
refused() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$name (was allowed)"; else pass "$name"; fi; }
as_node() { setpriv --reuid=cyberbaser --regid=cyberbaser-share --init-groups --reset-env -- "$@"; }
as_publisher() { setpriv --reuid=cyberbaser-publisher --regid=cyberbaser-share --init-groups --reset-env -- "$@"; }
as_stranger() { setpriv --reuid=stranger --regid=stranger --init-groups --reset-env -- "$@"; }
# Succeeds only if connect() to the socket is permitted (curl exit 7 = could not connect).
CONNECTS='curl -s -m 3 --unix-socket "$0" http://publisher/ >/dev/null 2>&1; [ $? -ne 7 ]'
wait_active() { for _ in $(seq 1 120); do [ "$(systemctl is-active "$1")" = active ] && return 0; sleep 0.5; done; return 1; }
wait_healthy() { for _ in $(seq 1 240); do curl -fsS -o /dev/null -H "Host: 127.0.0.1:4318" http://127.0.0.1:4318/cyberbase/ && return 0; sleep 0.5; done; return 1; }

until systemctl is-system-running --quiet 2>/dev/null || [ "$(systemctl is-system-running 2>/dev/null)" = degraded ]; do sleep 0.5; done
useradd --create-home stranger
# The node account runs two helper scripts; the mounted test folder is not readable to it.
mkdir -p /var/tmp/cb-test && install -m 0644 /test/scripts/save-job.mjs /test/scripts/site-debug.mjs /var/tmp/cb-test/

echo "== install (fresh)"
start=$(date +%s%N)
$PROGRAM install --quartz-seed "$SEED" --github-client-id Iv23liFAKEcyberbaser | tee /tmp/install.out
echo "install_ms=$(( ($(date +%s%N) - start) / 1000000 ))"
check "install wrote its record" test -f /etc/cyberbaser/install.json
check "node service active" wait_active cyberbaser-node.service
grep -q '^Open this to finish setup: http://127.0.0.1:4317/setup/start?token=' /tmp/install.out \
  && pass "install printed one setup link" || fail "install printed one setup link ($(tail -1 /tmp/install.out))"
/opt/cyberbaser/bin/cyberbaser status

echo "== accounts and modes"
check "account cyberbaser exists" id cyberbaser
check "account cyberbaser-publisher exists" id cyberbaser-publisher
check "node account is in the share group" bash -c 'id -nG cyberbaser | grep -qw cyberbaser-share'
check "publisher account is in the share group" bash -c 'id -nG cyberbaser-publisher | grep -qw cyberbaser-share'
check "stranger is not in the share group" bash -c '! id -nG stranger | grep -qw cyberbaser-share'
[ "$(stat -c '%U:%G %a' /var/lib/cyberbaser)" = "cyberbaser:cyberbaser-share 700" ] && pass "node state 0700" || fail "node state $(stat -c '%U:%G %a' /var/lib/cyberbaser)"
[ "$(stat -c '%U:%G %a' /var/lib/cyberbaser-publisher)" = "cyberbaser-publisher:cyberbaser-publisher 700" ] && pass "publisher state 0700" || fail "publisher state $(stat -c '%U:%G %a' /var/lib/cyberbaser-publisher)"
[ "$(stat -c '%U:%G %a' /var/lib/cyberbaser-shared/workspace)" = "cyberbaser:cyberbaser-share 770" ] && pass "job store 0770 in the share group" || fail "job store $(stat -c '%U:%G %a' /var/lib/cyberbaser-shared/workspace)"
refused "publisher mode refuses the node account" as_node /opt/cyberbaser/bin/cyberbaser publisher /x /tmp/x.sock /tmp/x.git
refused "node mode refuses the publisher account" as_publisher /opt/cyberbaser/bin/cyberbaser node /x
refused "node mode refuses root" /opt/cyberbaser/bin/cyberbaser node /x
refused "node mode refuses another user" as_stranger /opt/cyberbaser/bin/cyberbaser node /x

echo "== a synthetic vault, remote and config (what setup would leave)"
mkdir -p /srv && git init -q --bare --initial-branch=main /srv/remote.git
as_node bash -c 'umask 0007; set -e
  v=/var/lib/cyberbaser-shared/notes/notes; mkdir -p $v/docs; cd $v
  git init -q --initial-branch=main; git config user.name Synthetic; git config user.email synthetic@example.invalid
  printf "# Synthetic notes\n\nSee [[docs/page]].\n" > index.md; printf "# Page\n\nSynthetic old sentence.\n" > docs/page.md
  printf "allow:\n  - \"*.md\"\n  - \"docs/*.md\"\n" > publish.yml
  git add -A; git commit -qm base; git remote add origin https://github.com/smoke/notes.git'
git -c safe.directory='*' -C /srv/remote.git fetch -q /var/lib/cyberbaser-shared/notes/notes main:main
chown -R cyberbaser-publisher:cyberbaser-publisher /srv/remote.git && chmod -R a+rX /srv/remote.git
# Test-only: the forge is /srv/remote.git. Transport commands are redirected; nothing else changes.
cat > /usr/local/bin/git <<'SHIM'
#!/bin/bash
args=("$@"); i=0
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in --git-dir|-C|-c) i=$((i+2));; --no-pager|--no-replace-objects) i=$((i+1));; --*=*) i=$((i+1));; *) break;; esac
done
case "${args[$i]:-}" in ls-remote|push|fetch)
  exec /usr/bin/git "${args[@]:0:$i}" -c protocol.file.allow=always -c url./srv/remote.git.insteadOf=https://github.com/smoke/notes.git "${args[@]:$i}";;
esac
exec /usr/bin/git "$@"
SHIM
chmod 0755 /usr/local/bin/git
mkdir -p /etc/systemd/system/cyberbaser-publisher.service.d
printf '[Service]\nReadWritePaths=/srv/remote.git\n' > /etc/systemd/system/cyberbaser-publisher.service.d/test-remote.conf
systemctl daemon-reload
git config --global --add safe.directory '*'
as_node bash -c 'umask 0077; cat > /var/lib/cyberbaser/config/owner-alpha.json' < /test/scripts/node-config.json
check "config is the node's own 0600 file" bash -c '[ "$(stat -c "%U %a" /var/lib/cyberbaser/config/owner-alpha.json)" = "cyberbaser 600" ]'
systemctl restart cyberbaser-node.service
check "publisher started once the config appeared" wait_active cyberbaser-publisher.service || journalctl -u cyberbaser-publisher.service --no-pager | tail -20
if wait_healthy; then pass "node healthy with the config"; else
  fail "node healthy with the config"
  journalctl -u cyberbaser-node.service --no-pager -o cat | grep -v '^cyberbaser-node.service: ' | tail -5
  # Same site build as the node, printing the failure details the node keeps private.
  systemd-run --quiet --wait --pipe --collect --uid=cyberbaser --gid=cyberbaser-share \
    -p UMask=0007 -p BindPaths=/var/lib/cyberbaser-shared/workspace:/opt/cyberbaser/.workspace -E CYBERBASER_SHARED_STORE=group \
    -E HOME=/var/lib/cyberbaser/home -E PATH=/opt/cyberbaser/libexec:/usr/local/bin:/usr/bin:/bin -E BUN_BE_BUN=1 \
    /opt/cyberbaser/bin/cyberbaser /var/tmp/cb-test/site-debug.mjs 2>&1 | tail -30
fi
[ "$(stat -c '%U:%G %a' /var/lib/cyberbaser-publisher/owner-alpha.json)" = "cyberbaser-publisher:cyberbaser-share 600" ] \
  && pass "publisher has its own 0600 copy of the config" || fail "publisher config copy $(stat -c '%U:%G %a' /var/lib/cyberbaser-publisher/owner-alpha.json 2>&1)"
[ "$(stat -c '%U:%G %a' /run/cyberbaser-publisher)" = "cyberbaser-publisher:cyberbaser-share 710" ] && pass "socket directory 0710" || fail "socket directory $(stat -c '%U:%G %a' /run/cyberbaser-publisher)"
[ "$(stat -c '%U:%G %a' /run/cyberbaser-publisher/publisher.sock)" = "cyberbaser-publisher:cyberbaser-share 660" ] && pass "publisher socket 0660" || fail "publisher socket $(stat -c '%U:%G %a' /run/cyberbaser-publisher/publisher.sock 2>&1)"
# Stand-ins for the forge key and its state, written by the publisher account itself.
as_publisher bash -c 'umask 0077; mkdir -p /var/lib/cyberbaser-publisher/forge; echo synthetic-refresh-token > /var/lib/cyberbaser-publisher/forge/github-app.json'

echo "== isolation with real accounts"
PUB=$(systemctl show -p MainPID --value cyberbaser-publisher.service)
NODE=$(systemctl show -p MainPID --value cyberbaser-node.service)
refused "node cannot list publisher state" as_node ls /var/lib/cyberbaser-publisher
refused "node cannot read the forge key" as_node cat /var/lib/cyberbaser-publisher/forge/github-app.json
refused "node cannot read the publisher config copy" as_node cat /var/lib/cyberbaser-publisher/owner-alpha.json
refused "node cannot read the publisher environment" as_node cat /proc/$PUB/environ
refused "node cannot see the publisher memory" as_node cat /proc/$PUB/maps
refused "node cannot write into the socket directory" as_node touch /run/cyberbaser-publisher/x
refused "node cannot list the socket directory" as_node ls /run/cyberbaser-publisher
check "node can reach the publisher socket" as_node bash -c "$CONNECTS" /run/cyberbaser-publisher/publisher.sock
refused "stranger cannot reach the publisher socket" as_stranger bash -c "$CONNECTS" /run/cyberbaser-publisher/publisher.sock
refused "stranger cannot read the job store" as_stranger ls /var/lib/cyberbaser-shared
refused "stranger cannot read node state" as_stranger ls /var/lib/cyberbaser
refused "publisher cannot read node state (Iroh keys, config)" as_publisher ls /var/lib/cyberbaser
refused "publisher cannot read the node config" as_publisher cat /var/lib/cyberbaser/config/owner-alpha.json
# Inside the running node service's own view of the disk.
# Inside the running node service's own view of the disk (/proc/<pid>/root), checked as root
# so that only the service's mounts, not file permissions, can stop it.
VIEW=/proc/$NODE/root
check "inside the node service, the job store is mounted at the app's path" test -d $VIEW/opt/cyberbaser/.workspace/owner-alpha/store/jobs
check "outside, the publisher state has files" test -n "$(ls -A /var/lib/cyberbaser-publisher)"
check "inside the node service, the publisher state is an empty locked stub" bash -c "[ -z \"\$(ls -A $VIEW/var/lib/cyberbaser-publisher 2>/dev/null)\" ] && [ \"\$(stat -c %a $VIEW/var/lib/cyberbaser-publisher)\" = 0 ]"
refused "inside the node service, the program files are read-only even for root" touch $VIEW/opt/cyberbaser/x
refused "inside the node service, the publisher push repository is absent" test -e $VIEW/var/lib/cyberbaser-publisher/push.git
systemd-analyze security cyberbaser-node.service 2>/dev/null | tail -1 | sed 's/^/node unit: /'
systemd-analyze security cyberbaser-publisher.service 2>/dev/null | tail -1 | sed 's/^/publisher unit: /'

echo "== one job: the node commits, the publisher pushes"
systemctl stop cyberbaser-node.service
before=$(git -C /srv/remote.git rev-parse main)
systemd-run --quiet --wait --pipe --collect --uid=cyberbaser --gid=cyberbaser-share \
  -p UMask=0007 -p BindPaths=/var/lib/cyberbaser-shared/workspace:/opt/cyberbaser/.workspace -p RuntimeMaxSec=300 \
  -E CYBERBASER_SHARED_STORE=group -E PATH=/opt/cyberbaser/libexec:/usr/local/bin:/usr/bin:/bin -E HOME=/var/lib/cyberbaser/home \
  -E BUN_BE_BUN=1 \
  /opt/cyberbaser/bin/cyberbaser /var/tmp/cb-test/save-job.mjs /var/lib/cyberbaser/config/owner-alpha.json OA-INSTALL-1 | tee /tmp/job.out
after=$(git -C /srv/remote.git rev-parse main)
[ "$before" != "$after" ] && pass "the remote advanced ($before -> $after)" || fail "the remote did not advance"
[ "$after" = "$(git -c safe.directory='*' -C /var/lib/cyberbaser-shared/notes/notes rev-parse HEAD)" ] && pass "the pushed commit is the node's commit" || fail "pushed commit differs from the node's commit"
git -C /srv/remote.git show main:docs/page.md | grep -q 'Synthetic new sentence.' && pass "the remote has the edit" || fail "the remote lacks the edit"
receipt=/var/lib/cyberbaser-shared/workspace/owner-alpha/store/jobs/OA-INSTALL-1/effects/pushed.json
[ -n "$receipt" ] && [ "$(stat -c '%U:%G %a' "$receipt")" = "cyberbaser-publisher:cyberbaser-share 640" ] \
  && pass "push receipt written by the publisher, group-readable only" || fail "push receipt ${receipt:-missing} $(stat -c '%U:%G %a' "$receipt" 2>/dev/null)"
check "node can read the publisher's receipt" as_node cat "$receipt"
refused "stranger cannot read the receipt" as_stranger cat "$receipt"
systemctl start cyberbaser-node.service
check "node healthy again after the push" wait_healthy

echo "== uninstall keeps data, reinstall is idempotent"
$PROGRAM uninstall
check "program files removed" test ! -e /opt/cyberbaser
check "units removed" test ! -e /etc/systemd/system/cyberbaser-node.service
check "data kept" test -f /var/lib/cyberbaser/config/owner-alpha.json
check "accounts kept" id cyberbaser-publisher
$PROGRAM install --quartz-seed "$SEED" | tee /tmp/reinstall.out
check "reinstall over kept data" wait_active cyberbaser-node.service
grep -q '^Cyberbaser is running: http://127.0.0.1:4317/' /tmp/reinstall.out && pass "reinstall reports the running node" || fail "reinstall output: $(tail -1 /tmp/reinstall.out)"
$PROGRAM install > /tmp/again.out && pass "install again (update) succeeds" || fail "install again"
check "renderer bundle kept across an update" test -f /opt/cyberbaser/vendor/quartz/package-lock.json
check "node healthy after update" wait_healthy
[ "$(id -u cyberbaser)" = "$(stat -c %u /var/lib/cyberbaser)" ] && pass "same accounts reused" || fail "accounts changed"

echo "== refuses a setup it did not make"
$PROGRAM uninstall --purge
check "purge removed accounts" bash -c '! id cyberbaser'
check "purge removed data" test ! -e /var/lib/cyberbaser-shared
mkdir -p /opt/cyberbaser/bin && touch /opt/cyberbaser/bin/something-else
refused "install refuses over an unknown /opt/cyberbaser" $PROGRAM install
check "the unknown setup was left untouched" test -f /opt/cyberbaser/bin/something-else
rm -rf /opt/cyberbaser
useradd --system cyberbaser-publisher
refused "install refuses when an unknown cyberbaser-publisher account exists" $PROGRAM install
userdel cyberbaser-publisher

echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
