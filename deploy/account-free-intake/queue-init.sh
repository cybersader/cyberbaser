#!/usr/bin/env bash
set -euo pipefail
umask 077

VOLUME_ROOT='/var/lib/cyberbaser'
QUEUE_ROOT="$VOLUME_ROOT/proposal-queue"
RUNTIME_UID='65532'
RUNTIME_GID='65532'

fail() {
  printf 'account-free intake queue init failed: %s\n' "$1" >&2
  exit 1
}

[[ "$(id -u):$(id -g)" == '0:0' ]] || fail 'initializer must run as container root'
[[ "$(findmnt -T "$VOLUME_ROOT" -n -o TARGET)" == "$VOLUME_ROOT" ]] || fail 'queue storage must be one dedicated mount'
case ",$(findmnt -T "$VOLUME_ROOT" -n -o OPTIONS)," in
  *,rw,*) ;;
  *) fail 'queue storage mount must be read-write' ;;
esac

[[ -d "$VOLUME_ROOT" && ! -L "$VOLUME_ROOT" && "$(realpath "$VOLUME_ROOT")" == "$VOLUME_ROOT" ]] \
  || fail 'queue volume root must be one real directory'

mapfile -t entries < <(find "$VOLUME_ROOT" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
if (( ${#entries[@]} > 1 )) || (( ${#entries[@]} == 1 )) && [[ "${entries[0]}" != 'proposal-queue' ]]; then
  fail 'dedicated queue volume contains an unexpected entry'
fi

if [[ ! -e "$QUEUE_ROOT" ]]; then
  mkdir -m 0700 "$QUEUE_ROOT"
  chown "$RUNTIME_UID:$RUNTIME_GID" "$QUEUE_ROOT"
fi

[[ -d "$QUEUE_ROOT" && ! -L "$QUEUE_ROOT" && "$(realpath "$QUEUE_ROOT")" == "$QUEUE_ROOT" ]] \
  || fail 'queue root must be one real directory'
[[ "$(stat -c '%u:%g' "$QUEUE_ROOT")" == "$RUNTIME_UID:$RUNTIME_GID" ]] \
  || fail 'existing queue root ownership does not match the runtime identity'
[[ "$(stat -c '%a' "$QUEUE_ROOT")" == '700' ]] \
  || fail 'existing queue root mode must be 0700'
