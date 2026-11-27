#!/usr/bin/env bash
# Use only short-lived local fixture helpers. Verify reaping while the leader
# is still alive, not just after final process-tree teardown.
set -euo pipefail
work=$1
for ((i=1; i<=24; i++)); do
  /usr/bin/bash -euc '
    /usr/bin/bash -euc '\''printf "%s\n" "$$" > "$1"; exec /usr/bin/true'\'' helper "$1" &
  ' parent "$work/helper-$i.pid"
done
for ((i=1; i<=24; i++)); do
  for ((attempt=0; attempt<150; attempt++)); do
    [[ -s "$work/helper-$i.pid" ]] && break
    /usr/bin/sleep .02
  done
  pid=$(<"$work/helper-$i.pid")
  [[ "$pid" =~ ^[0-9]+$ ]]
  for ((attempt=0; attempt<150; attempt++)); do
    [[ ! -e /proc/$pid ]] && break
    /usr/bin/sleep .02
  done
  [[ ! -e /proc/$pid ]]
done
exit 17
