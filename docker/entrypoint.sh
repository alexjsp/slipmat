#!/bin/sh
set -eu

# Started as root, which is Docker's default: hand /data to the user we are
# about to become, then drop privileges for good. A bind mount shadows the
# image's own /data, so a host directory Docker created for us arrives owned by
# root, and SQLite then cannot open the database. PUID/PGID follow the
# linuxserver.io convention, so Unraid's 99:100 works as-is.
#
# Started as someone else (`--user`, `user:` in Compose), there is nothing to
# drop and no right to chown; the caller owns /data.
if [ "$(id -u)" = 0 ]; then
  PUID="${PUID:-10001}"
  PGID="${PGID:-10001}"
  if [ "$(stat -c %u:%g /data)" != "${PUID}:${PGID}" ]; then
    chown -R "${PUID}:${PGID}" /data
  fi
  exec setpriv --reuid="${PUID}" --regid="${PGID}" --clear-groups -- "$@"
fi

exec "$@"
