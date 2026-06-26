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

  exec gosu node "$@"
fi

exec "$@"
