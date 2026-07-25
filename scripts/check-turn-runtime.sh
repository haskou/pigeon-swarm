#!/bin/sh
set -eu

readonly runtime_config_path='/run/pigeon/calls-turn-runtime.conf'

if [ ! -f "$runtime_config_path" ]; then
  exit 0
fi

read_setting() {
  setting_name="$1"

  awk -F= -v setting_name="$setting_name" \
    '$1 == setting_name { print $2; exit }' "$runtime_config_path"
}

if [ "$(read_setting enabled)" != 'true' ]; then
  exit 0
fi

listening_port="$(read_setting listening_port)"

turnutils_stunclient -p "$listening_port" 127.0.0.1 >/dev/null 2>&1
