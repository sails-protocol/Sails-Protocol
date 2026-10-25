# P3-R4 Front A: triage of the Trivy findings on the #521 images

Status: CURRENT (2026-10-25). Source: artifact `trivy-report` of CI run
[40153737046](https://github.com/sails-protocol/Sails-Protocol/actions/runs/40153737046) (head `7763c3f8`), Trivy 0.76.1, vulnerability
DB `UpdatedAt 2026-10-25 01:20 UTC`. Gate mode: **observe**. **No exception was created and enforce was not enabled.**
Everything below is a proposal for the CTO; none of it is an accepted risk.

## Deduplication

| Count | What |
|---|---|
| 125 | Raw findings (server 62 + migrate 63), CRITICAL/HIGH |
| 63 | Unique (CVE, package, version) triples: 62 appear in both images, 1 only in `migrate` |
| 18 | **Distinct CVEs** (the same util-linux CVE is reported once for each of 7 packages that come from one source package) |
| 13 | in Debian packages (OS), none with an upstream fix available (`affected`, `fix_deferred`, `will_not_fix`) |
| 5 | in Node packages, **all inside the `npm` bundled in the Node base image** (`/usr/local/lib/node_modules/npm/...`), none a dependency of the application |

Reading the matrix: "Explorability here" is an assessment of this deployment (non-root `node` user; the `server` service runs
with `no-new-privileges` and `cap_drop: [ALL]`; the `migrate` service does not; neither runs `npm`, `mount`, `gzip`, `perl`
or `systemd` as part of its job). It is reasoning plus the checks listed under "Verified in the image", not an exploit test.
CISA KEV / EPSS were **not** consulted (no authorised data source was used), so exploitation-in-the-wild is NOT VERIFIED.

## Matrix (18 distinct CVEs)

Priority: **P0** = a CRITICAL, or a fix exists and is already in flight; **P1** = HIGH with no upstream fix, needs a disposition
decision before any enforce; **P2** = HIGH with no plausible path in this deployment. "In base?" shows whether the same CVE is
still reported on the candidate base images (base-image-only scans, `p3-evidence/r4/base`): trixie-slim / alpine /
distroless Debian 13 / distroless Debian 12.

| # | CVE | Sev | Package(s) (installed) | Image | Fix | Explorability here | Proposed treatment | Prio | In base? tr/alp/d13/d12 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | CVE-2023-45853 | CRITICAL | zlib1g 1:1.2.13 | both | none (`will_not_fix`) | Vulnerable function is in zlib's `minizip` contrib; `zlib1g` ships **0** minizip files (verified). Node links zlib statically. No reachable path found | Change base (absent in trixie) or, if the CTO prefers to stay on bookworm, a time-boxed exception with this evidence. Not created | P0 | -/-/-/- |
| 2 | CVE-2026-102276 | HIGH | brace-expansion 5.0.9 (npm bundled) | both | 5.0.10+ | `npm` is never run in the container | Remove `npm`/`corepack` (P3-R2, #530) | P0 | Y/Y/-/- |
| 3 | CVE-2026-102278 | HIGH | brace-expansion 5.0.9 (npm bundled) | both | 5.0.11+ | same | same | P0 | Y/Y/-/- |
| 4 | CVE-2026-93748 | HIGH | http-cache-semantics 4.2.0 (npm bundled) | both | none | same | same | P0 | Y/Y/-/- |
| 5 | CVE-2026-109869 | HIGH | undici 6.28.0 (npm bundled) | both | 6.29.1+ | same | same | P0 | Y/Y/-/- |
| 6 | CVE-2026-19534 | HIGH | undici 6.28.0 (npm bundled) | both | 6.28.1+ | same | same | P0 | Y/Y/-/- |
| 7 | CVE-2026-53613 | HIGH | util-linux family (7 pkgs): mount TOCTOU | both | none (`affected`) | Local-only; needs the `mount` program and mount rights. Setuid `mount`/`umount` present, neutralised on `server` by `no-new-privileges` + `cap_drop ALL`, **not** on `migrate` | Harden `migrate` (G6); base change (absent in trixie) | P1 | -/-/-/- |
| 8 | CVE-2026-53615 | HIGH | util-linux family: DOS-partition integer overflow | both | none | Local-only; no partition tooling is used; no block devices in the container | Base change (absent in trixie) | P2 | -/-/-/- |
| 9 | CVE-2026-76642 | HIGH | util-linux family: failed mount helper runs privileged post-hook | both | none | Local-only, needs mount | G6; still in trixie, needs upstream fix | P1 | Y/-/-/- |
| 10 | CVE-2026-78408 | HIGH | util-linux family: `nsenter --join-cgroup` | both | none | Local-only, needs `nsenter` and privileges the container does not have | still in trixie | P2 | Y/-/-/- |
| 11 | CVE-2026-78409 | HIGH | util-linux family: `X-mount.subdir` escape | both | none | Local-only, needs mount | G6; still in trixie | P1 | Y/-/-/- |
| 12 | CVE-2026-78410 | HIGH | util-linux family: bind-mount source not pinned | both | none | Local-only, needs mount | G6; still in trixie | P1 | Y/-/-/- |
| 13 | CVE-2026-41992 | HIGH | gzip 1.12 (`fix_deferred`) | both | deferred | Needs `gzip -d` on attacker-supplied LZH data; the application does not call gzip | Base change (absent in trixie) | P2 | -/-/-/- |
| 14 | CVE-2026-54369 | HIGH | libacl1 2.3.1 (`fix_deferred`) | both | deferred | `setfacl`/libacl symlink traversal; not used | Wait for Debian; still in trixie | P2 | Y/-/-/- |
| 15 | CVE-2026-16742 | HIGH | libsystemd0, libudev1 (`fix_deferred`) | both | deferred | Concerns `systemd-homed`, which does not exist in the container; only the libraries are installed | Wait for Debian; still in trixie | P2 | Y/-/-/- |
| 16 | CVE-2025-69720 | HIGH | ncurses (libtinfo6, ncurses-base, ncurses-bin) | both | none | Terminal library; `node` does not link it; no interactive terminal | Wait for Debian; still in trixie | P2 | Y/-/-/- |
| 17 | CVE-2026-9538 | HIGH | perl-base 5.36 (`fix_deferred`): Archive-Tar DoS | both | deferred | `perl` is not used by the application; present because `dpkg` needs it | Wait for Debian; still in trixie | P2 | Y/-/-/- |
| 18 | CVE-2026-84782 | HIGH | libssl3 3.0.22 (DTLS retransmission) | **migrate only** | none | Installed so Prisma's schema engine can load; the engine speaks TLS over TCP to PostgreSQL, **not DTLS**; `node` uses its own bundled OpenSSL | Wait for Debian 12 fix; absent on trixie | P2 | -/-/-/Y |

Verified in the image (`node:24.22.1-bookworm-slim@sha256:55fb5f5a...`, probe in `p3-evidence/r4/probe.sh`): `dpkg -L zlib1g`
lists 0 minizip files; `ldd /usr/local/bin/node` shows only libc, libm, libdl, libpthread, libstdc++ and libgcc (no libssl,
libz, libacl, libsystemd, libtinfo, libblkid, libmount); setuid/setgid binaries present: `newgrp su mount passwd chage gpasswd
umount chsh expiry chfn unix_chkpwd`; the image runs as `root` by default and the Dockerfile switches to `node`.

## What the numbers say about the options

- Removing `npm` (P3-R2, #530) is expected to remove rows 2-6 (all five Node findings). That is **not yet shown by a scan**:
  #530 has no Trivy step; the claim is a projection from the paths in the report.
- The 13 OS CVEs do not go away by removing application dependencies. Base candidates (base-image scans, HIGH/CRITICAL):
  see `docs/security/P3_R4_IMAGE_ALTERNATIVES.md`.
- `--omit=optional` and removing packages merely to lower the scanner count were **not** used and are not proposed.

## Open questions for the CTO (no exception is registered for any of them)

1. Row 1 (the only CRITICAL): change base, or accept with expiry on the evidence above?
2. Rows 7-12 (util-linux, six CVEs reported seven times each): accept until Debian ships a fix, harden `migrate` (G6), or move to a
   base without util-linux (distroless)?
3. Which rows may be time-boxed exceptions before the gate moves to enforce?
