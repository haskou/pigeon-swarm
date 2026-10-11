#!/bin/sh
# Copies one stopped Pigeon data directory into an existing, empty target and
# verifies that the copy matches the source.
#
# Usage: restore-copy.sh <source-dir> <target-dir>
#
# Stop the application that owns the source first. A running node can change
# files during the copy, and the result then matches neither state. Run as root
# to keep original owners and permissions; the application entrypoint corrects
# ownership of its data directories on start. The script never prints file
# contents.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: restore-copy.sh <source-dir> <target-dir>" >&2
  exit 2
fi

source_dir=$1
target_dir=$2

if [ ! -d "$source_dir" ]; then
  echo "restore-copy: source is not a directory" >&2
  exit 1
fi

if [ ! -d "$target_dir" ]; then
  echo "restore-copy: target must be an existing directory" >&2
  exit 1
fi

if [ -n "$(ls -A "$target_dir")" ]; then
  echo "restore-copy: target must be empty" >&2
  exit 1
fi

source_path=$(cd "$source_dir" && pwd -P)
target_path=$(cd "$target_dir" && pwd -P)
case "$target_path/" in
  "$source_path"/*)
    echo "restore-copy: target must not be inside source" >&2
    exit 1
    ;;
esac

cp -a "$source_dir/." "$target_dir/"
diff -rq "$source_dir" "$target_dir"
echo "restore-copy: copied and verified"
