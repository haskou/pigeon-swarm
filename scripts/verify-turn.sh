#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

for _attempt in $(seq 1 15); do
  if docker compose exec -T turn sh -lc \
    'pidof turnserver >/dev/null 2>&1 && /opt/pigeon/check-turn-runtime.sh'; then
    break
  fi
  sleep 2
done

docker compose exec -T turn sh -lc '
  set -eu
  test "$(stat -c "%a" /run/pigeon-turn/turnserver.conf)" = 600 || {
    echo "TURN secret configuration must have mode 600." >&2
    exit 1
  }
  for comm in /proc/[0-9]*/comm; do
    if [ "$(cat "$comm" 2>/dev/null || true)" = turnserver ]; then
      pid="${comm#/proc/}"
      pid="${pid%/comm}"
      command_line="$(tr "\0" "\n" < "/proc/$pid/cmdline")"
      environment="$(tr "\0" "\n" < "/proc/$pid/environ")"
      case "$command_line$environment" in
        *"$CALLS_TURN_SHARED_SECRET"*)
          echo "TURN secret is exposed in the turnserver process." >&2
          exit 1
          ;;
      esac
      exit 0
    fi
  done
  echo "The turnserver process is not running." >&2
  exit 1
'

# The app shares coturn's network namespace and already holds the issuer secret.
# Send source through stdin; never pass secrets or credentials as CLI arguments.
docker compose exec -T app node --input-type=module < "$script_dir/turn-allocation-probe.mjs"
