#!/bin/sh
# Run a command with a throwaway /opt/cyberbaser and no network, as the
# calling user, without changing the host: a private user, mount and network
# namespace mounts a tmpfs over /opt, binds the prepared app root (and the
# optional Quartz seed) there, brings loopback up, then drops back to the
# caller's own uid in a nested user namespace.
#
#   in-namespace.sh <app-root-dir> <seed-dir or -> <uid> <gid> -- <command> [args...]
set -eu
if [ "${CYBERBASER_IN_NAMESPACE:-}" != 1 ]; then
  export CYBERBASER_IN_NAMESPACE=1
  exec unshare --user --map-root-user --mount --net -- "$0" "$@"
fi
root="$1"; seed="$2"; uid="$3"; gid="$4"; shift 5
mount -t tmpfs -o mode=0755 tmpfs /opt
mkdir /opt/cyberbaser
mount --bind "$root" /opt/cyberbaser
if [ "$seed" != - ]; then mount --bind "$seed" /opt/cyberbaser/vendor/quartz; fi
ip link set lo up
exec unshare --user --map-user="$uid" --map-group="$gid" -- "$@"
