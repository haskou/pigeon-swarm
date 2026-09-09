#!/bin/sh
set -eu

ensure_node_owned_directory() {
  directory="$1"

  mkdir -p "${directory}"

  owner="$(stat -c '%u:%g' "${directory}" 2>/dev/null || true)"

  if [ "${owner}" != "1000:1000" ]; then
    chown -R node:node "${directory}"
  fi
}

if [ "$(id -u)" = "0" ]; then
  ensure_node_owned_directory /app/logs
  ensure_node_owned_directory /data/ipfs
  ensure_node_owned_directory /data/local_storage
  ensure_node_owned_directory /run/pigeon
  ensure_node_owned_directory /run/pigeon-turn

  exec gosu node /usr/local/bin/docker-entrypoint.sh "$@"
fi

chmod 700 /run/pigeon-turn

node /usr/local/lib/pigeon/prepare-turn-secret.cjs /data/local_storage/turn-shared-secret /run/pigeon/turn-shared-secret
CALLS_TURN_SHARED_SECRET="$(cat /run/pigeon/turn-shared-secret)"
export CALLS_TURN_SHARED_SECRET

if [ "$#" = 2 ] && [ "$1" = node ] && [ "$2" = dist/index.js ]; then
  case "${PIGEON_TURN_MODE:-embedded}" in
    embedded) exec node /usr/local/lib/pigeon/supervise-runtime.cjs "$@" ;;
    external) ;;
    *) echo 'PIGEON_TURN_MODE must be embedded or external.' >&2; exit 1 ;;
  esac
fi

exec "$@"
