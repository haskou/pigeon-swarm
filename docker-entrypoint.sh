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

  exec gosu node /usr/local/bin/docker-entrypoint.sh "$@"
fi

node /usr/local/lib/pigeon/prepare-turn-secret.cjs /data/local_storage/turn-shared-secret /run/pigeon/turn-shared-secret
CALLS_TURN_SHARED_SECRET="$(cat /run/pigeon/turn-shared-secret)"
export CALLS_TURN_SHARED_SECRET

exec "$@"
