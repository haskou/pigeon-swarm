#!/usr/bin/env bash
# Writes heavy=false to $GITHUB_OUTPUT only when every changed file is
# documentation: Markdown outside .github/, or an image under docs/. Any other
# change (code, tests, JSON contracts, workflows, actions) writes heavy=true.
# Pushes to main, other events, unresolvable commits and empty diffs also write
# heavy=true, so an unclear decision never skips a check. A successful run on
# main is what lets publish-docker.yml publish the pinned pair.
set -uo pipefail

decide() {
  printf 'heavy=%s\n' "$1" >> "$GITHUB_OUTPUT"
  printf 'Heavy CI jobs: %s (%s)\n' "$1" "$2"
  exit 0
}

is_documentation() {
  case "$1" in
    .github/*) return 1 ;;
    *.md) return 0 ;;
    docs/*.png | docs/*.jpg | docs/*.jpeg | docs/*.gif | docs/*.webp | docs/*.svg) return 0 ;;
    *) return 1 ;;
  esac
}

case "${EVENT_NAME:-}" in
  pull_request) diff_args=("${PULL_REQUEST_BASE_SHA:-}...${PULL_REQUEST_HEAD_SHA:-}") ;;
  push)
    if [[ "${PUSH_REF:-}" == "refs/heads/main" ]]; then
      decide true "a push to main publishes the image, so it runs every job"
    fi
    diff_args=("${PUSH_BEFORE:-}" "${PUSH_AFTER:-}")
    ;;
  *) decide true "event '${EVENT_NAME:-}' runs every job" ;;
esac

if ! changed="$(git diff --name-only --no-renames "${diff_args[@]}")"; then
  decide true "cannot diff the changed commits"
fi

if [[ -z "$changed" ]]; then
  decide true "no changed files"
fi

while IFS= read -r path; do
  if ! is_documentation "$path"; then
    decide true "$path is not documentation"
  fi
done <<< "$changed"

decide false "only documentation changed"
