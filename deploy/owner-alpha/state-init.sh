#!/usr/bin/env bash
set -euo pipefail
umask 077

STATE_ROOT='/opt/cyberbaser/.workspace'
MARKER="$STATE_ROOT/.owner-alpha-state-profile"
MODE="${1:-init}"

fail() {
  printf 'owner-alpha state initialization failed: %s\n' "$1" >&2
  exit 1
}

require_uint() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]] || fail "$2 must be a numeric ID"
}

PROFILE="${OWNER_ALPHA_STATE_PROFILE:-}"
RUNTIME_UID="${OWNER_ALPHA_RUNTIME_UID:-}"
RUNTIME_GID="${OWNER_ALPHA_RUNTIME_GID:-}"
[[ "$PROFILE" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || fail 'OWNER_ALPHA_STATE_PROFILE is missing or invalid'
require_uint "$RUNTIME_UID" 'OWNER_ALPHA_RUNTIME_UID'
require_uint "$RUNTIME_GID" 'OWNER_ALPHA_RUNTIME_GID'

[[ "$MODE" == 'init' || "$MODE" == 'verify' ]] || fail 'mode must be init or verify'
[[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || fail 'state root must be one real directory'
[[ "$(realpath "$STATE_ROOT")" == "$STATE_ROOT" ]] || fail 'state root must not use symlink aliases'
[[ "$(findmnt -T "$STATE_ROOT" -n -o TARGET)" == "$STATE_ROOT" ]] || fail 'state root must be a dedicated mount'
case ",$(findmnt -T "$STATE_ROOT" -n -o OPTIONS)," in
  *,rw,*) ;;
  *) fail 'state root mount must be writable' ;;
esac

DIRECTORIES=(
  "$STATE_ROOT/owner-alpha"
  "$STATE_ROOT/owner-alpha/store"
  "$STATE_ROOT/owner-alpha/site"
  "$STATE_ROOT/owner-alpha/cache"
  "$STATE_ROOT/owner-alpha/cache/xdg"
  "$STATE_ROOT/owner-alpha/cache/npm"
  "$STATE_ROOT/owner-alpha/home"
)

verify_path() {
  local target="$1"
  [[ -d "$target" && ! -L "$target" ]] || fail 'state directory is missing or substituted'
  [[ "$(realpath "$target")" == "$target" ]] || fail 'state directory uses a symlink alias'
  [[ "$(stat -c '%u:%g' "$target")" == "$RUNTIME_UID:$RUNTIME_GID" ]] || fail 'state directory ownership does not match the selected runtime identity'
  [[ "$(stat -c '%a' "$target")" == '700' ]] || fail 'state directory mode must be 0700'
}

verify_marker_metadata() {
  [[ -f "$MARKER" && ! -L "$MARKER" ]] || fail 'state profile marker is missing or substituted'
  [[ "$(stat -c '%h' "$MARKER")" == '1' ]] || fail 'state profile marker must have one link'
  [[ "$(stat -c '%u:%g' "$MARKER")" == "$RUNTIME_UID:$RUNTIME_GID" ]] || fail 'state profile marker ownership mismatch'
  [[ "$(stat -c '%a' "$MARKER")" == '600' ]] || fail 'state profile marker mode must be 0600'
}

verify_marker_content() {
  mapfile -t fields < "$MARKER"
  [[ "${#fields[@]}" == '4' ]] || fail 'state profile marker has an invalid shape'
  [[ "${fields[0]}" == 'version=1' ]] || fail 'state profile marker version mismatch'
  [[ "${fields[1]}" == "profile=$PROFILE" ]] || fail 'state volume belongs to another profile'
  [[ "${fields[2]}" == "uid=$RUNTIME_UID" ]] || fail 'state volume belongs to another UID'
  [[ "${fields[3]}" == "gid=$RUNTIME_GID" ]] || fail 'state volume belongs to another GID'
}

verify_marker() {
  verify_marker_metadata
  verify_marker_content
  local directory
  for directory in "${DIRECTORIES[@]}"; do verify_path "$directory"; done
}

if [[ -e "$MARKER" ]]; then
  # A rootful initializer deliberately has only CAP_CHOWN. After first use it
  # cannot read the runtime-owned 0600 marker or traverse runtime-owned 0700
  # directories, and granting DAC bypass would broaden this one-shot's power.
  # Validate the marker's immutable metadata here; the main process immediately
  # performs the complete content and directory verification as the runtime UID.
  if [[ "$MODE" == 'init' && "$(id -u)" == '0' && "$RUNTIME_UID" != '0' ]]; then
    verify_marker_metadata
    exit 0
  fi
  verify_marker
  exit 0
fi

[[ "$MODE" == 'init' ]] || fail 'state volume has not been initialized'
[[ "$(id -u)" == '0' ]] || fail 'state initialization must run as container UID 0'
if find "$STATE_ROOT" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  fail 'unmarked non-empty state volume will not be modified'
fi

# Create the complete tree before changing ownership. With every capability except
# CHOWN dropped, initializer UID 0 cannot traverse a mode-0700 parent after that
# parent belongs to the selected nonzero runtime UID. Verify and transfer the tree
# bottom-up so no recursive ownership change or DAC-override capability is needed.
for directory in "${DIRECTORIES[@]}"; do
  install -d -m 0700 "$directory"
done
TEMP_MARKER="$STATE_ROOT/.owner-alpha-state-profile.tmp-$$"
printf 'version=1\nprofile=%s\nuid=%s\ngid=%s\n' "$PROFILE" "$RUNTIME_UID" "$RUNTIME_GID" > "$TEMP_MARKER"
chmod 0600 "$TEMP_MARKER"
mv -T "$TEMP_MARKER" "$MARKER"

for ((index=${#DIRECTORIES[@]} - 1; index >= 0; index--)); do
  directory="${DIRECTORIES[$index]}"
  chmod 0700 "$directory"
  chown "$RUNTIME_UID:$RUNTIME_GID" "$directory"
  verify_path "$directory"
done
chmod 0600 "$MARKER"
verify_marker_content
chown "$RUNTIME_UID:$RUNTIME_GID" "$MARKER"
verify_marker_metadata
