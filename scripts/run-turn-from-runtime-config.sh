#!/bin/sh
set -eu

readonly runtime_config_path='/run/pigeon/calls-turn-runtime.conf'
readonly turn_config_path='/run/pigeon-turn/turnserver.conf'
readonly public_bootstrap_secret='Kestrel7-Quartz9-Pigeon4-Nebula8-Harbor2-Cipher6-Orbit5-Velvet3'

turn_pid=''
last_signature=''

read_setting() {
  setting_name="$1"

  awk -F= -v setting_name="$setting_name" \
    '$1 == setting_name { print $2; exit }' "$runtime_config_path"
}

is_port() {
  case "$1" in
    '' | *[!0-9]*)
      return 1
      ;;
  esac

  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

is_ipv4_mapping() {
  printf '%s\n' "$1" | awk '
    NR != 1 { invalid=1 }
    {
      count=split($0, addresses, "/")
      if (count < 1 || count > 2) invalid=1
      for (i=1; i<=count; i++) {
        if (split(addresses[i], octets, ".") != 4) invalid=1
        for (j=1; j<=4; j++) {
          if (octets[j] !~ /^[0-9]+$/ || length(octets[j]) > 3 ||
              octets[j]+0 > 255 || (length(octets[j]) > 1 && substr(octets[j],1,1) == "0")) invalid=1
        }
      }
    }
    END { exit invalid || NR != 1 }'
}

stop_turn() {
  if [ -z "$turn_pid" ]; then
    return
  fi

  kill "$turn_pid" 2>/dev/null || true
  wait "$turn_pid" 2>/dev/null || true
  turn_pid=''
}

start_turn() {
  listening_port="$1"
  relay_port_start="$2"
  relay_port_end="$3"
  shift 3
  external_ip="${CALLS_TURN_EXTERNAL_IP:-}"
  if [ -z "$external_ip" ]; then
    external_ip="$(detect-external-ip)"
  fi
  if ! is_ipv4_mapping "$external_ip"; then
    echo 'TURN external IPv4 detection failed; configure CALLS_TURN_EXTERNAL_IP explicitly.' >&2
    exit 1
  fi

  if [ "${CALLS_TURN_TLS_ENABLED:-false}" = true ]; then
    tls_port="${CALLS_TURN_TLS_PORT:-5349}"
    if ! is_port "$tls_port" || [ "$tls_port" -eq "$listening_port" ] ||
      { [ "$tls_port" -ge "$relay_port_start" ] && [ "$tls_port" -le "$relay_port_end" ]; }; then
      echo 'TURN TLS port must be valid and outside the plain listener and relay range.' >&2
      exit 1
    fi
    set -- "$@" --tls-listening-port="$tls_port" \
      --cert=/run/pigeon-turn-tls/fullchain.pem --pkey=/run/pigeon-turn-tls/privkey.pem
  else
    set -- "$@" --no-tls
  fi

  echo "Starting TURN from persisted node configuration: listeningPort=$listening_port relayPortStart=$relay_port_start relayPortEnd=$relay_port_end" >&2

  turnserver \
    -c "$turn_config_path" \
    --external-ip="$external_ip" \
    --listening-port="$listening_port" \
    --min-port="$relay_port_start" \
    --max-port="$relay_port_end" \
    "$@" &
  turn_pid="$!"
}

reload_runtime_configuration() {
  stop_turn

  if [ ! -f "$runtime_config_path" ]; then
    echo 'Waiting for persisted node TURN configuration.' >&2
    return
  fi

  enabled="$(read_setting enabled)"

  if [ "$enabled" != 'true' ]; then
    echo 'TURN disabled by persisted node configuration.' >&2
    return
  fi

  listening_port="$(read_setting listening_port)"
  relay_port_start="$(read_setting relay_port_start)"
  relay_port_end="$(read_setting relay_port_end)"

  if ! is_port "$listening_port" ||
    ! is_port "$relay_port_start" ||
    ! is_port "$relay_port_end" ||
    [ "$relay_port_end" -lt "$relay_port_start" ]; then
    echo 'Persisted node TURN configuration contains an invalid port range.' >&2
    return
  fi

  start_turn "$listening_port" "$relay_port_start" "$relay_port_end" "$@"
}

shared_secret="${CALLS_TURN_SHARED_SECRET:-}"
valid_secret=true
case "$shared_secret" in
  '' | *[!a-zA-Z0-9_/+=-]*) valid_secret=false ;;
esac

if [ "$valid_secret" != true ] ||
  [ "${#shared_secret}" -lt 32 ] ||
  [ "${#shared_secret}" -gt 256 ] ||
  [ "$shared_secret" = "$public_bootstrap_secret" ]; then
  echo 'CALLS_TURN_SHARED_SECRET must be a private deployment secret of 32-256 base64/hex-compatible characters. The public fallback is rejected. Configure the same value on its backend credential issuer and coturn.' >&2
  exit 1
fi

if [ -n "${CALLS_TURN_EXTERNAL_IP:-}" ] && ! is_ipv4_mapping "$CALLS_TURN_EXTERNAL_IP"; then
  echo 'CALLS_TURN_EXTERNAL_IP must be an IPv4 address or public/private IPv4 mapping.' >&2
  exit 1
fi

case "${CALLS_TURN_TLS_ENABLED:-false}" in
  true)
    tls_port="${CALLS_TURN_TLS_PORT:-5349}"
    web_port="${PIGEON_WEB_HOST_PORT:-8080}"
    if is_port "$tls_port" &&
      { [ "$tls_port" -eq 8080 ] || { is_port "$web_port" && [ "$tls_port" -eq "$web_port" ]; }; }; then
      echo 'TURN TLS port conflicts with the internal or published web listener.' >&2
      exit 1
    fi
    if [ ! -r /run/pigeon-turn-tls/fullchain.pem ] || [ ! -s /run/pigeon-turn-tls/fullchain.pem ] ||
      [ ! -r /run/pigeon-turn-tls/privkey.pem ] || [ ! -s /run/pigeon-turn-tls/privkey.pem ]; then
      echo 'TURN TLS requires readable fullchain.pem and privkey.pem in /run/pigeon-turn-tls.' >&2
      exit 1
    fi
    ;;
  false) ;;
  *) echo 'CALLS_TURN_TLS_ENABLED must be true or false.' >&2; exit 1 ;;
esac

umask 077
secret_config="$(mktemp "${turn_config_path}.XXXXXX")"
printf 'static-auth-secret=%s\n' "$shared_secret" > "$secret_config"
mv "$secret_config" "$turn_config_path"
unset shared_secret CALLS_TURN_SHARED_SECRET

trap 'stop_turn; exit 0' INT TERM

while true; do
  signature="$(
    if [ -f "$runtime_config_path" ]; then
      cksum "$runtime_config_path"
    else
      printf missing
    fi
  )"

  if [ "$signature" != "$last_signature" ]; then
    last_signature="$signature"
    reload_runtime_configuration "$@"
  fi

  if [ -n "$turn_pid" ] && ! kill -0 "$turn_pid" 2>/dev/null; then
    status=0
    wait "$turn_pid" || status="$?"
    echo "TURN stopped unexpectedly: status=$status" >&2
    exit 1
  fi

  sleep 2
done
