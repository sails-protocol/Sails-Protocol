#!/usr/bin/env bash
# P51: import the VENDORED Bitcoin Core builder keys into the CURRENT $GNUPGHOME and prove the keyring is exactly the pinned one.
# Sourced by provenance-bitcoin-core.sh and by gpg-keys.check.sh (which runs early in the job, with no network).
#
# import_pinned_builder_keys <keys-dir> "<name sha256 lines>" "<space-separated pinned PRIMARY fingerprints>"
#   Fails (returns non-zero, message on stderr) unless ALL of this holds:
#     * for every pinned name, <keys-dir>/<name>.asc exists and its sha256 equals the pinned one (byte-for-byte equal to guix.sigs builder-keys);
#     * the directory holds exactly that many .asc files (no extra key can sneak in);
#     * every file holds exactly one primary key and its primary fingerprint is in the pinned list;
#     * the keyring that results holds exactly the pinned primary fingerprints, and the files map one-to-one onto them.
import_pinned_builder_keys() {
  local dir="$1" pins="$2" fps="$3"
  local name sha f got fp found want have want_sorted files_sorted file_fps="" n_pinned=0 n_present
  local -a present
  _keyfail() { echo "KEYS FAILED: $*" >&2; return 1; }
  [ -d "$dir" ] || { _keyfail "no key directory $dir"; return 1; }
  while read -r name sha; do
    [ -n "${name:-}" ] || continue
    n_pinned=$((n_pinned + 1))
    f="$dir/$name.asc"
    [ -f "$f" ] || { _keyfail "pinned key file missing: $f"; return 1; }
    got="$(sha256sum "$f" | awk '{print $1}')"
    [ "$got" = "$sha" ] || { _keyfail "key $name sha256 $got != pinned $sha"; return 1; }
  done <<< "$pins"
  shopt -s nullglob
  present=("$dir"/*.asc)
  n_present="${#present[@]}"
  [ "$n_present" -eq "$n_pinned" ] || { _keyfail "$dir holds $n_present .asc files, expected exactly $n_pinned"; return 1; }

  while read -r name sha; do
    [ -n "${name:-}" ] || continue
    f="$dir/$name.asc"
    [ "$(gpg --batch --with-colons --show-keys "$f" 2>/dev/null | awk -F: '$1 == "pub" {n++} END {print n+0}')" = "1" ] || { _keyfail "$name.asc must hold exactly one primary key"; return 1; }
    fp="$(gpg --batch --with-colons --show-keys "$f" 2>/dev/null | awk -F: '$1 == "fpr" {print $10; exit}')"
    found=0; for want in $fps; do [ "$fp" = "$want" ] && found=1; done
    [ "$found" -eq 1 ] || { _keyfail "$name.asc has primary fingerprint $fp, which is not in the pinned list"; return 1; }
    file_fps="$file_fps $fp"
    gpg --batch --quiet --import "$f" 2>/dev/null || { _keyfail "cannot import $f"; return 1; }
  done <<< "$pins"

  have="$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "pub" {w = 1; next} $1 == "fpr" && w {print $10; w = 0}' | sort -u)"
  want_sorted="$(printf '%s\n' $fps | sort -u)"
  files_sorted="$(printf '%s\n' $file_fps | sort)"
  [ "$have" = "$want_sorted" ] || { _keyfail "keyring != pinned set. pinned=$(printf '%s ' $want_sorted) keyring=$(printf '%s ' $have)"; return 1; }
  [ "$files_sorted" = "$want_sorted" ] || { _keyfail "the key files do not map one-to-one onto the pinned fingerprints"; return 1; }
  echo "keys: $n_pinned vendored key files, each equal to its pinned sha256; keyring holds exactly the $(printf '%s\n' "$have" | wc -l | tr -d ' ') pinned primaries"
}
