#!/bin/sh
set -eu

docker compose exec -T turn sh -lc '
  if [ "$(stat -c "%a" /run/pigeon-turn/turnserver.conf)" != "600" ]; then
    echo "TURN secret configuration does not have mode 600." >&2
    exit 1
  fi

  turn_pid=""

  for comm in /proc/[0-9]*/comm; do
    if [ "$(cat "$comm" 2>/dev/null || true)" = "turnserver" ]; then
      turn_pid="${comm#/proc/}"
      turn_pid="${turn_pid%/comm}"
      break
    fi
  done

  if [ -z "$turn_pid" ]; then
    echo "The turnserver process is not running." >&2
    exit 1
  fi

  command_line="$(tr "\0" "\n" < "/proc/$turn_pid/cmdline")"
  environment="$(tr "\0" "\n" < "/proc/$turn_pid/environ")"

  case "$command_line$environment" in
    *"$CALLS_TURN_SHARED_SECRET"*)
      echo "TURN secret is exposed in the turnserver process." >&2
      exit 1
      ;;
  esac
'

if ! output="$({
  docker compose exec -T turn sh -lc \
    'turnutils_uclient -v -Y alloc -n 1 -u smoke-test -W "$CALLS_TURN_SHARED_SECRET" -p "$CALLS_TURN_PORT" 127.0.0.1'
} 2>&1)"; then
  printf '%s\n' "$output"
  echo 'Authenticated TURN allocation failed.' >&2
  exit 1
fi

printf '%s\n' "$output"

if ! printf '%s\n' "$output" | grep -q 'Received relay addr:'; then
  echo 'Authenticated TURN allocation failed.' >&2
  exit 1
fi

invalid_result=0
invalid_output="$({
  docker compose exec -T -e TURN_TEST_SHARED_SECRET=invalid-test-secret \
    turn sh -lc \
    'turnutils_uclient -v -Y alloc -n 1 -u smoke-test -W "$TURN_TEST_SHARED_SECRET" -p "$CALLS_TURN_PORT" 127.0.0.1'
} 2>&1)" || invalid_result=$?

if [ "$invalid_result" -eq 0 ] || printf '%s\n' "$invalid_output" | grep -q 'Received relay addr:'; then
  printf '%s\n' "$invalid_output"
  echo 'TURN accepted credentials signed with the wrong secret.' >&2
  exit 1
fi

if ! printf '%s\n' "$invalid_output" | grep -q 'Cannot complete Allocation'; then
  printf '%s\n' "$invalid_output"
  echo 'TURN failed without proving that invalid credentials were rejected.' >&2
  exit 1
fi

echo 'TURN rejected credentials signed with the wrong secret.'
