# Vendored Bitcoin Core builder public keys

Thirteen files, `<builder>.asc`: **byte-for-byte** the files `builder-keys/<builder>.gpg` of
[`bitcoin-core/guix.sigs`](https://github.com/bitcoin-core/guix.sigs) at the commit `a171559775c54949da8017714ddf9b5305071f73`. Nothing is fetched from
`guix.sigs` or from a keyserver during the CI job.

Integrity is checked three ways before any signature is trusted (`scripts/gpg-keys.sh`, exercised by `scripts/gpg-keys.check.sh`):
1. the sha256 of **each** file equals the value pinned in the workflow (`BUILDER_KEY_SHA256S`);
2. this directory holds **exactly** those thirteen `.asc` files (no key can be added by dropping a file here);
3. each file holds one primary key whose fingerprint is one of the thirteen pinned in the workflow, and the keyring built from them holds exactly
   those thirteen primary fingerprints.

To re-verify by hand: read each `builder-keys/<builder>.gpg` at that commit (for example with
`gh api -H "Accept: application/vnd.github.raw" "repos/bitcoin-core/guix.sigs/contents/builder-keys/<builder>.gpg?ref=<commit>"`), compare its sha256 with
the pin, and compare `gpg --with-colons --show-keys` (first `fpr:` line) with the pinned fingerprint.

Adding, removing or replacing a key is a change to the pins in the workflow and must be re-verified by the GK.
