# Self-hosting: backup, restore and SSE key custody (procedure, adversarial results, gaps)

Status: CURRENT (2026-10-25, P3-R4 Front B). Evidence level: **mechanism observed on throwaway containers**. Nothing here
shows that a real operator can recover a real node; that needs the VPS drill in `docs/SELF_HOST_ACCEPTANCE.md` (A15). No
real key was used, copied or printed: every key in the probe is generated per run and scrubbed from its output.
The production kit (`deploy/self-host`, `sails-node`) was **not modified** by this mission.

## What is backed up, and what is not

| Asset | Backup | Restored by | Protected how |
|---|---|---|---|
| PostgreSQL | `sails-node backup` (`pg_dump -Fc`) | `sails-node restore FILE` into an EMPTY database, then the migration job verifies | file mode 0600 |
| Evidence objects (bundled SeaweedFS) | `sails-node backup-evidence` (cold tar of the volume) | `sails-node restore-evidence FILE` into a FRESH volume | objects are SSE-S3 encrypted (AES256); the archive is useless without the key |
| `secrets/seaweedfs.env` (S3 credentials **and** `WEED_S3_SSE_KEK`) | **not backed up by the kit** | by the operator | the operator's own vault |
| `secrets/db.env`, `secrets/server.env` (settings and the evidence S3 credentials) | **not backed up by the kit** | by the operator | the operator's own vault |
| Any signing, escrow or arbitrator key the operator configures for the server | **outside the kit**: `sails-node init` generates none and `server.env.example` defines none | by the operator | the operator's own vault |

The single most important sentence for an operator: **the evidence backup is only a recovery together with the key.**
Losing `WEED_S3_SSE_KEK` makes every stored evidence object permanently unreadable; the database dump cannot help.

## Operator procedure (reproducible; every step is a command of the kit or of the probe)

1. **Take both backups at the same moment** (`backup`, then `backup-evidence`; the latter stops the store, uploads fail
   meanwhile). Record the file names and a SHA-256 of each (`sha256sum`): the kit does not write one (gap G1).
2. **Back up `secrets/` separately and offline**, in a place that does not share a failure with the host (different
   medium, access-controlled). Do not put it in the same archive as the data. Test that you can read it.
3. **Before trusting a backup, restore it** on a scratch host or a scratch Compose project and read an object back.
   A backup that has never been restored is a hope, not a backup.
4. **Restore order**: secrets first, then the database (`restore`), then the evidence store (`restore-evidence`), then
   `update`/start. Restore refuses a non-empty database or a non-empty evidence volume on purpose.
5. **If a restore fails halfway**, the target is no longer fresh. Remove the database/volume and start again from a
   clean target; do not "finish" a partial restore (see D2 below for what a failed database restore leaves behind).

## Controlled key rotation (copy, verify, switch, retire): manual today

SeaweedFS has no in-place re-key: a store started with a different key cannot read objects written under the old one
(E4). The only safe rotation is a copy between two stores:

1. Start a second store with the NEW key on a new volume (never reuse the old volume).
2. Read every object from the old store (old key) and write it to the new one (new key). Object keys are
   `sha256(content).ext`, so each copy can be verified against its own name.
3. Verify every object on the new store byte-for-byte (or by hash) before touching anything else.
4. Point the server's `EVIDENCE_S3_*` at the new store and update `secrets/seaweedfs.env` **in the vault first**.
5. Retire the old store and destroy the old key only after a retention period in which a rollback to the old store
   is still possible. Until then, keep both keys.

The probe (E7/E8) performs steps 1-3 and the "old key and volume are gone" check on throwaway stores.
**No rotation command exists in the kit** (gap G4): rotation is a manual, operator-run procedure.

## Adversarial results (`scripts/self-host-recovery-probe.js`, run 2026-10-25, 13 cases: 12 PASS, 1 INFO, 0 FAIL)

SeaweedFS 4.48, PostgreSQL 16, throwaway containers. The probe is not wired into CI (it pulls a 724 MB image); run it by
hand with `node scripts/self-host-recovery-probe.js --out report.json`.

| Case | Requirement | Observed |
|---|---|---|
| E1-E3 | Round trip: cold snapshot, restore into a fresh volume, right key | PASS: object reads back byte-for-byte |
| E4 | Restore **without the right key** fails safely | PASS: the read is refused (`InternalError`); neither plaintext nor other bytes are returned |
| E5 | A truncated evidence archive is detectable | PASS: `tar -tzf` fails on it |
| E5b | Serving from a half-extracted archive | PASS (fails closed): the object is not served (`NoSuchKey`), **but the store starts and looks healthy** |
| E6 | A tampered data file is not served as if intact | PASS on this sample: the store refuses the object (`InternalError`). One sample; it does not prove every corruption is caught, so callers should still compare the SHA-256 in the object key |
| E7-E8 | Rotation by copy verifies every object, and the new store lives without the old key and volume | PASS |
| D1 | `pg_restore --list` as an integrity check of a truncated dump | INFO: it **accepts** a truncated dump (the table of contents is at the start). It is not an integrity check |
| D2 | Default restore of a truncated dump | PASS on exit status (non-zero, so it does not claim success) **but it leaves a partial database behind** (1 table, 0 rows); a retry is then refused as "not empty" |
| D3 | `--single-transaction --exit-on-error` restore of a truncated dump | PASS: exit non-zero and **nothing partial survives** |
| D4 | The intact dump restores and its content matches the source | PASS (content digest equal) |

"Credentials must not appear in logs, artifacts or reports": the probe scrubs every generated key/password from the text
it prints and writes, and the kit's own run (`scripts/self-host-test.sh`) greps all logs for the database and S3
secrets. A grep shows absence of the strings it looks for, not absence of every leak.

## Gaps found G1-G6 (proposals only; the kit was NOT changed in this mission)

| # | Gap | Proposal | Risk if left |
|---|---|---|---|
| G1 | **No integrity protection of a backup at all.** The kit writes no checksum, no signature and no MAC; `restore`/`restore-evidence` verify nothing; "backup incomplete" is only caught if the tool happens to fail (a truncated `pg_dump -Fc` passes `--list`). Even a SHA-256 sidecar only protects against accident: an attacker who can change the archive can change the sidecar, so tamper-evidence needs a signature or an HMAC whose key is kept apart from the backup | `backup`/`backup-evidence` write `FILE.sha256`; restore verifies it first; add `sails-node verify-backup FILE` (sha256 + `tar -tzf` / a scratch `pg_restore`); for adversarial integrity, sign the sidecar with a key held in the operator's vault | A corrupt or substituted backup is discovered during, or after, a disaster |
| G2 | **Partial restore.** `restore` uses plain `pg_restore`: a failed restore leaves a partial database that then blocks a retry (D2) | Use `--single-transaction --exit-on-error` (D3) | Operator must hand-clean the database |
| G3 | **Partial evidence restore looks healthy** (E5b) | `restore-evidence` checks `tar -tzf` before extracting and counts restored files after | Silent partial restore |
| G4 | **Manual rotation**, no rotation command, no key-custody check | Procedure above; optionally a `rotate-evidence-key` that automates copy-verify-switch; `init` could print a one-time reminder to back up `secrets/` | Key loss = permanent loss of evidence |
| G5 | `secrets/` is outside every kit backup | State it loudly in `docs/SELF_HOSTING.md` (partly done) and in `sails-node backup` output | Same as G4 |
| G6 | **Insufficient protection of the `migrate` service**: no `cap_drop: [ALL]` and no `no-new-privileges` (the `server` service has both), while the image carries setuid binaries (`mount`, `umount`, `su`, `passwd`, ...) | Add the same two lines to `migrate` | A setuid binary is usable inside the migrate container; relevant to the util-linux findings in `docs/security/P3_R4_TRIVY_TRIAGE.md` |

None of G1-G6 changes the protocol or any economic behaviour; they change the self-hosting kit. They are returned to the
CTO for approval before implementation (mission rule: no change to the production kit in this mission).

## Signing identity and authority: NOT VERIFIED

The kit neither generates nor backs up any node signing identity (see the table above), so "recovery preserves
cryptographic identity and authority" is **NOT VERIFIED**. It depends entirely on the operator restoring whatever keys
they configured, unchanged. This is a design decision, not a test gap, and it is deferred until after the Master Backlog
Day 0 decision (CTO). Nothing in this document should be read as a claim that identity or authority survive a restore.

## What this does not show

- That `sails-node` invokes these tools safely in every path (only the tools were probed, plus the existing kit test).
- Behaviour on production-sized data, on a real VPS, under disk-full, or with a store that is not SeaweedFS.
- Anything about the node's signing identity (above).
