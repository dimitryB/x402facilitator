#!/usr/bin/env bash
# Make a fresh private key and write it into .env under one or more names. Prints only the address.
# The key never reaches the terminal or a command line, and the only file it is written to is .env.
#
#   scripts/new-key.sh DEPLOYER_PRIVATE_KEY FACILITATOR_MAINNET_PRIVATE_KEY
#
# Names must end in _PRIVATE_KEY. A name that .env lacks is appended; a name that is present but
# empty (as .env.example leaves them) is filled in place. If any name already has a value the script
# refuses and writes nothing, so it can never overwrite a key that may hold funds. To replace a key,
# delete its line by hand first. It also refuses if the file is a symlink, or if a line mentions a
# name in a form it cannot parse, since that line might hold a key the loaders would still read.
#
# .env stays mode 600 and is the only copy of the key: back it up before funding the address.
# NEW_KEY_ENV_FILE points the script at another file (tests use a scratch copy).
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${NEW_KEY_ENV_FILE:-$PWD/.env}

die() { printf 'new-key: %s\n' "$*" >&2; exit 1; }

[ $# -gt 0 ] || die "usage: scripts/new-key.sh NAME_PRIVATE_KEY [NAME_PRIVATE_KEY ...]"
NAMES=("$@")
seen=" "
for n in "${NAMES[@]}"; do
  [[ $n =~ ^[A-Z][A-Z0-9_]*_PRIVATE_KEY$ ]] || die "$n: names must be upper case and end in _PRIVATE_KEY"
  case $seen in *" $n "*) die "$n is listed twice" ;; esac
  seen="$seen$n "
done
command -v cast >/dev/null || die "cast not found (install Foundry)"

# NAME=value, optionally indented, prefixed with export, or with spaces around "=" (Node's env-file
# loader and docker compose read all of these). Comment lines don't match.
ASSIGN='^([[:space:]]*(export[[:space:]]+)?)([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$'
wanted() { case $seen in *" $1 "*) return 0 ;; esac; return 1; }
is_empty() { local v=${1//[[:space:]]/}; [ -z "$v" ] || [ "$v" = '""' ] || [ "$v" = "''" ]; }

# mv would replace a symlink with a plain file and leave the key out of the file it points to.
[ -L "$ENV_FILE" ] && die "$ENV_FILE is a symlink; nothing written (point NEW_KEY_ENV_FILE at the file itself)"

if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line =~ $ASSIGN ]]; then
      name=${BASH_REMATCH[3]} value=${BASH_REMATCH[4]}
      if wanted "$name" && ! is_empty "$value"; then
        die "$name already has a value in $ENV_FILE; nothing written (delete that line by hand to replace it)"
      fi
      continue
    fi
    # Any other non-comment line that mentions a wanted name (NAME: value, for one) may hold a key
    # that a loader reads but this script can't see. Refuse rather than guess.
    [[ $line =~ ^[[:space:]]*# ]] && continue
    for n in "${NAMES[@]}"; do
      case $line in *"$n"*) die "$ENV_FILE has a line for $n that this script cannot parse; nothing written (fix it by hand)" ;; esac
    done
  done < "$ENV_FILE"
fi

# With stdout not a terminal, cast prints "address<TAB>key" on stdout and the readable form, key
# included, on stderr. Discard stderr; anything but exactly those two fields stops the script.
out=$(cast wallet new 2>/dev/null) || die "cast wallet new failed; nothing written"
set -f; set -- $out; set +f
out=
if [ $# -ne 2 ] || ! [[ $1 =~ ^0x[0-9a-fA-F]{40}$ ]] || ! [[ $2 =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  set --
  die "unexpected output from cast wallet new (not shown); nothing written"
fi
ADDR=$1 KEY=$2
set --

umask 077
tmp=$(mktemp "$(dirname "$ENV_FILE")/.env.new.XXXXXX")
trap 'rm -f "$tmp"' EXIT

filled=" "
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line =~ $ASSIGN ]] && wanted "${BASH_REMATCH[3]}"; then
      printf '%s%s=%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}" "$KEY"
      filled="$filled${BASH_REMATCH[3]} "
    else
      printf '%s\n' "$line"
    fi
  done < "$ENV_FILE" > "$tmp"
fi
added=0
for n in "${NAMES[@]}"; do
  case $filled in *" $n "*) continue ;; esac
  if [ $added -eq 0 ]; then
    [ -s "$tmp" ] && printf '\n'
    printf '# Added by scripts/new-key.sh on %s. Address: %s\n' "$(date -u +%F)" "$ADDR"
  fi
  added=1
  printf '%s=%s\n' "$n" "$KEY"
done >> "$tmp"

# Read the new file back before it replaces .env: every name must hold this key.
for n in "${NAMES[@]}"; do
  count=0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ $ASSIGN ]] && [ "${BASH_REMATCH[3]}" = "$n" ] || continue
    [ "${BASH_REMATCH[4]}" = "$KEY" ] || die "check failed for $n; $ENV_FILE left unchanged"
    count=$((count + 1))
  done < "$tmp"
  [ $count -ge 1 ] || die "check failed for $n; $ENV_FILE left unchanged"
done
KEY=

chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"
trap - EXIT

printf 'new-key: wrote one new key to %s as %s\n' "$ENV_FILE" "${NAMES[*]}"
printf 'new-key: address %s\n' "$ADDR"
printf 'new-key: that file is the only copy of the key. Back it up before you fund the address.\n'
