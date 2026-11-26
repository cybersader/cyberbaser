#!/bin/bash
set -euo pipefail
program=/opt/cyberbaser/bin/cyberbaser
case "${1:-}" in
  service-node) umask 0007; exec "$program" "$@" ;;
  service-publisher) umask 0027; exec "$program" "$@" ;;
  init-volumes) ;;
  *) exec "$program" "$@" ;;
esac

# Run once while the services are stopped, in an isolated container with
# CHOWN, DAC_OVERRIDE and FOWNER. Do not repair, follow, or recursively chown
# unexpected state. Only an empty, root-owned volume root can be initialized.
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 1 && $EUID == 0 ]] || fail 'Volume initialization requires container root.'
umask 0077
record=/etc/cyberbaser/install.json
[[ -f "$record" && ! -L "$record" && $(stat -c '%u:%g:%a:%h' "$record") == 0:0:644:1 ]] || fail 'Unsafe install record.'
layout=$(mktemp /tmp/cyberbaser-layout.XXXXXX)
trap 'rm -f -- "$layout"' EXIT
jq -e '
  select(type == "object" and ((keys - ["version","state","accounts","group","appRoot","port","publication","reach","irohRelay","github"]) == []))
  | select(.version == 1 and .state == "container" and .accounts == {node:"cyberbaser",publisher:"cyberbaser-publisher"}
    and .group == "cyberbaser-share" and .appRoot == "/opt/cyberbaser" and .publication == "private-site")
  | select(.port | type == "number" and . == floor and . >= 1024 and . <= 65533)
  | select((.irohRelay // "n0") | test("^(none|n0|http://127\\.0\\.0\\.1:[0-9]{1,5}/)$"))
  | select((.github // {}) | . == {} or (keys == ["origin"] and (.origin | test("^http://127\\.0\\.0\\.1:[0-9]{1,5}$"))))
  | select((has("reach") | not) or (.reach | type == "string" and (test("[[:cntrl:]]") | not)))
  | {listen:{host:"127.0.0.1",port:.port}, reviewSocket:"/run/cyberbaser/review.sock",
    irohStateDirectory:"/var/lib/cyberbaser/iroh", forgeStateDirectory:"/var/lib/cyberbaser-publisher/forge",
    configFile:"/var/lib/cyberbaser/config/owner-alpha.json", checkout:"/var/lib/cyberbaser-shared/notes/notes",
    mirror:"/var/lib/cyberbaser-shared/mirror/notes.git", clientId:null, publication,
    relay:(.irohRelay // "n0"), reach:(.reach // "direct")}
' "$record" > "$layout" || fail 'Invalid container install record.'
reach=$(jq -r '.reach' "$layout")
"$program" validate-reach "$reach" >/dev/null || fail 'Invalid reach in container install record.'

dir() {
  local path=$1 uid=$2 mode=$3 kind=${4:-child} mounted_child=${5:-} metadata
  [[ ! -L "$path" ]] || fail "Unexpected directory link: $path"
  if [[ "$kind" == volume ]]; then
    mountpoint -q -- "$path" || fail "Missing named volume: $path"
  elif [[ ! -e "$path" ]]; then
    mkdir -- "$path"
  fi
  [[ -d "$path" ]] || fail "Expected directory: $path"
  metadata=$(stat -c '%u:%g:%a' -- "$path")
  [[ "$metadata" != "$uid:65530:$mode" ]] || return 0
  local extras=()
  if [[ -n "$mounted_child" ]]; then
    mountpoint -q -- "$mounted_child" || fail "Missing nested volume: $mounted_child"
    extras=(! -path "$mounted_child")
  fi
  [[ "$metadata" =~ ^0:0:(700|755)$ && -z $(find "$path" -mindepth 1 -maxdepth 1 "${extras[@]}" -print -quit) ]] || fail "Unexpected directory metadata or contents: $path"
  chmod -- "$mode" "$path"
  chown -- "$uid:65530" "$path"
}
node=/var/lib/cyberbaser
shared=/var/lib/cyberbaser-shared
dir "$node" 65532 700 volume "$node/config"
dir "$node/config" 65532 700 volume
dir /var/lib/cyberbaser-publisher-config 65533 700 volume
for child in home cache iroh setup renderers; do dir "$node/$child" 65532 700; done
dir "$shared/workspace" 65532 770 volume
dir "$shared/workspace/owner-alpha" 65532 710
dir "$shared/workspace/owner-alpha/store" 65532 710
dir "$shared/workspace/owner-alpha/store/jobs" 65532 770
dir "$shared/notes" 65532 770 volume
dir "$shared/mirror" 65533 750 volume
dir /var/lib/cyberbaser-publisher 65533 700 volume
dir /run/cyberbaser-publisher 65533 710 volume

file="$node/layout.json"
[[ ! -L "$file" ]] || fail 'Unexpected setup layout link.'
if [[ -e "$file" ]]; then
  [[ -f "$file" && $(stat -c '%u:%g:%a:%h' "$file") == 65532:65530:600:1 ]] || fail 'Unsafe setup layout.'
  # Records and layouts created before reach existed have the direct default.
  if ! cmp -s "$file" "$layout"; then
    [[ "$reach" == direct && $(jq 'select(type == "object" and (has("reach") | not)) | . + {reach:"direct"}' "$file") == "$(<"$layout")" ]] \
      || fail 'Setup layout differs from the install record.'
  fi
else
  (set -o noclobber; /usr/bin/cat "$layout" > "$file")
  chown 65532:65530 "$file"
fi
printf 'Cyberbaser volumes ready.\n'
