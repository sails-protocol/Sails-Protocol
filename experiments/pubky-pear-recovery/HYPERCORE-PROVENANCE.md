# `hypercore@11.39.3`: npm attestation 404 (separate investigation, Mission 04)

Question from the CTO: why does `npm audit signatures` fail with 404 on `hypercore@11.39.3`, without declaring it compromised or clean from that error alone.
Date of checks: 2026-10-26 (3 days after publication). Evidence: `p2-evidence/pp4/hypercore-provenance.txt`.

| Check | Result |
|---|---|
| Registry packument for 11.39.3 | advertises `dist.attestations` (SLSA provenance v1), 2 registry signatures (keyid `SHA256:DhQ8wR5A...`), published by `GitHub Actions <npm-oidc-no-reply@github.com>`, `gitHead` `c7f6a9aa079691849916c217d95e344f5f548160` |
| The advertised attestation record | `GET /-/npm/v1/attestations/hypercore@11.39.3` -> **404**. The same endpoint for 11.39.2, 11.39.1, 11.38.0 -> 200 |
| Neighbouring versions | 11.37.0 to 11.39.2 and 11.39.3 all advertise attestations; only 11.39.3's record is missing |
| Tarball integrity | `npm pack` of 11.39.3: sha512 equals the packument's `integrity` (`sha512-jnQc98vD...OXQ==`) |
| Tarball content vs git | all 32 files in the tarball are byte-identical to the repository at `c7f6a9aa` (shallow fetch of that commit) |
| Git side | commit `c7f6a9aa` message "11.39.3", authored 2026-10-23T16:24:20Z, GitHub-verified signature; tag `v11.39.3` is an annotated tag (`5770f8e6`) |
| Upstream CI | workflow "Publish" for tag `v11.39.3` (run 39986535380) completed successfully at 16:24:42Z; "Build Status" for the same commit also green |
| Other Holepunch packages used here | `hyperdht@6.34.1`, `hyperswarm@4.17.2`, `corestore@7.16.1`, `sodium-native@5.2.0`: attestations present; `hypercore-crypto@3.7.0`: none advertised |
| `npm audit` (advisories) | 0 vulnerabilities |

## Conclusion (what is and is not established)

* **Established:** the published tarball is exactly the signed upstream commit, its integrity matches the registry metadata, and the upstream release pipeline ran green. Nothing observed indicates tampering.
* **Not established:** the SLSA provenance of this one version cannot be verified because the registry does not serve the record. The cause is unknown (a registry-side propagation or storage fault is the simplest explanation; a publisher-side problem cannot be excluded by this check).
* So the status is **"content verified against source, attestation missing": neither declared compromised nor declared attested.**

## Actions (small)

1. The lockfile pins `hypercore@11.39.3` with its integrity hash; no change is required to keep reproducibility.
2. Re-run `npm audit signatures` before any merge-related decision; if the record is still missing, either pin `11.39.2` (attested) for the experiment or ask the Holepunch maintainers; no action in Sails production code (hypercore is used only in this experiment).
3. A one-line upstream note to `holepunchto/hypercore` is optional and needs approval before sending.
