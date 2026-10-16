#!/usr/bin/env bash
# Replaces Git LFS pointer files in a (sparse, blobless) checkout with the real objects, fetched
# from media.githubusercontent.com at a pinned commit and verified against the pointer's sha256.
# (`git lfs pull` is too slow through the sandbox proxy.)
# Usage: lfs-fetch.sh <repo-dir> <owner/repo> <commit> <path-prefix>...
set -euo pipefail
dir=$1; slug=$2; rev=$3; shift 3
cd "$dir"
for prefix in "$@"; do
  git ls-files -- "$prefix" | while IFS= read -r f; do
    [ -f "$f" ] || continue
    head -c 40 "$f" | grep -q '^version https://git-lfs' || continue
    oid=$(sed -n 's/^oid sha256:\(.*\)$/\1/p' "$f")
    url="https://media.githubusercontent.com/media/$slug/$rev/$(python3 -I -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$f")"
    tmp="$f.lfs-tmp"
    curl -sSfL --max-time 120 -o "$tmp" "$url"
    got=$(sha256sum "$tmp" | cut -d' ' -f1)
    if [ "$got" != "$oid" ]; then echo "sha mismatch: $f" >&2; rm -f "$tmp"; exit 1; fi
    mv "$tmp" "$f"
    echo "fetched $f"
  done
done
