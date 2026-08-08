#!/usr/bin/env bash
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${OWNER_ALPHA_COMPOSE_FILE:-$HERE/compose.yaml}"
ENV_FILE="${OWNER_ALPHA_ENV_FILE:-$HERE/operator.env}"
COMMAND="${1:-}"

fail() {
  printf 'owner-alpha management failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'usage: owner-alpha-compose.sh validate|init|start|restart|stop|status|attach|bootstrap' \
    '' \
    'The env file selects rootless or rootful with OWNER_ALPHA_PROFILE.' \
    'start/restart are detached and never attach container output to systemd.' \
    'bootstrap explicitly attaches to the live TTY; enter b, then detach with Ctrl-p Ctrl-q.' >&2
  exit 2
}

require_uint() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]] || fail "$2 must be a numeric ID"
}

file_mode_decimal() {
  local mode
  mode="$(stat -c '%a' -- "$1")"
  [[ "$mode" =~ ^[0-7]+$ ]] || fail "could not inspect permissions for $1"
  printf '%s\n' "$((8#$mode))"
}

require_real_file() {
  local target="$1" label="$2"
  [[ -f "$target" && ! -L "$target" ]] || fail "$label must be one regular non-symlink file"
  [[ "$(realpath -e -- "$target")" == "$target" ]] || fail "$label must not use symlink aliases"
  [[ "$(stat -c '%h' -- "$target")" == '1' ]] || fail "$label must have one hard link"
}

require_real_directory() {
  local target="$1" label="$2"
  [[ -d "$target" && ! -L "$target" ]] || fail "$label must be one real directory"
  [[ "$(realpath -e -- "$target")" == "$target" ]] || fail "$label must not use symlink aliases"
}

require_exact_owner() {
  local target="$1" uid="$2" gid="$3" label="$4"
  [[ "$(stat -c '%u:%g' -- "$target")" == "$uid:$gid" ]] \
    || fail "$label ownership must match the selected runtime identity"
}

read_operator_environment() {
  local line key value
  declare -gA OPERATOR_VALUES=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || fail 'env file must use exact KEY=value lines'
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case "$key" in
      OWNER_ALPHA_PROFILE|OWNER_ALPHA_IMAGE|OWNER_ALPHA_VAULT_PATH|OWNER_ALPHA_CONFIG_PATH|OWNER_ALPHA_CREDENTIAL_SOCKET_DIR|OWNER_ALPHA_STATE_VOLUME|OWNER_ALPHA_STATE_PROFILE|OWNER_ALPHA_UID|OWNER_ALPHA_GID|OWNER_ALPHA_TMPFS_SIZE|OWNER_ALPHA_RUNTIME_TMPFS_SIZE) ;;
      *) fail "env file contains unsupported key $key" ;;
    esac
    [[ ! ${OPERATOR_VALUES[$key]+present} ]] || fail "env file defines $key more than once"
    [[ -n "$value" && "$value" != ' '* && "$value" != *' ' && "$value" != *$'\t'* ]] \
      || fail "env file value for $key is empty or has surrounding whitespace"
    local forbidden
    for forbidden in '$' '#' '`' '"' "'" "\\"; do
      [[ "$value" != *"$forbidden"* ]] || fail "env file value for $key must be literal and unquoted"
    done
    OPERATOR_VALUES[$key]="$value"
  done < "$ENV_FILE"

  local required
  for required in \
    OWNER_ALPHA_PROFILE \
    OWNER_ALPHA_IMAGE \
    OWNER_ALPHA_VAULT_PATH \
    OWNER_ALPHA_CONFIG_PATH \
    OWNER_ALPHA_CREDENTIAL_SOCKET_DIR \
    OWNER_ALPHA_STATE_VOLUME \
    OWNER_ALPHA_STATE_PROFILE \
    OWNER_ALPHA_UID \
    OWNER_ALPHA_GID \
    OWNER_ALPHA_TMPFS_SIZE \
    OWNER_ALPHA_RUNTIME_TMPFS_SIZE; do
    [[ ${OPERATOR_VALUES[$required]+present} ]] || fail "env file is missing $required"
  done
}

validate_operator_values() {
  PROFILE="${OPERATOR_VALUES[OWNER_ALPHA_PROFILE]}"
  case "$PROFILE" in
    rootless)
      SERVICE='owner-alpha-rootless'
      INIT_SERVICE='owner-alpha-state-init-rootless'
      SELECTED_UID="$(id -u)"
      SELECTED_GID="$(id -g)"
      ;;
    rootful)
      SERVICE='owner-alpha-rootful'
      INIT_SERVICE='owner-alpha-state-init-rootful'
      require_uint "${OPERATOR_VALUES[OWNER_ALPHA_UID]}" 'OWNER_ALPHA_UID'
      require_uint "${OPERATOR_VALUES[OWNER_ALPHA_GID]}" 'OWNER_ALPHA_GID'
      [[ "${OPERATOR_VALUES[OWNER_ALPHA_UID]}" != '0' ]] || fail 'rootful OWNER_ALPHA_UID must be nonzero'
      SELECTED_UID="${OPERATOR_VALUES[OWNER_ALPHA_UID]}"
      SELECTED_GID="${OPERATOR_VALUES[OWNER_ALPHA_GID]}"
      ;;
    *) fail 'OWNER_ALPHA_PROFILE must be exactly rootless or rootful' ;;
  esac

  if [[ -n "${OWNER_ALPHA_EXPECTED_PROFILE:-}" && "$PROFILE" != "$OWNER_ALPHA_EXPECTED_PROFILE" ]]; then
    fail 'selected profile does not match this management service'
  fi

  [[ "${OPERATOR_VALUES[OWNER_ALPHA_IMAGE]}" =~ ^sha256:[a-f0-9]{64}$ \
    || "${OPERATOR_VALUES[OWNER_ALPHA_IMAGE]}" =~ ^[a-z0-9][a-z0-9._/:+-]*@sha256:[a-f0-9]{64}$ ]] \
    || fail 'OWNER_ALPHA_IMAGE must be one local image ID or immutable repository digest'
  [[ "${OPERATOR_VALUES[OWNER_ALPHA_STATE_VOLUME]}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
    || fail 'OWNER_ALPHA_STATE_VOLUME is invalid'
  [[ "${OPERATOR_VALUES[OWNER_ALPHA_STATE_PROFILE]}" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] \
    || fail 'OWNER_ALPHA_STATE_PROFILE is invalid'
  require_uint "${OPERATOR_VALUES[OWNER_ALPHA_UID]}" 'OWNER_ALPHA_UID'
  require_uint "${OPERATOR_VALUES[OWNER_ALPHA_GID]}" 'OWNER_ALPHA_GID'
  [[ "${OPERATOR_VALUES[OWNER_ALPHA_TMPFS_SIZE]}" =~ ^[1-9][0-9]*[bBkKmMgG]?$ ]] \
    || fail 'OWNER_ALPHA_TMPFS_SIZE is invalid'
  [[ "${OPERATOR_VALUES[OWNER_ALPHA_RUNTIME_TMPFS_SIZE]}" =~ ^[1-9][0-9]*[bBkKmMgG]?$ ]] \
    || fail 'OWNER_ALPHA_RUNTIME_TMPFS_SIZE is invalid'
}

validate_local_engine() {
  local variable context endpoint os_type security
  for variable in DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES; do
    [[ ! ${!variable+x} ]] || fail "$variable must not override the local deployment engine"
  done
  context="$(docker context show 2>/dev/null)" || fail 'Docker context could not be inspected'
  [[ -n "$context" ]] || fail 'Docker context is empty'
  endpoint="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$context" 2>/dev/null)" \
    || fail 'Docker endpoint could not be inspected'
  [[ "$endpoint" == unix://* ]] || fail 'Docker must use one local Unix-socket engine endpoint'
  os_type="$(docker info --format '{{.OSType}}' 2>/dev/null)" || fail 'Docker daemon could not be inspected'
  [[ "$os_type" == 'linux' ]] || fail 'Docker daemon must be a Linux engine'
  security="$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null)" \
    || fail 'Docker security options could not be inspected'
  case "$PROFILE" in
    rootless) [[ "$security" == *'name=rootless'* ]] || fail 'rootless profile requires a rootless Docker daemon' ;;
    rootful) [[ "$security" != *'name=rootless'* ]] || fail 'rootful profile requires a rootful Docker daemon' ;;
  esac
  docker image inspect "${OPERATOR_VALUES[OWNER_ALPHA_IMAGE]}" >/dev/null 2>&1 \
    || fail 'the immutable owner-alpha image is not present in the selected local engine'
}

validate_bind_sources() {
  local vault config credentials socket config_mode socket_mode
  vault="${OPERATOR_VALUES[OWNER_ALPHA_VAULT_PATH]}"
  config="${OPERATOR_VALUES[OWNER_ALPHA_CONFIG_PATH]}"
  credentials="${OPERATOR_VALUES[OWNER_ALPHA_CREDENTIAL_SOCKET_DIR]}"
  socket="$credentials/helper.sock"

  [[ "$vault" == /* && "$config" == /* && "$credentials" == /* ]] \
    || fail 'vault, config, and credential socket directory must use absolute paths'
  require_real_directory "$vault" 'vault path'
  require_real_file "$config" 'source config path'
  require_real_directory "$credentials" 'credential socket directory'
  [[ -S "$socket" && ! -L "$socket" ]] || fail 'credential socket directory must contain one real helper.sock socket'
  [[ "$(realpath -e -- "$socket")" == "$socket" ]] || fail 'credential helper socket must not use symlink aliases'
  if find "$credentials" -mindepth 1 -maxdepth 1 ! -name 'helper.sock' -print -quit | grep -q .; then
    fail 'credential socket directory must contain only helper.sock'
  fi

  require_exact_owner "$vault" "$SELECTED_UID" "$SELECTED_GID" 'vault path'
  require_exact_owner "$config" "$SELECTED_UID" "$SELECTED_GID" 'source config path'
  require_exact_owner "$credentials" "$SELECTED_UID" "$SELECTED_GID" 'credential socket directory'
  require_exact_owner "$socket" "$SELECTED_UID" "$SELECTED_GID" 'credential helper socket'
  config_mode="$(file_mode_decimal "$config")"
  (( config_mode == 0600 )) || fail 'source config must have mode 0600'
  socket_mode="$(file_mode_decimal "$socket")"
  (( (socket_mode & 007) == 0 )) || fail 'credential helper socket must not be accessible by other users'
}

[[ -n "$COMMAND" ]] || usage
[[ "$COMPOSE_FILE" == /* && "$ENV_FILE" == /* ]] || fail 'Compose and env files must use absolute paths'
require_real_file "$COMPOSE_FILE" 'Compose file'
require_real_file "$ENV_FILE" 'operator env file'
[[ "$(stat -c '%u' -- "$COMPOSE_FILE")" == "$(id -u)" ]] || fail 'Compose file must be owned by the management user'
[[ "$(stat -c '%u' -- "$ENV_FILE")" == "$(id -u)" ]] || fail 'operator env file must be owned by the management user'
compose_mode="$(file_mode_decimal "$COMPOSE_FILE")"
env_mode="$(file_mode_decimal "$ENV_FILE")"
(( (compose_mode & 022) == 0 )) || fail 'Compose file must not be group- or other-writable'
(( env_mode == 0600 )) || fail 'operator env file must have mode 0600'
command -v docker >/dev/null 2>&1 || fail 'docker CLI is unavailable'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose plugin is unavailable'
for ambient in \
  OWNER_ALPHA_PROFILE \
  OWNER_ALPHA_IMAGE \
  OWNER_ALPHA_VAULT_PATH \
  OWNER_ALPHA_CONFIG_PATH \
  OWNER_ALPHA_CREDENTIAL_SOCKET_DIR \
  OWNER_ALPHA_STATE_VOLUME \
  OWNER_ALPHA_STATE_PROFILE \
  OWNER_ALPHA_UID \
  OWNER_ALPHA_GID \
  OWNER_ALPHA_TMPFS_SIZE \
  OWNER_ALPHA_RUNTIME_TMPFS_SIZE; do
  [[ ! ${!ambient+x} ]] || fail "$ambient must be defined only in the operator env file"
done
read_operator_environment
validate_operator_values

COMPOSE=(
  docker compose
  --file "$COMPOSE_FILE"
  --env-file "$ENV_FILE"
  --profile "$PROFILE"
)

# Quiet expansion catches missing variables and malformed mounts without printing
# the fully expanded operator configuration into a terminal or journal.
"${COMPOSE[@]}" config --quiet

case "$COMMAND" in
  validate)
    validate_local_engine
    validate_bind_sources
    ;;
  init)
    validate_local_engine
    # The networkless one-shot service only prepares or validates the named state
    # volume. It has no vault, config, credential, or host-network mount.
    "${COMPOSE[@]}" run --rm --no-deps --pull never "$INIT_SERVICE"
    ;;
  start)
    validate_local_engine
    validate_bind_sources
    # Detached Compose is the always-on path. Container output is neither
    # attached nor retained by the engine; --wait observes only health status.
    "${COMPOSE[@]}" up --detach --no-build --pull never --wait "$SERVICE"
    ;;
  restart)
    validate_local_engine
    validate_bind_sources
    # Replacement revokes process-memory sessions and capabilities. Durable jobs
    # remain in the profile-bound volume and readiness waits for recovery.
    "${COMPOSE[@]}" up --detach --no-build --pull never --force-recreate --wait "$SERVICE"
    ;;
  stop)
    validate_local_engine
    "${COMPOSE[@]}" stop --timeout 30 "$SERVICE"
    ;;
  status)
    validate_local_engine
    "${COMPOSE[@]}" ps "$SERVICE"
    ;;
  attach)
    validate_local_engine
    printf '%s\n' 'Attached output is live only. Detach without stopping the service using Ctrl-p Ctrl-q.' >&2
    exec "${COMPOSE[@]}" attach --sig-proxy=false "$SERVICE"
    ;;
  bootstrap)
    validate_local_engine
    printf '%s\n' \
      'Attaching to the live owner-alpha terminal.' \
      "Enter b and press Enter to replace the one-time bootstrap capability." \
      'Detach without stopping the service using Ctrl-p Ctrl-q.' >&2
    exec "${COMPOSE[@]}" attach --sig-proxy=false "$SERVICE"
    ;;
  *) usage ;;
esac
