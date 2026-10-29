#!/bin/sh
# Usage: check-lock-subset.sh UPSTREAM_LOCK PRUNED_LOCK
# Fails unless every package (name, version, source, checksum) in the pruned lock is in the upstream lock,
# i.e. trimming the workspace removed packages but changed or added none.
set -eu
pkgs() {
  awk '/^\[\[package\]\]/ { if (p != "") print p; p = "" }
       /^(name|version|source|checksum) = / { p = p " " $0 }
       END { if (p != "") print p }' "$1" | sort -u
}
pkgs "$1" > /tmp/lock.upstream
pkgs "$2" > /tmp/lock.pruned
extra=$(comm -13 /tmp/lock.upstream /tmp/lock.pruned)
if [ -n "$extra" ]; then
  echo "Cargo.lock drift: packages not in the upstream lock:" >&2
  echo "$extra" >&2
  exit 1
fi
echo "Cargo.lock: $(wc -l < /tmp/lock.pruned) of $(wc -l < /tmp/lock.upstream) upstream packages kept, none changed"
