#!/bin/bash
# Test an existing image in a disposable, offline Podman pod. No real vault,
# install, source credentials, host listener, or container engine socket.
set -Eeuo pipefail
umask 0077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
[[ $# -le 2 ]] || { printf 'Usage: smoke.sh [image] [reach]\n' >&2; exit 2; }
image=$(podman image inspect --format '{{.Id}}' "${1:-localhost/cyberbaser-one-app:lab}")
reach=${2-relay-only}
platform=$(podman image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
printf 'Image %s %s, reach %s\n' "$image" "$platform" "$reach"
[[ $(podman info --format '{{.Host.Security.Rootless}} {{.Host.Security.SELinuxEnabled}}') == 'true true' ]] || {
  printf 'FAIL rootless Podman with SELinux confinement required.\n' >&2; exit 1;
}
work=$(mktemp -d "${TMPDIR:-/tmp}/cb-oneapp-lab.XXXXXXXX")
pod=${work##*/}
volumes=()
pod_created=0
stage=staging
cleanup() {
  local code=$? failed=0 volume
  trap - EXIT
  if podman container exists "$pod-node-config-reconcile"; then
    podman rm -f "$pod-node-config-reconcile" >/dev/null 2>&1 || failed=1
  fi
  if ((pod_created)); then podman pod rm -f "$pod" >/dev/null 2>&1 || failed=1; fi
  for volume in "${volumes[@]}"; do podman volume rm "$volume" >/dev/null 2>&1 || failed=1; done
  rm -rf -- "$work" || failed=1
  if ((failed)); then printf 'FAIL cleanup; inspect only resources named %s\n' "$pod" >&2; exit 1; fi
  printf 'PASS removed lab pod, containers, named volumes and scratch\n'
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'printf "FAIL %s (line %s)\n" "$stage" "$LINENO" >&2' ERR
pass() { printf 'PASS %s\n' "$*"; }
wait_for() { local i; for ((i=0;i<80;i++)); do "$@" >/dev/null 2>&1 && return 0; sleep .25; done; return 1; }

node="$pod-node" publisher="$pod-publisher" fixture="$pod-fixture"
state=/var/lib/cyberbaser pubstate=/var/lib/cyberbaser-publisher shared=/var/lib/cyberbaser-shared
node_config_dir=$state/config pub_config_dir=/var/lib/cyberbaser-publisher-config
node_config=$node_config_dir/owner-alpha.json pub_config=$pub_config_dir/owner-alpha.json
sock=/run/cyberbaser-publisher jobs=/opt/cyberbaser/.workspace notes=$shared/notes
mirror=$shared/mirror checkout=$notes/notes
record=/etc/cyberbaser/install.json program=/opt/cyberbaser/bin/cyberbaser
reg=$pubstate/forge/github-app-registration.json token=$pubstate/forge/github-app.json
origin=http://127.0.0.1:4317 reader=http://127.0.0.1:4318/lab-notes fake=http://127.0.0.1:48080 enroll=http://127.0.0.1:4319/enroll
repository=lab-owner/lab-notes hosted=/tmp/forge/lab-owner/lab-notes.git
site=$jobs/owner-alpha/site/owner-alpha-site-manifest.json
canaries='gh[ur]_CANARY|cbsCANARY|whsCANARY|FAKEPEMCANARY'
mkdir -m 0755 "$work/fixture"
mkdir -m 0700 "$work/supervisor"
install -m 0644 "$REPO/apps/owner-alpha/test/fake-github.js" "$REPO/packaging/test/container/owner-browser.mjs" "$work/fixture/"
bun build "$HERE/test/publication.mjs" --target=bun --outfile="$work/fixture/publication.mjs" >/dev/null
chmod 0644 "$work/fixture/publication.mjs"
jq --arg fake "$fake" --arg reach "$reach" '. + {github:{origin:$fake},irohRelay:"none",reach:$reach}' "$HERE/install.json" > "$work/install.json"
chmod 0644 "$work/install.json"
# Test-only Git transport shim from the native private fixture, applied only
# to the publisher and only to its single synthetic repository's origin.
/usr/bin/cat > "$work/git" <<'SHIM'
#!/bin/bash
set -euo pipefail
args=("$@"); i=0
while ((i < ${#args[@]})); do
  case "${args[i]}" in -C|-c|--git-dir) i=$((i+2));; --no-pager|--no-replace-objects|--*=*) i=$((i+1));; *) break;; esac
done
case "${args[i]:-}" in ls-remote|fetch|push)
  exec /usr/bin/git "${args[@]:0:i}" -c protocol.http.allow=always \
    -c url.http://127.0.0.1:48080/git/lab-owner/lab-notes.git.insteadOf=https://github.com/lab-owner/lab-notes.git "${args[@]:i}" ;;
esac
exec /usr/bin/git "$@"
SHIM
chmod 0755 "$work/git"

dep() { podman exec "$@"; }
base=(--pull never --init --read-only --read-only-tmpfs=false --cap-drop ALL --security-opt no-new-privileges
  --memory 1g --memory-swap 1g --cpus 1 --pids-limit 256
  --http-proxy=false --log-driver k8s-file --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=256m)
mount_record=(-v "$work/install.json:$record:ro,Z")
vol() { printf '%s-%s:%s:%s,nocopy' "$pod" "$1" "$2" "${3:-rw}"; }
stage='create isolated pod and volumes'
podman pod create --name "$pod" --network none --share net >/dev/null
pod_created=1
for name in node-state node-config publisher-state publisher-config workspace notes mirror publisher-sockets; do
  podman volume create "$pod-$name" >/dev/null
  volumes+=("$pod-$name")
done
init_volumes() {
  podman run --rm --pod "$pod" "${base[@]}" --user 0:0 --cap-add CHOWN,DAC_OVERRIDE,FOWNER \
    "${mount_record[@]}" -v "$(vol node-state "$state")" -v "$(vol publisher-state "$pubstate")" \
    -v "$(vol node-config "$node_config_dir")" -v "$(vol publisher-config "$pub_config_dir")" \
    -v "$(vol workspace "$shared/workspace")" -v "$(vol notes "$notes")" -v "$(vol mirror "$mirror")" \
    -v "$(vol publisher-sockets "$sock")" "$image" init-volumes
}
stage='initialize named volumes'
init_volumes
init_volumes >/dev/null
pass 'volume initialization is repeatable before either service starts'

stage='start fake GitHub with one private note'
podman run -d --pod "$pod" --name "$fixture" "${base[@]}" --user 65531:65530 --workdir /tmp \
  -e HOME=/tmp -e FAKE_GITHUB_PORT=48080 -v "$work/fixture:/fixture:ro,Z" \
  -v "$(vol notes "$notes" ro)" -v "$(vol publisher-sockets "$sock" ro)" --entrypoint /usr/bin/bash "$image" -euc '
  git init -q -b main /tmp/src
  mkdir -p /tmp/src/{Garden,.cyberbaser} /tmp/forge/lab-owner
  printf "allow:\n  - Garden\n" > /tmp/src/publish.yml
  printf "site:\n  baseUrl: lab-owner.github.io/lab-notes\n" > /tmp/src/.cyberbaser/site.yml
  printf "# Lab note\n\nThis is a synthetic public-to-the-fixture note.\n" > /tmp/src/Garden/Note.md
  git -C /tmp/src add .
  git -C /tmp/src -c user.name=Synthetic -c user.email=synthetic@example.invalid commit -qm fixture
  git clone --quiet --bare /tmp/src "$1"
  git -C "$1" remote remove origin
  exec bun /fixture/fake-github.js /tmp/forge
' bash "$hosted" >/dev/null
curl_flags=(curl -sS --noproxy '*' --max-time 3)
wait_for dep "$fixture" "${curl_flags[@]}" -f "$fake/_control/report"
dep "$fixture" "${curl_flags[@]}" -f -H 'Content-Type: application/json' \
  -d '{"installations":"exact","repository":"lab-owner/lab-notes","anonymousRead":false,"requireInstall":true}' "$fake/_control/scenario" >/dev/null
[[ $(dep "$fixture" "${curl_flags[@]}" -o /dev/null -w '%{http_code}' "$fake/git/$repository.git/info/refs?service=git-upload-pack") == 401 ]]
refs=$(dep "$fixture" git -C "$hosted" show-ref)
commit=$(dep "$fixture" git -C "$hosted" rev-parse HEAD)

host_reconcile() {
  (($#)) || set -- podman restart -t 10 "$publisher"
  bash "$HERE/reconcile-publisher-config.sh" "$work/supervisor" "$image" "$pod-node-config" "$pod-publisher-config" -- "$@" >/dev/null
}
create_publisher() {
  podman run -d --pod "$pod" --name "$publisher" "${base[@]}" --user 65533:65530 -e HOME="$pubstate" \
    "${mount_record[@]}" -v "$work/git:/usr/local/bin/git:ro,Z" -v "$(vol publisher-state "$pubstate")" \
    -v "$(vol publisher-config "$pub_config_dir" ro)" -v "$(vol workspace "$jobs")" -v "$(vol notes "$notes" ro)" \
    -v "$(vol mirror "$mirror")" -v "$(vol publisher-sockets "$sock")" "$image" service-publisher >/dev/null
}
create_node() {
  podman run -d --pod "$pod" --name "$node" "${base[@]}" --user 65532:65530 -e HOME="$state/home" -e XDG_CACHE_HOME="$state/cache" \
    "${mount_record[@]}" --mount type=tmpfs,destination=/run/cyberbaser,tmpfs-mode=0700,tmpfs-size=1048576,notmpcopyup,U=true \
    -v "$(vol node-state "$state")" -v "$(vol node-config "$node_config_dir")" -v "$(vol workspace "$jobs")" \
    -v "$(vol notes "$notes")" -v "$(vol mirror "$mirror" ro)" -v "$(vol publisher-sockets "$sock" ro)" "$image" service-node >/dev/null
}
ready_publisher() { dep "$publisher" test -S "$sock/publisher.sock.forge" && dep "$fixture" "${curl_flags[@]}" -f -o /dev/null "$enroll"; }
normal_publisher() {
  dep "$publisher" test -S "$sock/publisher.sock" && dep "$publisher" test -S "$sock/publisher.sock.forge" &&
    [[ $(dep "$fixture" "${curl_flags[@]}" -o /dev/null -w '%{http_code}' "$enroll") == 410 ]] &&
    podman logs "$publisher" 2>&1 | /usr/bin/grep -Fx 'owner-alpha publisher ready' >/dev/null
}
wait_for_normal_publisher() {
  if ! wait_for normal_publisher; then
    podman logs "$publisher" 2>&1 | /usr/bin/grep -E '^cyberbaser publisher failed(: [a-z0-9-]+)?$' >&2 || :
    return 1
  fi
}
stage='reconcile empty config before starting the real publisher and node'
host_reconcile
[[ ! -e "$work/supervisor/applied" ]]
create_publisher
wait_for ready_publisher
create_node
setup_link() { podman logs "$node" 2>&1 | /usr/bin/grep -oE '^Cyberbaser setup: http://127\.0\.0\.1:4317/setup/start\?token=[A-Za-z0-9_-]+$' | cut -d' ' -f3 | tail -n 1; }
wait_for setup_link

stage='verify namespace, accounts, labels, umasks and mounts'
service_status() {
  dep "$1" sh -euc '
    set -- $(/usr/bin/cat /proc/1/task/1/children)
    [[ $# == 1 && $1 =~ ^[0-9]+$ ]]
    exec /usr/bin/cat "/proc/$1/status"
  '
}
for container in "$node" "$publisher" "$fixture"; do
  [[ $(podman inspect --format '{{.ProcessLabel}}' "$container") == *:container_t:* ]]
  [[ $(podman port "$container") == '' ]]
  dep "$container" ip -j link | jq -e 'map(.ifname) == ["lo"]' >/dev/null
  [[ -z $(dep "$container" ip -4 route show) && -z $(dep "$container" ip -6 route show) ]]
  flags=$(service_status "$container")
  /usr/bin/grep -Ex 'CapEff:\s+0{16}' <<<"$flags" >/dev/null
  /usr/bin/grep -Ex 'NoNewPrivs:\s+1' <<<"$flags" >/dev/null
  /usr/bin/grep -Ex 'Seccomp:\s+2' <<<"$flags" >/dev/null
  dep "$container" findmnt -n -o OPTIONS -T / | /usr/bin/grep -Eq '^ro(,|$)'
done
[[ $(dep "$node" readlink /proc/1/ns/net) == "$(dep "$publisher" readlink /proc/1/ns/net)" ]]
[[ $(dep "$node" readlink /proc/1/ns/pid) != "$(dep "$publisher" readlink /proc/1/ns/pid)" ]]
[[ $(dep "$node" id -u):$(dep "$node" id -g) == 65532:65530 ]]
[[ $(dep "$publisher" id -u):$(dep "$publisher" id -g) == 65533:65530 ]]
[[ $(dep "$fixture" id -u) == 65531 ]]
service_status "$node" | /usr/bin/grep -Ex 'Umask:\s+0007' >/dev/null
service_status "$publisher" | /usr/bin/grep -Ex 'Umask:\s+0027' >/dev/null
[[ $(dep "$node" sha256sum "$record") == "$(dep "$publisher" sha256sum "$record")" ]]
mounts() { podman inspect --format '{{json .Mounts}}' "$1" | jq -c 'map([.Destination,.Type,.RW]) | sort'; }
expected_mounts() { jq -nc '$ARGS.positional | map(split(":") | [.[0],.[1],(.[2] == "rw")]) | sort' --args "$@"; }
assert_mounts() {
  [[ $(mounts "$node") == "$(expected_mounts "$state:volume:rw" "$node_config_dir:volume:rw" "$jobs:volume:rw" "$notes:volume:rw" "$mirror:volume:ro" "$sock:volume:ro" "$record:bind:ro")" ]]
  [[ $(mounts "$publisher") == "$(expected_mounts "$pubstate:volume:rw" "$pub_config_dir:volume:ro" "$jobs:volume:rw" "$notes:volume:ro" "$mirror:volume:rw" "$sock:volume:rw" "$record:bind:ro" '/usr/local/bin/git:bind:ro')" ]]
  [[ $(mounts "$fixture") == "$(expected_mounts '/fixture:bind:ro' "$notes:volume:ro" "$sock:volume:ro")" ]]
}
assert_mounts
metadata() { [[ $(dep "$1" stat -c '%u:%g:%a' "$2") == "$3" ]]; }
metadata "$node" "$state" 65532:65530:700
metadata "$node" "$state/renderers" 65532:65530:700
metadata "$node" /run/cyberbaser 65532:65530:700
metadata "$node" "$jobs/owner-alpha/store/jobs" 65532:65530:770
metadata "$publisher" "$pubstate" 65533:65530:700
metadata "$node" "$mirror" 65533:65530:750
metadata "$publisher" "$notes" 65532:65530:770
metadata "$publisher" "$sock" 65533:65530:710
metadata "$node" "$sock/publisher.sock.forge" 65533:65530:660
metadata "$node" "$sock/publisher.sock.owners" 65533:65530:660
dep "$node" test ! -S "$sock/publisher.sock"  # not the normal publishing service yet
if dep "$node" "${curl_flags[@]}" --connect-timeout 2 -o /dev/null https://github.com 2>/dev/null; then false; fi
pass 'rootless confined services, shared loopback only, no published ports or GitHub egress; exact mount and account separation'

stage='verify setup-mode sockets and distinct enrollment identities'
owner_status() {
  dep "$node" bun -e '
    import {createConnection} from "node:net";
    const socket = createConnection(process.argv[1], () => socket.write("{\"v\":1,\"op\":\"status\"}\n"));
    socket.setTimeout(2000, () => socket.destroy(new Error("owner status timeout")));
    socket.pipe(process.stdout);
  ' "$sock/publisher.sock.owners" | jq -ce 'select(.ok and .result.devices == 0 and .result.enrollmentOpen) | .result'
}
status=$(owner_status)
[[ $(dep "$node" "${curl_flags[@]}" -o /dev/null -w '%{http_code}' "$enroll") == 403 ]]
dep "$fixture" "${curl_flags[@]}" -f "$enroll" | /usr/bin/grep -E 'Or type this code: <strong[^>]*>[A-Z0-9-]+</strong>' >/dev/null
pass 'real setup forge/owner controls; node UID denied enrollment, distinct viewer received a code'

blockers=0
ipv4=$(dep "$node" "$program" validate-reach "$reach")
declare -A setup_udp=()
check_listeners() {
  local phase=$1 active=${2:-yes} rows socket_addr users ipv6='[::1]' family count expected pid
  pid=$(service_status "$node" | /usr/bin/grep -E '^Pid:' | tr -cd '0-9')
  [[ $pid =~ ^[1-9][0-9]*$ ]]
  rows=$(dep "$node" ss -H -lnt)
  while read -r _ _ _ socket_addr _; do
    if [[ -n "$socket_addr" && ! "$socket_addr" =~ ^(127\.[0-9.]+|\[::1\]):[0-9]+$ ]]; then
      printf 'FAIL %s: unexpected TCP listener %s\n' "$phase" "$socket_addr" >&2; return 1
    fi
  done <<< "$rows"
  # Count exactly the carrier's UDP sockets, including IPv6, and verify their
  # owner PID. Never use direct mode as a blanket exception for wildcard UDP.
  for family in 4 6; do
    rows=$(dep "$node" ss -H "-$family" -lnup)
    if [[ "$active" == no ]]; then [[ -z "$rows" ]] || return 1; continue; fi
    expected=$ipv4
    [[ "$family" != 6 ]] || expected=$ipv6
    [[ "$reach" != direct ]] || { expected=0.0.0.0; [[ "$family" != 6 ]] || expected='[::]'; }
    count=0
    while read -r _ _ _ socket_addr _ users; do
      [[ -n "$socket_addr" ]] || continue
      if [[ "$users" != *"pid=$pid,"* ]]; then
        printf 'FAIL %s: UDP IPv%s listener %s does not belong to the node\n' "$phase" "$family" "$socket_addr" >&2; return 1
      fi
      if [[ "${socket_addr%:*}" != "$expected" && ! ( "$reach" == direct && "${socket_addr%:*}" == '*' ) ]]; then
        printf 'FAIL %s: UDP IPv%s listener %s not on %s\n' "$phase" "$family" "$socket_addr" "$expected" >&2; return 1
      fi
      # The native endpoint can retain its exact closed setup sockets until
      # the in-process handoff's handles are collected. Check their addresses
      # above too, but require one new socket per family from the normal node.
      if [[ "$phase" == runtime && "$socket_addr" == "${setup_udp[$family]}" ]]; then continue; fi
      if [[ "$phase" == agent ]]; then setup_udp[$family]=$socket_addr; fi
      count=$((count+1))
    done <<< "$rows"
    if [[ "$count" != 1 ]]; then
      printf 'FAIL %s: expected one UDP IPv%s socket, got %s\n' "$phase" "$family" "$count" >&2; return 1
    fi
  done
  pass "$phase ($reach): all TCP loopback; $([[ "$active" == yes ]] && printf 'exact node UDP binds' || printf 'no UDP yet')"
}
stage='check initial setup listeners'
[[ $(dep "$node" jq -r '.reach' "$state/layout.json") == "$reach" ]]
check_listeners welcome no

stage='exercise manifest bootstrap and mirror copy'
if ! setup_link | timeout 90 podman exec -i "$fixture" bash -euc 'read -r link; bun /fixture/owner-browser.mjs setup-private "$link" "$1" /tmp/owner.cookie' bash "$repository" > "$work/browser" 2>&1; then
  jq -r 'select(.ok == false) | .stage | select(test("^[a-z-]+$"))' "$work/browser" 2>/dev/null || :
  false
fi
jq -e '.ok and .count == 1 and .publishYmlKept and .privateOffered and .manifest == {formAllowed:true,replayRefused:true,githubClicks:3}' "$work/browser" >/dev/null
[[ $(dep "$node" git -C "$checkout" rev-parse HEAD) == "$commit" ]]
[[ $(dep "$node" git -C "$mirror/notes.git" rev-parse refs/heads/main) == "$commit" ]]
[[ -z $(dep "$node" git -C "$mirror/notes.git" remote) ]]
if dep "$node" touch "$mirror/notes.git/.write-probe" 2>/dev/null; then false; fi
if dep "$publisher" touch "$checkout/.write-probe" 2>/dev/null; then false; fi
metadata "$publisher" "$reg" 65533:65530:600
metadata "$publisher" "$token" 65533:65530:600
dep "$publisher" /usr/bin/grep -Eq '"createdBy":"manifest".*cbsCANARY|cbsCANARY.*"createdBy":"manifest"' "$reg"
dep "$publisher" /usr/bin/grep -Eq 'ghu_CANARY' "$token"
dep "$publisher" /usr/bin/grep -Eq 'ghr_CANARY' "$token"
pass 'manifest Create/Install/Authorize and replay refusal; private site chosen; exact checkout and read-only credential-free mirror'

stage='open the phone page without pairing'
dep "$fixture" bun /fixture/owner-browser.mjs phone-page /tmp/owner.cookie | jq -e '.ok and .frameAllowed and (.paired | not)' >/dev/null
check_listeners phone
node_key=$(dep "$node" sha256sum "$state/iroh/iroh-node.json")

stage='verify persistence across a service restart'
before=$(dep "$publisher" sha256sum "$reg" "$token" "$pubstate/owners/publisher-key.json" "$pubstate/owners/enrollment.json")
podman stop -t 10 "$node" "$publisher" >/dev/null
[[ $(podman inspect --format '{{.State.ExitCode}}' "$node") != 137 ]]
[[ $(podman inspect --format '{{.State.ExitCode}}' "$publisher") == 0 ]]
podman start "$publisher" >/dev/null
wait_for ready_publisher
old_link=$(setup_link)
podman start "$node" >/dev/null
fresh_link() { local link; link=$(setup_link) && [[ "$link" != "$old_link" ]]; }
wait_for fresh_link
[[ $(owner_status) == "$status" ]]
[[ $(dep "$publisher" sha256sum "$reg" "$token" "$pubstate/owners/publisher-key.json" "$pubstate/owners/enrollment.json") == "$before" ]]
# The pre-restart cookie is not a persisted authority. A fresh setup link
# opens the saved phone step without registering or authorizing another App.
[[ $(dep "$fixture" bash -euc 'curl -sS --max-time 3 -H "Cookie: $(/usr/bin/cat /tmp/owner.cookie)" -o /dev/null -w "%{http_code}" "$1/setup"' bash "$origin") == 403 ]]
setup_link | podman exec -i "$fixture" bash -euc '
  umask 0077
  read -r link
  curl -fsS --max-time 3 "$link" | /usr/bin/grep -F ">Start setup</button>" >/dev/null
  code=$(printf "token=%s" "${link##*token=}" | curl -fsS --max-time 3 -H "Origin: $1" \
    -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- -c /tmp/new.jar \
    -o /dev/null -w "%{http_code}" "$1/setup/start")
  [[ "$code" == 303 ]]
  curl -fsS --max-time 3 -b /tmp/new.jar "$1/setup" | /usr/bin/grep -F "data-step=\"phone\"" >/dev/null
  /usr/bin/grep -E "^#HttpOnly_" /tmp/new.jar | cut -f6,7 | tr "\t" "=" > /tmp/new.cookie
' bash "$origin"
[[ $(dep "$node" sha256sum "$state/iroh/iroh-node.json") == "$node_key" ]]
check_listeners restarted-phone
[[ $(dep "$node" git -C "$checkout" rev-parse HEAD) == "$commit" ]]
[[ $(dep "$fixture" git -C "$hosted" show-ref) == "$refs" ]]
dep "$fixture" "${curl_flags[@]}" -f "$fake/_control/report" | jq -e '
  .manifest | .created == 1 and .converted == 1 and .installs == 1 and .authorizations == 1 and .webExchanges == 1
' >/dev/null
dep "$fixture" "${curl_flags[@]}" -f "$fake/_control/report" | jq -e '.pushes == [] and (.denied | all(.receive == false)) and (.fetches | length > 0)' >/dev/null
pass 'restart kept phone step, exact checkout, owner identity, enrollment window and forge credentials; no push or changed remote ref'

stage='enroll one signing device through the independent fixture viewer'
viewer() { timeout 60 podman exec "$fixture" bun /fixture/publication.mjs "$@"; }
viewer enroll | jq -e '.ok' >/dev/null
viewer status | jq -e '.ok' >/dev/null
metadata "$fixture" /tmp/one-app-device.json 65531:65530:600
publisher_key=$(dep "$publisher" sha256sum "$pubstate/owners/publisher-key.json")
pass 'the separate viewer enrolled a synthetic key from the real page; its private seed stays on that device'

stage='finish setup and reconcile the config event'
browser() { dep "$fixture" bun /fixture/owner-browser.mjs "$@" /tmp/new.cookie; }
browser step skip | jq -e '.ok and .step == "agent"' >/dev/null
check_listeners agent
browser step skip | jq -e '.ok and .step == "done"' >/dev/null
# The harness is the host supervisor here: recognize the first completed
# atomic write, then invoke the same oneshot a host path unit would call.
wait_for dep "$node" test -f "$node_config"
host_reconcile
wait_for_normal_publisher
metadata "$node" "$node_config" 65532:65530:600
metadata "$publisher" "$pub_config" 65533:65530:600
node_config_hash() { dep "$node" sha256sum "$node_config" | cut -d' ' -f1; }
pub_config_hash() { dep "$publisher" sha256sum "$pub_config" | cut -d' ' -f1; }
[[ $(pub_config_hash) == "$(node_config_hash)" && $(<"$work/supervisor/applied") == "$(pub_config_hash)" ]]
[[ $(dep "$node" "${curl_flags[@]}" -o /dev/null -w '%{http_code}' "$enroll") == 403 ]]
viewer status | jq -e '.ok' >/dev/null
pass 'atomic config handoff activated the normal publisher with its enrolled key retained'

stage='reject bad input and ignore repeated config events'
started_at() { podman inspect --format '{{.State.StartedAt}}' "$publisher"; }
active_start=$(started_at)
active_hash=$(pub_config_hash)
host_reconcile
[[ $(started_at) == "$active_start" ]]
dep "$node" bash -euc 'mv -- "$1" "$1.lab-good"; umask 0077; printf "{}\n" > "$1.lab-bad"; mv -- "$1.lab-bad" "$1"' bash "$node_config"
if host_reconcile; then false; fi
[[ $(started_at) == "$active_start" && $(pub_config_hash) == "$active_hash" ]]
dep "$node" rm -- "$node_config"
if host_reconcile; then false; fi
[[ $(started_at) == "$active_start" && $(pub_config_hash) == "$active_hash" ]]
dep "$node" mv -- "$node_config.lab-good" "$node_config"
host_reconcile
[[ $(started_at) == "$active_start" && $(pub_config_hash) == "$active_hash" ]]
pass 'invalid and missing config did not activate or downgrade; repeat events did not restart the publisher'

stage='verify normal node listeners and the pinned stock private site'
runtime_ready() { dep "$node" test -S /run/cyberbaser/review.sock \
  && dep "$fixture" "${curl_flags[@]}" -o /dev/null "$origin/owner/review"; }
wait_for_runtime() {
  if ! wait_for runtime_ready; then
    podman logs "$node" 2>&1 | /usr/bin/grep -E '^(Cyberbaser could not start after setup|Owner alpha startup failed): [a-z0-9-]+$' >&2 || :
    return 1
  fi
}
wait_for_runtime
browser landed | jq -e '.ok' >/dev/null
dep "$node" jq -e --arg reach "$reach" '.iroh.reach == $reach and .iroh.relay == "none"' "$node_config" >/dev/null
check_listeners runtime
quartz_pin=4923affa7722dfc751f1074348e6dad214fe0c08
site_at() {
  dep "$node" jq -e --arg head "$1" --arg build "$2" --arg pin "$quartz_pin" \
    '.source.head == $head and .renderer.name == $build and .renderer.revision == $pin and .site.htmlPages > 0' "$site" >/dev/null
}
reader_note() { dep "$fixture" "${curl_flags[@]}" -fL "$reader/Garden/Note" | /usr/bin/grep -F "$1" >/dev/null; }
wait_for_site() {
  local i
  for ((i=0;i<180;i++)); do site_at "$1" "$2" 2>/dev/null && reader_note "$3" 2>/dev/null && return 0; sleep .5; done
  # Report only a known startup failure identifier; raw logs can hold codes.
  podman logs "$node" 2>&1 | /usr/bin/grep -E '^(Owner site not ready|Owner alpha startup failed|Cyberbaser could not start after setup): [a-z0-9-]+$' >&2 || :
  return 1
}
prior_note='This is a synthetic public-to-the-fixture note.'
signed_note='This is the signed synthetic update.'
wait_for_site "$commit" quartz-cyberbase "$prior_note"
[[ $(dep "$node" sha256sum "$state/iroh/iroh-node.json") == "$node_key" ]]
pass 'stock pinned Quartz built from the copied commit without a network and served its note on P+1'

stage='check unsigned publication refusal from the normal publisher'
node_helper() {
  # podman exec does not inherit the running service's umask. Use the node's
  # real 0007 so the publisher can write its receipt in the shared job store.
  timeout 90 podman exec -i "$node" bash -euc 'umask 0007; exec bun - "$@"' bash "$@" < "$work/fixture/publication.mjs"
}
job=OA-one-app-signed
node_helper unsigned "$job" > "$work/job" || { jq -r '.code // empty' "$work/job" >&2; false; }
next_commit=$(jq -er 'select(.state == "awaiting-approval" and .reason == "owner-approval-missing") | .commit | select(test("^[a-f0-9]{40}$"))' "$work/job")
[[ "$next_commit" != "$commit" && $(dep "$fixture" git -C "$hosted" show-ref) == "$refs" ]]
dep "$fixture" "${curl_flags[@]}" -f "$fake/_control/report" | jq -e '.pushes == [] and (.denied | all(.receive == false))' >/dev/null
pass 'the publisher rejected the unsigned job before any fake-forge push or ref update'

no_canary() { local code; if "$@" >/dev/null; then return 1; else code=$?; [[ $code == 1 ]]; fi; }
check_log() {
  podman logs "$1" > "$work/log" 2>&1
  no_canary /usr/bin/grep -aEq "$canaries" "$work/log"
}
recreate_services() {
  local first_node first_publisher
  first_node=$(podman inspect --format '{{.Id}}' "$node")
  first_publisher=$(podman inspect --format '{{.Id}}' "$publisher")
  podman stop -t 10 "$node" "$publisher" >/dev/null
  [[ $(podman inspect --format '{{.State.ExitCode}}' "$node") == 0 ]]
  [[ $(podman inspect --format '{{.State.ExitCode}}' "$publisher") == 0 ]]
  check_log "$node"
  check_log "$publisher"
  podman rm "$node" "$publisher" >/dev/null
  create_publisher
  wait_for_normal_publisher
  create_node
  wait_for_runtime
  [[ $(podman inspect --format '{{.Id}}' "$node") != "$first_node" ]]
  [[ $(podman inspect --format '{{.Id}}' "$publisher") != "$first_publisher" ]]
  assert_mounts
  viewer status | jq -e '.ok' >/dev/null
  [[ $(dep "$publisher" sha256sum "$pubstate/owners/publisher-key.json") == "$publisher_key" ]]
  [[ $(dep "$node" sha256sum "$state/iroh/iroh-node.json") == "$node_key" ]]
}

stage='recreate the node and publisher while the job waits for approval'
job_state=$jobs/owner-alpha/store/jobs/$job/state.json
pending_job_hash=$(dep "$node" sha256sum "$job_state")
pending_site_hash=$(dep "$node" sha256sum "$site")
recreate_services
check_listeners pending-runtime
[[ $(dep "$node" sha256sum "$job_state") == "$pending_job_hash" ]]
dep "$node" jq -e '.state == "awaiting-approval"' "$job_state" >/dev/null
[[ $(dep "$node" git -C "$checkout" rev-parse HEAD) == "$next_commit" ]]
[[ $(dep "$node" git -C "$mirror/notes.git" rev-parse refs/heads/main) == "$commit" ]]
[[ $(dep "$fixture" git -C "$hosted" show-ref) == "$refs" ]]
[[ $(dep "$node" sha256sum "$site") == "$pending_site_hash" ]]
wait_for_site "$commit" quartz-cyberbase "$prior_note"
if reader_note "$signed_note"; then false; fi
dep "$fixture" "${curl_flags[@]}" -f "$fake/_control/report" | jq -e '.pushes == [] and (.denied | all(.receive == false))' >/dev/null
pass 'unsigned job and exact local commit survived recreation; the reader stayed on the published revision and no push occurred'

stage='sign and publish the exact commit from the fixture viewer'
timeout 30 podman exec "$fixture" env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$checkout" \
  bun /fixture/publication.mjs sign "$next_commit" "$checkout" "https://github.com/$repository.git" main > "$work/approval"
# Pass one approved record, not the fixture device seed, across the boundary.
timeout 30 podman exec -i "$node" bash -euc 'umask 0077; /usr/bin/cat > /tmp/lab-approval' < "$work/approval"
if ! node_helper submit-signed "$job" > "$work/push"; then
  jq -r '.code // empty' "$work/push" >&2
  dep "$fixture" "${curl_flags[@]}" -f "$fake/_control/report" | jq '{pushes: (.pushes | length), deniedReceive: ([.denied[] | select(.receive)] | length)}' >&2
  false
fi
jq -e '.ok' "$work/push" >/dev/null
dep "$node" rm -- /tmp/lab-approval
[[ $(dep "$fixture" git -C "$hosted" show-ref) == "$next_commit refs/heads/main" ]]

stage='recover the completed push after node and publisher container recreation'
recreate_services
check_listeners restarted-runtime
wait_for_site "$next_commit" quartz-cyberbase "$signed_note"
[[ $(dep "$fixture" git -C "$hosted" show-ref) == "$next_commit refs/heads/main" ]]
[[ $(dep "$fixture" git -C "$hosted" rev-parse HEAD^) == "$commit" ]]
[[ $(dep "$fixture" git -C "$hosted" diff --name-only "$commit" "$next_commit") == Garden/Note.md ]]
[[ $(dep "$node" git -C "$mirror/notes.git" rev-parse refs/heads/main) == "$next_commit" ]]
# Smart HTTP may first return a 401 auth challenge for an anonymous request.
# Only the signed job may reach Git receive-pack; its authenticated retry works.
dep "$fixture" "${curl_flags[@]}" -f "$fake/_control/report" | jq -e '
  (.pushes | length) == 1 and .pushes[0].kind == "app" and .pushes[0].current
  and (.denied | all(.receive == false or .hadAuthorization == false))
' >/dev/null
pass 'one valid signed job pushed one exact commit, and the stock reader rebuilt from it across recreation'

stage='select the synthetic custom renderer and rebuild privately'
# Fixture provisioning only: no product update/rollback procedure is implied.
renderer="$state/renderers/one-app-fixture"
podman exec -i "$node" bash -euc 'umask 0077; mkdir -m 0700 -- "$1"; /usr/bin/cat > "$1/build"; chmod 0700 "$1/build"' \
  bash "$renderer" < "$HERE/test/custom-renderer.sh"
metadata "$node" "$renderer" 65532:65530:700
metadata "$node" "$renderer/build" 65532:65530:700
dep "$node" "${curl_flags[@]}" -f "$fake/_control/report" >/dev/null
podman exec "$node" bash -euc '
  umask 0077
  jq --arg dir "$2" --arg pin "$3" ".renderer = {name:\"one-app-fixture\",directory:\$dir,quartzCommit:\$pin,fingerprint:[\"build\"]}" "$1" > "$1.lab-next"
  mv -- "$1.lab-next" "$1"
' bash "$node_config" "$renderer" "$quartz_pin"
active_start=$(started_at)
if host_reconcile false; then false; fi
[[ ! -e "$work/supervisor/applied" && $(started_at) == "$active_start" && $(pub_config_hash) == "$(node_config_hash)" ]]
host_reconcile
wait_for_normal_publisher
[[ $(started_at) != "$active_start" && $(<"$work/supervisor/applied") == "$(pub_config_hash)" ]]
pass 'a failed restart was not acknowledged; retry activated the already-copied config'
recreate_services
wait_for_site "$next_commit" one-app-fixture "$signed_note"
reader_note 'data-renderer="one-app-fixture"'
pass 'custom renderer built through the configured slot, with fresh network namespace and no access to fake GitHub'

stage='check custom reader and signer persistence through a second recreation'
manifest_hash=$(dep "$node" sha256sum "$site")
recreate_services
wait_for_site "$next_commit" one-app-fixture "$signed_note"
[[ $(dep "$node" sha256sum "$site") == "$manifest_hash" ]]
check_listeners recreated-custom-runtime
[[ $(dep "$node" "${curl_flags[@]}" -o /dev/null -w '%{http_code}' "$enroll") == 403 ]]
dep "$node" test ! -e /tmp/one-app-device.json
dep "$publisher" test ! -e /tmp/one-app-device.json
dep "$fixture" "${curl_flags[@]}" -f "$fake/_control/report" | jq -e '
  (.pushes | length) == 1 and (.routes | all(test("pages|actions|deployments|environments|workflows"; "i") | not))
' >/dev/null
pass 'retained custom site and enrolled device survived recreation without another build, re-enrollment or push'

stage='verify credential confinement and image exclusions'
no_canary dep "$node" /usr/bin/grep -aErq "$canaries" "$state" "$mirror" "$notes" "$jobs" /run/cyberbaser /tmp "$record"
no_canary dep "$publisher" /usr/bin/grep -aErq "$canaries" "$pub_config_dir" "$sock" /tmp "$record"
no_canary dep "$publisher" /usr/bin/grep -aErq 'whsCANARY|FAKEPEMCANARY' "$pubstate"
secrets_at=$(dep "$publisher" /usr/bin/grep -aErl 'cbsCANARY|gh[ur]_CANARY' "$pubstate" | sort)
[[ "$secrets_at" == "$(printf '%s\n' "$reg" "$token" | sort)" ]]
no_canary dep "$fixture" /usr/bin/grep -aErq "$canaries" /tmp
for container in "$node" "$publisher" "$fixture"; do
  podman logs "$container" > "$work/log" 2>&1
  no_canary /usr/bin/grep -aEq "$canaries" "$work/log"
done
no_canary /usr/bin/grep -aEq "$canaries" "$work/browser"
# A clean run of the exact image, with no mounted lab paths, sees neither
# private state nor fixture code. The only renderer is the public pinned seed.
podman run --rm --network none "${base[@]}" --entrypoint /usr/bin/bash "$image" -euc '
  test -z "$(ls -A /opt/cyberbaser/.workspace)"
  test ! -e /fixture && test ! -e /mnt/archives/resources.tar && test ! -e /usr/local/bin/git
  test ! -e /opt/cyberbaser/apps/owner-alpha/test && test ! -e /opt/cyberbaser/packaging/test
  jq -e "has(\"github\") == false and has(\"irohRelay\") == false" /etc/cyberbaser/install.json >/dev/null
  test -f /opt/cyberbaser/vendor/quartz/package.json
'
pass 'manifest secret and tokens only in publisher private state; no forge canaries in shared/node files or lab output; fixture absent from image'

stage='offline renderer gate'
# Same two namespace flags, executable and node confinement as renderer-slot.js.
if dep "$node" /usr/bin/unshare --user --map-root-user --net -- /usr/bin/bash -euc '
  [[ -z "$(ip -4 route show)" && -z "$(ip -6 route show)" ]]
' > "$work/unshare" 2>&1; then
  pass 'offline renderer namespace launcher succeeded (not a renderer build)'
else
  printf 'BLOCKER offline renderer namespace launcher failed under confinement\n' >&2
  /usr/bin/grep -Fx 'unshare: unshare failed: Operation not permitted' "$work/unshare" >&2 || :
  blockers=1
fi
if ((blockers)); then printf 'FAIL deployment boundary; see the blockers above.\n' >&2; exit 1; fi
