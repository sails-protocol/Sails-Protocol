#!/usr/bin/env bash
# P51: the ONE place that counts valid builder signatures from `gpg --status-fd` output. Sourced by provenance-bitcoin-core.sh and by
# gpg-count.check.sh, so the self-test exercises exactly the code the provenance step runs.
#
# Rules (GK V2.1 item 3 and R3 blocker 2):
#   * the EXIT CODE of gpg is never used (it is non-zero whenever an unknown key also signed);
#   * a `[GNUPG:] VALIDSIG <signing-key-fpr> <date> ... <primary-key-fpr>` line gives a PAIR: $3 is the key that actually SIGNED (a subkey for
#     builders that sign by subkey), the LAST field is the PRIMARY fingerprint; only the primary is compared with the pinned list;
#   * a signature is NOT counted if gpg reports its key as revoked or expired. `REVKEYSIG` / `EXPKEYSIG` / `EXPSIG` carry the key id of the
#     key that SIGNED (the subkey). So the match is made against the SIGNING key of the pair (and, defensively, against the primary): comparing a
#     subkey id with the end of the primary fingerprint would let a revoked subkey signature count;
#   * a builder counts ONCE however many signatures it made (distinct primary fingerprints), and counts if ANY of its signatures is valid.
#
# count_valid_builders <gpg-status-file> "<space-separated pinned PRIMARY fingerprints, uppercase>"
#   stdout: one line per builder decided ("COUNTED <primary>", "NOT COUNTED (revoked/expired) <primary>"), one per ignored signer
#           ("IGNORED (not pinned) <primary>"), then a last line "VALID_BUILDERS=<n>".
count_valid_builders() {
  local status="$1" pinned="$2"
  local bad id sub primary p hit is_bad
  local -A ok=() notok=() ignored=()
  # key ids reported as revoked/expired signers (upper case)
  bad="$(awk '$1 == "[GNUPG:]" && ($2 == "REVKEYSIG" || $2 == "EXPKEYSIG" || $2 == "EXPSIG") {print toupper($3)}' "$status" | sort -u)"
  while read -r sub primary; do
    [ -n "$primary" ] || continue
    sub="${sub^^}"; primary="${primary^^}"
    hit=0
    for p in $pinned; do [ "$p" = "$primary" ] && hit=1; done
    if [ "$hit" -eq 0 ]; then ignored[$primary]=1; continue; fi
    is_bad=0
    for id in $bad; do
      # the id may be a 16-hex long key id or a full fingerprint: match as a SUFFIX of the signing key (and of the primary)
      if [ "${#id}" -ge 16 ] && { [[ "$sub" == *"$id" ]] || [[ "$primary" == *"$id" ]]; }; then is_bad=1; fi
    done
    if [ "$is_bad" -eq 1 ]; then notok[$primary]=1; else ok[$primary]=1; fi
  done < <(awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" {print $3, $NF}' "$status")

  for p in "${!ok[@]}"; do echo "COUNTED $p"; done | sort
  for p in "${!notok[@]}"; do [ -n "${ok[$p]:-}" ] || echo "NOT COUNTED (revoked/expired) $p"; done | sort
  for p in "${!ignored[@]}"; do echo "IGNORED (not pinned) $p"; done | sort
  echo "VALID_BUILDERS=${#ok[@]}"
}
