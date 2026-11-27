#!/bin/bash
# Trusted HOST-side entry point for a boot reconciliation or a config path
# event. A future Quadlet companion .path, running with permission to watch
# the dedicated input volume directory, should use PathChanged (to see atomic
# renames), not PathExists. Never watch the output or acknowledgement. The host supplies the
# immutable image ID, named volumes, private supervisor dir and a fixed
# publisher restart command, e.g. systemctl --user restart <publisher>.service.
# The restart command may check readiness before returning. No engine socket is
# passed into the copy container, and no node file determines a mount/command.
set -euo pipefail
umask 0077
[[ $# -ge 6 && $5 == -- ]] || exit 2
state=$1 image=$2 input=$3 output=$4
shift 5
[[ "$image" =~ ^(sha256:)?[0-9a-f]{64}$ && "$input" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ \
  && "$output" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ && "$input" != "$output" ]] || exit 2
[[ -d "$state" && ! -L "$state" && $(stat -c '%u:%a' "$state") == "$EUID:700" ]] || exit 2
exec 9> "$state/lock"
flock -w 30 9
active=missing
if [[ -f "$state/applied" ]]; then active=$(<"$state/applied"); [[ "$active" =~ ^[0-9a-f]{64}$ ]]; fi
podman volume exists "$input"
podman volume exists "$output"
version=$(podman run --rm --name "$input-reconcile" --pull never --network none --http-proxy=false \
  --user 0:0 --read-only --read-only-tmpfs=false --cap-drop ALL --cap-add CHOWN,DAC_OVERRIDE \
  --security-opt no-new-privileges --log-driver none --memory 128m --memory-swap 128m --pids-limit 64 \
  -v "$input:/var/lib/cyberbaser/config:ro,nocopy" -v "$output:/var/lib/cyberbaser-publisher-config:rw,nocopy" \
  "$image" sync-container-publisher-config 9>&-)
if [[ "$version" == missing ]]; then
  # Only a never-configured instance can return to setup. Preserve the
  # last known-good output when the source is missing or invalid.
  [[ "$active" == missing ]]
  exit
fi
[[ "$version" =~ ^[0-9a-f]{64}$ ]]
[[ "$active" != "$version" ]] || exit 0
# Forget the old acknowledgement before invoking restart: a failed command
# may have stopped or replaced the publisher already. Reconcile on the next
# event even if its desired version reverts to the old one.
rm -f -- "$state/applied"
"$@" 9>&-
# An unacknowledged copy is retried even when the destination is unchanged.
temp=$(mktemp "$state/.applied.XXXXXXXX")
trap 'rm -f -- "$temp"' EXIT
printf '%s\n' "$version" > "$temp"
mv -f -- "$temp" "$state/applied"
