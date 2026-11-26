#!/bin/bash
# Test an existing image in a disposable, offline Podman pod. No real vault,
# install, source credentials, host listener, or container engine socket.
set -Eeuo pipefail
umask 0077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
image=$(podman image inspect --format '{{.Id}}' "${1:-localhost/cyberbaser-one-app:lab}")
platform=$(podman image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
printf 'Image %s %s\n' "$image" "$platform"
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
sock=/run/cyberbaser-publisher jobs=/opt/cyberbaser/.workspace notes=$shared/notes
mirror=$shared/mirror checkout=$notes/notes
record=/etc/cyberbaser/install.json program=/opt/cyberbaser/bin/cyberbaser
reg=$pubstate/forge/github-app-registration.json token=$pubstate/forge/github-app.json
origin=http://127.0.0.1:4317 fake=http://127.0.0.1:48080 enroll=http://127.0.0.1:4319/enroll
repository=lab-owner/lab-notes hosted=/tmp/forge/lab-owner/lab-notes.git
canaries='gh[ur]_CANARY|cbsCANARY|whsCANARY|FAKEPEMCANARY'
mkdir -m 0755 "$work/fixture"
install -m 0644 "$REPO/apps/owner-alpha/test/fake-github.js" "$REPO/packaging/test/container/owner-browser.mjs" "$work/fixture/"
jq --arg fake "$fake" '. + {github:{origin:$fake},irohRelay:"none"}' "$HERE/install.json" > "$work/install.json"
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
for name in node-state publisher-state workspace notes mirror publisher-sockets; do
  podman volume create "$pod-$name" >/dev/null
  volumes+=("$pod-$name")
done
init_volumes() {
  podman run --rm --pod "$pod" "${base[@]}" --user 0:0 --cap-add CHOWN,DAC_OVERRIDE,FOWNER \
    "${mount_record[@]}" -v "$(vol node-state "$state")" -v "$(vol publisher-state "$pubstate")" \
    -v "$(vol workspace "$shared/workspace")" -v "$(vol notes "$notes")" -v "$(vol mirror "$mirror")" \
    -v "$(vol publisher-sockets "$sock")" "$image" init-volumes
}
stage='initialize named volumes'
init_volumes
init_volumes >/dev/null
pass 'volume initialization is repeatable before either service starts'

stage='start fake GitHub with one private note'
podman run -d --pod "$pod" --name "$fixture" "${base[@]}" --user 65531:65530 --workdir /tmp \
  -e HOME=/tmp -e FAKE_GITHUB_PORT=48080 -v "$work/fixture:/fixture:ro,Z" --entrypoint /usr/bin/bash "$image" -euc '
  git init -q -b main /tmp/src
  mkdir -p /tmp/src/Garden /tmp/forge/lab-owner
  printf "allow:\n  - Garden\n" > /tmp/src/publish.yml
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

stage='start the real publisher and node'
podman run -d --pod "$pod" --name "$publisher" "${base[@]}" --user 65533:65530 -e HOME="$pubstate" \
  "${mount_record[@]}" -v "$work/git:/usr/local/bin/git:ro,Z" -v "$(vol publisher-state "$pubstate")" \
  -v "$(vol workspace "$jobs")" -v "$(vol notes "$notes" ro)" -v "$(vol mirror "$mirror")" \
  -v "$(vol publisher-sockets "$sock")" "$image" service-publisher >/dev/null
ready_publisher() { dep "$publisher" test -S "$sock/publisher.sock.forge" && dep "$fixture" "${curl_flags[@]}" -f -o /dev/null "$enroll"; }
wait_for ready_publisher
podman run -d --pod "$pod" --name "$node" "${base[@]}" --user 65532:65530 -e HOME="$state/home" -e XDG_CACHE_HOME="$state/cache" \
  "${mount_record[@]}" --mount type=tmpfs,destination=/run/cyberbaser,tmpfs-mode=0700,tmpfs-size=1048576,notmpcopyup,U=true \
  -v "$(vol node-state "$state")" -v "$(vol workspace "$jobs")" -v "$(vol notes "$notes")" \
  -v "$(vol mirror "$mirror" ro)" -v "$(vol publisher-sockets "$sock" ro)" "$image" service-node >/dev/null
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
[[ $(mounts "$node") == "$(expected_mounts "$state:volume:rw" "$jobs:volume:rw" "$notes:volume:rw" "$mirror:volume:ro" "$sock:volume:ro" "$record:bind:ro")" ]]
[[ $(mounts "$publisher") == "$(expected_mounts "$pubstate:volume:rw" "$jobs:volume:rw" "$notes:volume:ro" "$mirror:volume:rw" "$sock:volume:rw" "$record:bind:ro" '/usr/local/bin/git:bind:ro')" ]]
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
check_listeners() {
  local phase=$1 protocol flag rows socket_addr wildcard
  for protocol in tcp udp; do
    flag=-lnt; [[ "$protocol" == tcp ]] || flag=-lnu
    rows=$(dep "$node" ss -H "$flag")
    if [[ "$phase" != welcome && "$protocol" == udp && -z "$rows" ]]; then
      printf 'FAIL Iroh UDP was not exercised at %s\n' "$phase" >&2; exit 1
    fi
    wildcard=0
    while read -r _ _ _ socket_addr _; do
      [[ -n "$socket_addr" ]] || continue
      if [[ ! "$socket_addr" =~ ^(127\.[0-9.]+|\[::1\]):[0-9]+$ ]]; then wildcard=$((wildcard+1)); fi
    done <<< "$rows"
    if ((wildcard)); then
      printf 'BLOCKER %s: %s non-loopback %s listener(s); pod has only lo\n' "$phase" "$wildcard" "$protocol" >&2
      blockers=1
    else
      pass "$phase: no non-loopback $protocol listeners"
    fi
  done
}
stage='check initial setup listeners'
check_listeners welcome

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
  read -r link
  curl -fsS --max-time 3 "$link" | /usr/bin/grep -F ">Start setup</button>" >/dev/null
  code=$(printf "token=%s" "${link##*token=}" | curl -fsS --max-time 3 -H "Origin: $1" \
    -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- -c /tmp/new.cookie \
    -o /dev/null -w "%{http_code}" "$1/setup/start")
  [[ "$code" == 303 ]]
  curl -fsS --max-time 3 -b /tmp/new.cookie "$1/setup" | /usr/bin/grep -F "data-step=\"phone\"" >/dev/null
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

stage='verify credential confinement and image exclusions'
no_canary() { local code; if "$@" >/dev/null; then return 1; else code=$?; [[ $code == 1 ]]; fi; }
no_canary dep "$node" /usr/bin/grep -aErq "$canaries" "$state" "$mirror" "$notes" "$jobs" /run/cyberbaser /tmp "$record"
no_canary dep "$publisher" /usr/bin/grep -aErq "$canaries" "$sock" /tmp "$record"
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
