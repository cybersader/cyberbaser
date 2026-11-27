#!/usr/bin/env bash
# Kernel probes only. No engine, install, network service or pinned seed needed.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../../../.." && pwd)
work=$(mktemp -d "$root/.workspace/renderer-launcher.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/home" "$work/build" "$work/output"
compile=(-std=c11 -O2 -Wall -Wextra -Werror -fPIE -pie -fstack-protector-strong -Wl,-z,relro,-z,now)
cc "${compile[@]}" "$here/../render-offline.c" -o "$work/render-offline"
printf 'PASS: renderer launcher compiles with release flags\n'
HOME=$work/home /usr/bin/bash -eu "$here/landlock-denial.sh" "$work/render-offline" "$work"
printf 'PASS: Landlock write, metadata, parent-memory and symlink refusals\n'
bun "$here/socket-denial.mjs"
"$work/render-offline" "$work/build" "$work/output" -- "$(command -v bun)" "$here/socket-denial.mjs" --restricted --host-probe
printf 'PASS: seccomp socket and addressed-send refusals; anonymous subprocess IPC works\n'
cc "${compile[@]}" -DRENDER_TIMEOUT_SECONDS=1 "$here/../render-offline.c" -o "$work/render-timed"
result=0
"$work/render-timed" "$work/build" "$work/output" -- /usr/bin/bash -euc '
  /usr/bin/setsid /usr/bin/bash -euc '\''printf "%s" "$$" > "$1"; exec /usr/bin/sleep 30'\'' child "$1" &
  wait
' probe "$work/build/child.pid" || result=$?
[ "$result" = 124 ]
pid=$(< "$work/build/child.pid")
[[ $pid =~ ^[1-9][0-9]+$ && ! -e /proc/$pid ]]
printf 'PASS: timeout killed and reaped a child in its own session\n'
