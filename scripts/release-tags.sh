#!/usr/bin/env bash
set -euo pipefail

ref="${1:?release ref is required, for example v1.2.3}"
engine="${2:?engine is required: docker or podman}"
image="${3:?image name is required}"
commit="${4:-${GITHUB_SHA:-local}}"

case "$engine" in
  docker) suffix="" ;;
  podman) suffix="-podman" ;;
  *) echo "unsupported engine: $engine" >&2; exit 2 ;;
esac

if [[ ! "$ref" =~ ^v((0|[1-9][0-9]*)\.){2}(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  echo "invalid SemVer release tag: $ref" >&2
  exit 1
fi

version="${ref#v}"
stable=true
if [[ "$version" == *-* ]]; then
  stable=false
fi

major="${version%%.*}"
rest="${version#*.}"
minor="${rest%%.*}"
patch="${rest#*.}"
patch="${patch%%-*}"

printf '%s:%s%s\n' "$image" "$version" "$suffix"
printf '%s:sha-%s%s\n' "$image" "$commit" "$suffix"

if [[ "$stable" == true ]]; then
  printf '%s:%s.%s%s\n' "$image" "$major" "$minor" "$suffix"
  printf '%s:%s%s\n' "$image" "$major" "$suffix"
  printf '%s:latest%s\n' "$image" "$suffix"
fi
