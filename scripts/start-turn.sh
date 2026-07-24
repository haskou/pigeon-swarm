#!/bin/sh
set -eu

readonly config_path='/run/pigeon-turn/turnserver.conf'
readonly default_shared_secret='Kestrel7-Quartz9-Pigeon4-Nebula8-Harbor2-Cipher6-Orbit5-Velvet3'

if [ -z "${CALLS_TURN_SHARED_SECRET:-}" ]; then
  CALLS_TURN_SHARED_SECRET="$default_shared_secret"
  export CALLS_TURN_SHARED_SECRET
fi

if [ "$CALLS_TURN_SHARED_SECRET" = "$default_shared_secret" ]; then
  echo 'WARNING: TURN is using the built-in shared secret. Set CALLS_TURN_SHARED_SECRET to the same custom value on every backend and coturn service in the relay pool.' >&2
fi

external_ip="${CALLS_TURN_EXTERNAL_IP:-$(detect-external-ip)}"

umask 077
printf 'static-auth-secret=%s\n' "$CALLS_TURN_SHARED_SECRET" > "$config_path"

unset CALLS_TURN_SHARED_SECRET

exec turnserver \
  -c "$config_path" \
  --external-ip="$external_ip" \
  "$@"
