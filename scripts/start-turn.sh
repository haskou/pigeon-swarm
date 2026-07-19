#!/bin/sh
set -eu

readonly config_path='/run/pigeon-turn/turnserver.conf'

if [ -z "${CALLS_TURN_SHARED_SECRET:-}" ]; then
  echo 'CALLS_TURN_SHARED_SECRET is required.' >&2
  exit 1
fi

external_ip="${CALLS_TURN_EXTERNAL_IP:-$(detect-external-ip)}"

umask 077
printf 'static-auth-secret=%s\n' "$CALLS_TURN_SHARED_SECRET" > "$config_path"

unset CALLS_TURN_SHARED_SECRET

exec turnserver \
  -c "$config_path" \
  --external-ip="$external_ip" \
  "$@"
