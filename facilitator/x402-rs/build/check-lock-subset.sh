#!/bin/sh
# Usage: check-lock-subset.sh UPSTREAM_LOCK PRUNED_LOCK [ADDITIONS]
# Fails unless every package (name, version, source, checksum) in the pruned lock is in the upstream lock
# or in ADDITIONS (Cargo.lock entries the build adds on purpose: build/lock-additions.txt), i.e. trimming
# the workspace removed packages, every package upstream locked kept its version and checksum, and
# nothing was added that is not listed.
set -eu
pkgs() {
  awk '/^\[\[package\]\]/ { if (p != "") print p; p = "" }
       /^(name|version|source|checksum) = / { p = p " " $0 }
       END { if (p != "") print p }' "$1" | sort -u
}
pkgs "$1" > /tmp/lock.upstream
pkgs "$2" > /tmp/lock.pruned
if [ "$#" -ge 3 ]; then pkgs "$3"; fi > /tmp/lock.additions
sort -u /tmp/lock.upstream /tmp/lock.additions > /tmp/lock.allowed
extra=$(comm -13 /tmp/lock.allowed /tmp/lock.pruned)
if [ -n "$extra" ]; then
  echo "Cargo.lock drift: packages in neither the upstream lock nor the additions:" >&2
  echo "$extra" >&2
  exit 1
fi
kept=$(comm -12 /tmp/lock.upstream /tmp/lock.pruned | wc -l)
added=$(comm -13 /tmp/lock.upstream /tmp/lock.pruned | wc -l)
echo "Cargo.lock: $kept of $(wc -l < /tmp/lock.upstream) upstream packages kept, none changed; $added added, all listed in the additions"
