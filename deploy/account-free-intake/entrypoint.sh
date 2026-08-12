#!/usr/bin/env bash
set -euo pipefail
umask 077

APP_ROOT='/opt/cyberbaser'
SOURCE_CONFIG='/config/account-free-intake.json'
RUN_ROOT='/run/account-free-intake'
ACTIVE_CONFIG="$RUN_ROOT/account-free-intake.json"
BINDINGS_ROOT='/srv/cyberbaser/source-bindings'
GIT_ROOT='/srv/cyberbaser/source-objects.git'
VOLUME_ROOT='/var/lib/cyberbaser'
QUEUE_ROOT="$VOLUME_ROOT/proposal-queue"

fail() {
  printf 'account-free intake entrypoint failed: %s\n' "$1" >&2
  exit 1
}

mount_target() { findmnt -T "$1" -n -o TARGET; }
mount_options() { findmnt -T "$1" -n -o OPTIONS; }

require_mount() {
  local path="$1" expected_target="$2" expected_access="$3" expected_type="${4:-}"
  [[ "$(mount_target "$path")" == "$expected_target" ]] || fail "$path must be a dedicated mount at $expected_target"
  case ",$(mount_options "$path")," in
    *",$expected_access,"*) ;;
    *) fail "$path mount must be $expected_access" ;;
  esac
  if [[ -n "$expected_type" ]]; then
    [[ "$(findmnt -T "$path" -n -o FSTYPE)" == "$expected_type" ]] || fail "$path must use $expected_type"
  fi
}

for name in \
  GIT_ASKPASS SSH_ASKPASS SSH_AUTH_SOCK \
  GITHUB_TOKEN GH_TOKEN GITLAB_TOKEN FORGEJO_TOKEN \
  DOCKER_HOST CONTAINER_HOST REGISTRY_AUTH_FILE; do
  [[ -z "${!name:-}" ]] || fail "$name must not enter the intake container"
done

[[ "$(id -u):$(id -g)" == '65532:65532' ]] || fail 'public service must run as 65532:65532'
[[ "${HOME:-}" == '/nonexistent' ]] || fail 'HOME must remain non-persistent'
[[ "${TMPDIR:-}" == '/tmp' ]] || fail 'TMPDIR must be exactly /tmp'
[[ "${ACCOUNT_FREE_INTAKE_CONFIG:-}" == "$ACTIVE_CONFIG" ]] || fail 'active config path does not match the image contract'

[[ -d "$APP_ROOT" && ! -L "$APP_ROOT" && "$(realpath "$APP_ROOT")" == "$APP_ROOT" ]] \
  || fail 'application root must be one real directory'
[[ "$(mount_target "$APP_ROOT")" == '/' ]] || fail 'application root must come from the image root filesystem'
case ",$(mount_options "$APP_ROOT")," in
  *,ro,*) ;;
  *) fail 'image root filesystem must be read-only' ;;
esac

require_mount "$SOURCE_CONFIG" "$SOURCE_CONFIG" ro
require_mount "$BINDINGS_ROOT" "$BINDINGS_ROOT" ro
require_mount "$GIT_ROOT" "$GIT_ROOT" ro
require_mount "$VOLUME_ROOT" "$VOLUME_ROOT" rw
require_mount "$RUN_ROOT" "$RUN_ROOT" rw tmpfs
require_mount '/tmp' '/tmp' rw tmpfs
for path in "$RUN_ROOT" /tmp; do
  case ",$(mount_options "$path")," in
    *,nosuid,*nodev,*noexec,*) ;;
    *) fail "$path tmpfs must use nosuid,nodev,noexec" ;;
  esac
done

[[ -f "$SOURCE_CONFIG" && ! -L "$SOURCE_CONFIG" ]] || fail 'source config must be one regular non-symlink file'
[[ "$(stat -c '%h' "$SOURCE_CONFIG")" == '1' ]] || fail 'source config must have one link'
(( (8#$(stat -c '%a' "$SOURCE_CONFIG") & 8#222) == 0 )) || fail 'source config must have no write permission bits'

for directory in "$BINDINGS_ROOT" "$GIT_ROOT" "$VOLUME_ROOT" "$QUEUE_ROOT" "$RUN_ROOT" /tmp; do
  [[ -d "$directory" && ! -L "$directory" && "$(realpath "$directory")" == "$directory" ]] \
    || fail "$directory must be one real directory"
done
[[ "$(stat -c '%u:%g' "$QUEUE_ROOT")" == '65532:65532' ]] || fail 'queue root ownership mismatch'
[[ "$(stat -c '%a' "$QUEUE_ROOT")" == '700' ]] || fail 'queue root mode must be 0700'
[[ "$(stat -c '%u:%g' "$RUN_ROOT")" == '65532:65532' && "$(stat -c '%a' "$RUN_ROOT")" == '700' ]] \
  || fail 'runtime config tmpfs ownership or mode mismatch'
[[ "$(stat -c '%u:%g' /tmp)" == '65532:65532' && "$(stat -c '%a' /tmp)" == '700' ]] \
  || fail 'temporary tmpfs ownership or mode mismatch'

[[ "$(git --git-dir="$GIT_ROOT" rev-parse --is-bare-repository 2>/dev/null)" == 'true' ]] \
  || fail 'source object input must be one bare Git repository'
if git --git-dir="$GIT_ROOT" config --get-regexp '^(credential\.|http\..*\.extraheader|url\..*\.insteadof)' >/dev/null 2>&1; then
  fail 'bare Git input must not contain credential or URL-rewrite configuration'
fi

for forbidden in \
  /vault \
  /run/owner-alpha \
  /run/owner-alpha-credentials \
  /var/run/docker.sock \
  /run/docker.sock \
  /run/podman/podman.sock \
  /root/.ssh \
  /source-worktree \
  /publication-output; do
  [[ ! -e "$forbidden" ]] || fail "forbidden runtime material exists at $forbidden"
done
if find /home -xdev -type d -name .ssh -print -quit 2>/dev/null | grep -q .; then
  fail 'SSH material must not enter the intake container'
fi

[[ ! -e "$ACTIVE_CONFIG" ]] || fail 'active config tmpfs must be empty before staging'
bun "$APP_ROOT/deploy/account-free-intake/stage-config.js"

exec bun "$APP_ROOT/apps/account-free-intake/bin/server.js" --config "$ACTIVE_CONFIG"
