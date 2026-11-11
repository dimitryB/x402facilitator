#!/bin/sh
# Usage: check-lock-subset.sh UPSTREAM_LOCK LOCK ALLOWED...
# Fails unless every package (name, version, source, checksum) in LOCK is in UPSTREAM_LOCK or in one of
# the ALLOWED files (Cargo.lock entries the build has on purpose: build/lock-additions.txt, the packages
# the Bitcoin crate adds, and build/lock-upgrades.txt, the security upgrades). So pruning the workspace
# removed packages, every other package keeps the version and checksum upstream locked, and nothing is
# there that is not listed.
set -eu
pkgs() {
  awk '/^\[\[package\]\]/ { if (p != "") print p; p = "" }
       /^(name|version|source|checksum) = / { p = p " " $0 }
       END { if (p != "") print p }' "$@" | sort -u
}
upstream=$1 lock=$2
shift 2
pkgs "$upstream" > /tmp/lock.upstream
pkgs "$lock" > /tmp/lock.used
if [ "$#" -gt 0 ]; then pkgs "$@"; fi > /tmp/lock.listed
sort -u /tmp/lock.upstream /tmp/lock.listed > /tmp/lock.allowed
extra=$(comm -13 /tmp/lock.allowed /tmp/lock.used)
if [ -n "$extra" ]; then
  echo "Cargo.lock drift: packages in neither the upstream lock nor the listed files:" >&2
  echo "$extra" >&2
  exit 1
fi
kept=$(comm -12 /tmp/lock.upstream /tmp/lock.used | wc -l)
listed=$(comm -13 /tmp/lock.upstream /tmp/lock.used | wc -l)
echo "Cargo.lock: $kept packages as upstream locked them (of $(wc -l < /tmp/lock.upstream)); $listed others, all listed in $*"
