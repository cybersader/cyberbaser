#!/usr/bin/env bash
set -euo pipefail
umask 077

APP_ROOT='/opt/cyberbaser'
STATE_ROOT="$APP_ROOT/.workspace"
SOURCE_CONFIG='/config/owner-alpha.local.json'
RUN_ROOT='/run/owner-alpha'
ACTIVE_CONFIG="$RUN_ROOT/owner-alpha.local.json"
READY_FILE='/run/owner-alpha/ready'
CREDENTIAL_ROOT='/run/owner-alpha-credentials'
EXPECTED_SOCKET="$CREDENTIAL_ROOT/helper.sock"
MIN_TMP_KIB=2097152

fail() {
  printf 'owner-alpha entrypoint failed: %s\n' "$1" >&2
  exit 1
}

mount_target() { findmnt -T "$1" -n -o TARGET; }
mount_type() { findmnt -T "$1" -n -o FSTYPE; }
mount_options() { findmnt -T "$1" -n -o OPTIONS; }

forbid_mount_option() {
  local path="$1" forbidden="$2"
  case ",$(mount_options "$path")," in
    *",$forbidden,"*) fail "$path mount must not use $forbidden" ;;
  esac
}

require_mount() {
  local path="$1" expected_target="$2" expected_type="$3" expected_access="$4"
  [[ "$(mount_target "$path")" == "$expected_target" ]] || fail "$path must be a dedicated mount at $expected_target"
  if [[ -n "$expected_type" ]]; then
    [[ "$(mount_type "$path")" == "$expected_type" ]] || fail "$path must use $expected_type"
  fi
  case ",$(mount_options "$path")," in
    *",$expected_access,"*) ;;
    *) fail "$path mount must be $expected_access" ;;
  esac
}

[[ -t 0 && -t 1 ]] || fail 'stdin and stdout must be attached to a TTY'
[[ "${HOME:-}" == "$STATE_ROOT/owner-alpha/home" ]] || fail 'HOME does not match the state-volume contract'
[[ "${XDG_CACHE_HOME:-}" == "$STATE_ROOT/owner-alpha/cache/xdg" ]] || fail 'XDG_CACHE_HOME does not match the state-volume contract'
[[ "${TMPDIR:-}" == '/tmp' ]] || fail 'TMPDIR must be exactly /tmp'
[[ "${OWNER_ALPHA_READY_FILE:-}" == "$READY_FILE" ]] || fail 'OWNER_ALPHA_READY_FILE must use the private runtime tmpfs'
[[ "${OWNER_ALPHA_CREDENTIAL_SOCKET:-}" == "$EXPECTED_SOCKET" ]] || fail 'credential socket path does not match the runtime contract'
[[ "${OWNER_ALPHA_STATE_PROFILE:-}" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || fail 'OWNER_ALPHA_STATE_PROFILE is missing or invalid'
[[ "$(command -v git)" == '/usr/local/bin/git' ]] || fail 'runtime Git must use the image credential-policy wrapper'

[[ -d "$APP_ROOT" && ! -L "$APP_ROOT" && "$(realpath "$APP_ROOT")" == "$APP_ROOT" ]] || fail 'application root must be one real directory'
[[ "$(mount_target "$APP_ROOT")" == '/' ]] || fail 'application root must come from the image root filesystem'
case ",$(mount_options "$APP_ROOT")," in
  *,ro,*) ;;
  *) fail 'image root filesystem must be read-only' ;;
esac

require_mount '/vault' '/vault' '' 'rw'
require_mount "$SOURCE_CONFIG" "$SOURCE_CONFIG" '' 'ro'
require_mount "$STATE_ROOT" "$STATE_ROOT" '' 'rw'
require_mount '/tmp' '/tmp' 'tmpfs' 'rw'
forbid_mount_option '/tmp' 'noexec'
require_mount "$RUN_ROOT" "$RUN_ROOT" 'tmpfs' 'rw'
require_mount "$CREDENTIAL_ROOT" "$CREDENTIAL_ROOT" '' 'ro'

[[ -d /vault && ! -L /vault && "$(realpath /vault)" == '/vault' ]] || fail '/vault must be one real directory'
[[ "$(stat -c '%u:%g' /vault)" == "$(id -u):$(id -g)" ]] || fail '/vault ownership must match the runtime identity'
[[ "$(git -C /vault rev-parse --show-toplevel 2>/dev/null)" == '/vault' ]] || fail '/vault must be the exact Git worktree root'
VAULT_PROBE=''
cleanup_vault_probe() {
  if [[ -n "$VAULT_PROBE" ]]; then rm -f -- "$VAULT_PROBE"; fi
}
trap cleanup_vault_probe EXIT INT TERM
VAULT_PROBE="$(mktemp /vault/.owner-alpha-write-check.XXXXXX)" || fail '/vault must be writable by the runtime identity'
[[ "$(stat -c '%u:%g' "$VAULT_PROBE")" == "$(id -u):$(id -g)" ]] || fail '/vault writes do not use the runtime identity'
rm -f -- "$VAULT_PROBE"
VAULT_PROBE=''
trap - EXIT INT TERM

[[ -f "$SOURCE_CONFIG" && ! -L "$SOURCE_CONFIG" ]] || fail 'source config must be one regular non-symlink file'
[[ "$(stat -c '%h' "$SOURCE_CONFIG")" == '1' ]] || fail 'source config must have one link'
[[ "$(stat -c '%u:%g' "$SOURCE_CONFIG")" == "$(id -u):$(id -g)" ]] || fail 'source config ownership must match the runtime identity'
[[ "$(stat -c '%a' "$SOURCE_CONFIG")" == '600' ]] || fail 'source config mode must be 0600'

[[ -d "$RUN_ROOT" && ! -L "$RUN_ROOT" && "$(realpath "$RUN_ROOT")" == "$RUN_ROOT" ]] || fail 'runtime config directory must be one real tmpfs directory'
[[ "$(stat -c '%u:%g' "$RUN_ROOT")" == "$(id -u):$(id -g)" ]] || fail 'runtime config directory ownership mismatch'
[[ "$(stat -c '%a' "$RUN_ROOT")" == '700' ]] || fail 'runtime config directory mode must be 0700'
[[ -d "$CREDENTIAL_ROOT" && ! -L "$CREDENTIAL_ROOT" && "$(realpath "$CREDENTIAL_ROOT")" == "$CREDENTIAL_ROOT" ]] || fail 'credential socket directory must be one real directory'
[[ -S "$EXPECTED_SOCKET" && ! -L "$EXPECTED_SOCKET" ]] || fail 'credential broker socket is missing or substituted'
if find "$CREDENTIAL_ROOT" -mindepth 1 -maxdepth 1 ! -name 'helper.sock' -print -quit | grep -q .; then
  fail 'credential socket directory must contain only helper.sock'
fi

AVAILABLE_TMP_KIB="$(df -k --output=avail /tmp | grep -E '^[[:space:]]*[0-9]+[[:space:]]*$' | tr -d '[:space:]')"
[[ "$AVAILABLE_TMP_KIB" =~ ^[0-9]+$ && "$AVAILABLE_TMP_KIB" -ge "$MIN_TMP_KIB" ]] || fail '/tmp tmpfs has insufficient free capacity'

OWNER_ALPHA_RUNTIME_UID="$(id -u)"
OWNER_ALPHA_RUNTIME_GID="$(id -g)"
export OWNER_ALPHA_RUNTIME_UID OWNER_ALPHA_RUNTIME_GID
/usr/local/bin/owner-alpha-state-init verify
[[ -w "$HOME" && -w "$XDG_CACHE_HOME" && -w "$STATE_ROOT/owner-alpha/store" && -w "$STATE_ROOT/owner-alpha/site" ]] || fail 'runtime state directories are not writable'

rm -f -- "$READY_FILE"
[[ ! -e "$ACTIVE_CONFIG" ]] || fail 'active config tmpfs must be empty before staging'
bun "$APP_ROOT/deploy/owner-alpha/stage-config.js"

[[ -n "$(git -C /vault config --get user.name 2>/dev/null || true)" ]] || fail 'vault Git author name is missing'
[[ -n "$(git -C /vault config --get user.email 2>/dev/null || true)" ]] || fail 'vault Git author email is missing'

exec bun "$APP_ROOT/apps/owner-alpha/src/server.js" "$ACTIVE_CONFIG"
