# Self-hosting a Sails Node

> **Audience:** an operator with no Satsails account and no access to Satsails infrastructure, on a
> Linux VPS, a dedicated server or their own hardware. Nothing below needs AWS, a particular cloud, a
> container registry account, Kubernetes or Terraform.
>
> **Status:** the install / update / rollback / backup path below is exercised by
> `scripts/self-host-test.sh` on a disposable stack. That proves the *self-hosting mechanics*. It does
> **not** prove multi-operator interoperability or economic behaviour — see
> [What this does not prove](#what-this-does-not-prove).

## Roles — keep them separate

| Role | What it is | Needs Satsails? |
|---|---|---|
| **Sails Protocol** | The rules and invariants (specification, schemas, SDK contracts). | No |
| **Sails Node** | A service *you* operate: this repository's server + its database. | No |
| **Sails Market** | A reference implementation and reusable interface built on the protocol. | Not to run a node |

Satsails infrastructure is a participant in the network, not a dependency of it. A node you run
requires no credential from Satsails and no privileged access to the Sails Market.

## What you need

- Linux host, Docker Engine ≥ 24 with the Compose plugin, `git`, `bash`, `timeout`. 2 vCPU / 4 GB RAM
  is enough to start; the server image is large (it carries the QVAC AI runtime) — plan ~10 GB of disk
  for images plus space for PostgreSQL and backups.
- Outbound internet for building (npm) and for the services listed in
  [Dependencies](#dependencies-on-other-services). Running the migration job needs **no** internet.
- An S3-compatible bucket for evidence. Production refuses local disk storage. The kit can run a
  self-hosted SeaweedFS (Apache-2.0) for you. MinIO is deliberately not used: its community edition was
  archived and its images discontinued in 2025-2026.

## Install

```bash
git clone https://github.com/sails-protocol/Sails-Protocol.git
cd Sails-Protocol
git checkout <the release tag or commit you audited>
export COMPOSE_PROFILES=evidence-store   # self-hosted S3-compatible evidence store; omit if you bring your own
deploy/self-host/sails-node init       # creates ~/.sails-node (secrets 0600), generates DB secrets
$EDITOR ~/.sails-node/secrets/server.env   # network, custody secrets, evidence store: see the comments
deploy/self-host/sails-node update     # build, back up, MIGRATE, then start the server (also creates the evidence bucket)
deploy/self-host/sails-node status
```

- Secrets live in `~/.sails-node/secrets/` (`SAILS_NODE_HOME` to change it), never in an image or in
  the repository. The database password is generated for you and used only by the stack.
- **Back up `secrets/` as well as the database.** With the bundled store, `secrets/seaweedfs.env` holds the\n  key that encrypts the evidence at rest (the server requests AES256 on every upload, which SeaweedFS accepts\n  only when it has that key). Lose the key and the stored evidence cannot be read back.\n- The server listens on `127.0.0.1:3000` only. PostgreSQL, Redis and the evidence store publish no ports.
- `server.env` must satisfy the production gates (`docs/DEPLOYMENT.md`): the server **refuses to
  boot** on `MOCK_ESCROW`, a missing `MULTISIG_NETWORK`, disabled capability enforcement, local-fs
  evidence storage, and so on. Real-custody secrets (for example `MULTISIG_SEED`) are yours to supply
  and protect; see `docs/DEPLOYMENT.md` sections 7 and 8.3.

### TLS

Put any reverse proxy in front of `127.0.0.1:3000`. The kit includes an optional Caddy profile with
automatic certificates: `COMPOSE_PROFILES=evidence-store,tls SAILS_DOMAIN=node.example.org` (public DNS for
that name must point at the host; ports 80/443 are then published). The profile's configuration is
checked to render, but a real certificate issuance is **not** exercised by the test suite.

## Update

```bash
git fetch && git checkout <new tag or commit>
deploy/self-host/sails-node update
```

`update` does, in this order, and stops at the first failure:

1. build `sails-server:<tag>` and `sails-migrate:<tag>` from the checkout (refuses a dirty tree);
2. back up the database (`~/.sails-node/backups/`, mode 0600);
3. run the **migration job** of that same version and wait for its exit code;
4. **only if the job exited 0**, start the new server and wait for `/health/ready`;
5. if the new server does not become ready, start the previous one again.

### The migration gate

A new server version must not run unless its migrations are complete. Three independent layers enforce
it, none of which depends on a cloud platform:

1. `sails-node update` starts the server only after the migration job exited 0. A **failed**,
   **timed-out** (`SAILS_MIGRATE_TIMEOUT`, default 600 s — the result is *unknown*) or **missing**
   result stops the update and leaves the running server untouched.
2. `compose.yml` declares `server: depends_on: migrate: service_completed_successfully`, so even a
   hand-run `docker compose up` cannot start the server after a failed job.
3. The server itself refuses to start in production when its database is not fully migrated to the
   migrations shipped in its own image (every shipped migration finished, and applied from byte-identical SQL) (`src/common/database/migration-gate.ts`). This holds on any
   host or orchestrator, including one that ignores the first two layers. A database *ahead* of the
   server is accepted so that a rollback works; an unreadable migration table is treated as "not
   migrated".

The server never migrates on start.

If an update is blocked by a migration failure, the previous server keeps serving. Read the job's
output, fix the cause, and follow `docs/DEPLOYMENT.md` 6.1 (do not resolve a failed migration without
checking the schema first), then run `update` again.

## Roll back

```bash
deploy/self-host/sails-node rollback
```

Starts the previous server image. **The database schema is not rolled back, and this kit cannot verify
that the previous version still works on the migrated schema.** Rollback is therefore *limited*, not a
universal guarantee:

- It is safe only if every migration applied since that version was backward compatible (expand before
  use; contract - drop/rename/tighten - only in a later release). Nothing in the kit classifies a
  migration; that review is yours. The tests prove it for an additive migration only.
- The server's boot gate accepts a database *ahead* of the image. That makes the rollback *start*; it does
  not prove the old code *works* on the new schema.
- If a migration was not backward compatible, do not roll back: restore the backup taken before the update
  (`update` takes one automatically) into an empty database, or ship a new forward migration.
- The automatic rollback inside `update` (when the new server does not become ready) has the same limit.

## Back up and restore

```bash
deploy/self-host/sails-node backup                       # pg_dump -Fc to ~/.sails-node/backups/
deploy/self-host/sails-node restore ~/.sails-node/backups/<file>.dump
```

`restore` refuses a database that is not empty, restores **in one transaction** (a failed restore leaves the
database empty, so you can retry), then runs the migration job against it to verify the result. A dump is as
sensitive as the database.

**Backup integrity.** Every backup (`.dump` and the evidence `.tar.gz`) gets a `FILE.sha256` sidecar, and
`restore`/`restore-evidence` verify it, plus the file's structure, *before touching anything*. A backup without
a sidecar (taken by an older version) is refused unless you set `SAILS_RESTORE_UNVERIFIED=1`; a sidecar that does
not match is never overridable. `sails-node verify-backup FILE` checks a backup at any time, and `--deep` also
restores a dump into a scratch database and drops it. **The sidecar detects accidents, not an attacker:** whoever
can change the archive can change the sidecar. Keep a copy of the sidecar (or a signature of it) where the host
cannot write. `pg_restore --list` alone is not an integrity check (it can accept a damaged dump).

**Signed backups (tamper-evidence).** `sails-node backup-key init` creates an Ed25519 key (OpenSSH, needs `ssh-keygen` 8.0+). While
that key exists, every backup sidecar is signed (`FILE.sha256.sig`), and `restore`, `restore-evidence` and `verify-backup` **refuse**
any backup whose sidecar does not verify: replacing an archive and recomputing its sidecar no longer works. Fail-closed rules: a
signature that does not verify, or that cannot be checked because no public key is available, is never accepted; with
`SAILS_BACKUP_VERIFY_KEY` set (or `SAILS_BACKUP_REQUIRE_SIGNATURE=1`) an unsigned backup is refused too, and `SAILS_RESTORE_UNVERIFIED=1`
cannot override that.

*Where the verification key is anchored decides what the signature proves.* Keep a copy of the **public** key and its fingerprint **off
this host** and restore with `SAILS_BACKUP_VERIFY_KEY=<that copy>` (a file with several public keys is a rotation: old and new backups
verify). With the anchor only on the host (`secrets/backup-signing.pub`), a copy of a backup that was modified while stored elsewhere is
caught, but someone who controls the host can replace both the key and the backup: the test shows exactly that case passing. The same
holds for the private key: on the host it protects stored copies, not against a compromised host; for that, keep it off the host
(`SAILS_BACKUP_SIGNING_KEY` on removable media or behind a passphrase and `ssh-agent`).

*Key loss and compromise.* If the private key is lost, new backups cannot be signed with it, old ones still verify with the public key;
create a new key and add its public half to the off-host file. If it is compromised, remove its public key from that file: backups it
signed then stop verifying, so re-verify what you trust by other means (a scratch restore with `verify-backup --deep`) and re-sign.
This is the backup-signing identity only. **The kit generates no node signing identity, so recovering one is NOT VERIFIED here**
(the operator restores whatever keys they configured, unchanged).

**Dumps are not encrypted.** `sails-node backup` writes the database in clear (file mode 0600) and the evidence archive holds
objects that are encrypted only by the store's key. A dump contains every row, including anything personal: encrypt it yourself
(for example with `age` or `gpg`) before it leaves the host, and keep that key apart from the backups. The signature proves who made a
backup and that it is unchanged; it does not make it confidential.

**Evidence checks.** `sails-node verify-evidence` reads back every stored object and compares its content with the
SHA-256 in its name; it fails if the store runs with the wrong key, if an object is damaged, or if the store
cannot list or read.

**Rotating the evidence key.** `sails-node rotate-evidence-key` copies every object into a second store that uses a
NEW key (each copy verified), then swaps the stores and verifies again; any failure before the swap leaves the
running store untouched, and a failure after it restores the pre-rotation snapshot and the old key. The old key is
kept in `secrets/seaweedfs.env.prev-<timestamp>`: keep it while old evidence archives may still need restoring,
then destroy it, and copy the new `secrets/` off the host at once.

### Recovering everything: database, evidence objects, key and credentials

A complete recovery needs **four** things; the database dump is only one of them:

| What | Where it lives | How it is saved |
|---|---|---|
| PostgreSQL | volume `postgres-data` | `sails-node backup` (`pg_dump -Fc`) |
| Evidence objects | volume `seaweedfs-data` (bundled store) | `sails-node backup-evidence`: cold snapshot, the store is stopped while it is copied (uploads fail meanwhile). Objects stay **encrypted**. |
| The SSE key | `secrets/seaweedfs.env` | **Not inside any archive.** Copy `secrets/` to offline, encrypted storage yourself. |
| Credentials and settings | `secrets/` (`server.env`, `db.env`, `seaweedfs.env`, `postgres_password`) | same: copy `secrets/` yourself |

Order on a new host: restore `secrets/` (`init` refuses to overwrite it), `sails-node restore <dump>`,
`sails-node restore-evidence <archive>` (into a fresh store), then `sails-node update`. After it, read an
evidence object back before declaring success.

**What is tested** (`scripts/self-host-backup-test.sh`, throwaway project): the sidecar, a stale or forged one, a
truncated dump, damaged data that only `--deep` catches, atomic restore, the evidence restore refusing a truncated
or replaced archive before the store is touched, `verify-evidence` with a wrong and the right key, the rotation
(and its refusal over an unfinished one), no key or password in any log, and that `migrate` runs with dropped
capabilities and `no-new-privileges`. **And** (`scripts/self-host-test.sh`): the database restore into an empty database with migration
verification; the evidence restore after the store's container and volume were deleted, with the original bytes
read back through the production `S3EvidenceProvider`; and that a *different* SSE key cannot read the restored
object while the preserved key can. **What is not tested:** a single end-to-end drill on a brand-new host from
off-site copies; restoring when the evidence store is your own S3-compatible service (use its own tools).
The kit does not encrypt backup archives.

## Distroless candidate (opt-in, not the default, not homologated)

`SAILS_IMAGE_FLAVOR=distroless` makes `sails-node build` produce the server and migration images on Distroless Debian 13
(`deploy/self-host/distroless/Dockerfile`) instead of Debian bookworm-slim. Set it for **every** `sails-node` command of that
node (build, update, rollback, backup, ...): it also selects `/nodejs/bin/node` for the kit's own helper containers and adds
`compose.distroless.yml` (read-only root filesystem, private `/tmp`) to every Compose call. The default flavor is unchanged.

What changes for the operator: there is **no shell and no package manager** in either image (an ephemeral debug container
replaces `docker exec ... sh`); the server runs as uid 65532; `node` is not on `PATH`, so `docker exec <container> node` must
use `/nodejs/bin/node`; the migration job is a Node entrypoint with the same contract as `scripts/migrate-deploy.sh`.
The Bare runtime the QVAC SDK spawns is made executable at build time, which a read-only root filesystem requires.

**Update strategy.** Both distroless bases are pinned by digest in the Dockerfile. A new base is adopted by a reviewed commit:
resolve the new digest of `gcr.io/distroless/nodejs24-debian13`, rebuild, and require the same evidence as any image change
(`scripts/runtime-image-checks.js` with `REQUIRE_BARE_EXECUTABLE=1`, the Trivy gate, `scripts/self-host-test.sh` and
`scripts/self-host-backup-test.sh` with `SAILS_IMAGE_FLAVOR=distroless`). The weekly image audit rebuilds the default images; a
digest bump is what makes a fixed Debian package reach a distroless node. No registry, signing or SBOM publication exists yet:
the scan writes a CycloneDX SBOM per image as a CI artifact, unsigned.

**Status.** Candidate. Its evidence and its limits are in the PR that introduced it; do not use it for a production node until
the CTO homologates it.

## Health and logs

- `GET /health/live`, `/health/ready` (PostgreSQL and Redis checks), `/health`.
- `docker compose -p sails-node logs -f server`. Logs do not contain the database or evidence-store
  secrets (asserted by the test). `docker inspect` on the server container does show environment
  variables, as for any Compose deployment: restrict access to the Docker socket.

## Dependencies on other services

What a node needs besides its own containers. None is operated by Satsails; all are configurable.

| Need | Used for | Notes |
|---|---|---|
| S3-compatible object storage | Evidence (required in production) | Bundled SeaweedFS, or any S3-compatible store |
| Bitcoin explorer API (`MULTISIG_EXPLORER_API_URL`) | MULTISIG funding/settlement checks | Defaults to a public testnet endpoint; run or choose your own (Esplora/mempool-compatible) |
| Arkade ASP / explorer | Only if the Arkade rail is used | `ARKADE_ASP_URL`, `ARKADE_EXPLORER_API_URL` |
| EVM RPC | Only if an EVM rail is used | `WDK_RPC_URL`, `SAFE_GUARD_EVM_RPC_URL` |
| QVAC model registry | First load of an AI model (dispute assistance) | Downloaded on first use, then cached locally |
| npm registry, Debian mirrors, Docker Hub | Building/pulling images | Build-time only |

The server source contains no endpoint of Satsails, AWS or any specific hosting provider.

## Dependency audit of the images

CI audits what the two shipped images really contain (`scripts/production-image-audit.js`): `npm audit` over the
lockfile, failing on high/critical advisories whose range matches a package copy installed in the image. It
runs against the **server** image and against the **migration** image (which carries the Prisma CLI chain);
the front-end workspaces are in neither. The native runtime QVAC needs stays in the server image. (PR #451's
`--omit=optional` was rejected because it also removes that runtime.) A finding that cannot be fixed yet is a
formal exception with an expiry date in `scripts/production-image-audit.exceptions.json`, printed on every run;
the step fails once one expires. That list is currently **empty**: no advisory is excepted.

A clean audit says "no advisory known on the day CI ran", not "no vulnerability": advisory databases change, so
the same commit can fail a later re-run (the npm advisory feed also lags GitHub's by hours: the same commit
printed no `fast-uri` finding at one time and a moderate one a few hours later). Treat a red audit on an unchanged
commit as a real finding, not as a flaky test.

**What this audit does not cover.** It inventories the application tree (`/app/node_modules`). It does not see the
Debian packages of the base image or any other file outside `/app`. The Node base image's own `npm` and `corepack`
(a vendored dependency tree of their own) are removed from the final `runtime` and `migrate` stages, because nothing
in them runs a package manager. Debian OS findings, including ones the distribution marks `will_not_fix`, are
outside the gate: scan the built images with a container scanner (Trivy, Grype) before a deployment decision and
record the scanner and database version with the result.

## What this does not prove

- **Not multi-operator interoperability.** Running your own node proves you can host one. It does not
  prove that several independently operated nodes interoperate economically (shared market contexts,
  cross-operator disputes, identity/transport federation). Those are protocol-level tests that remain
  open; do not read "self-hostable" as "multi-operator complete".
- Not exercised: real TLS issuance, a real VPS, pgbouncer / managed PostgreSQL, very large databases,
  key management for real custody, and a restore drill on real data.
- **P3-A vs P3-B.** This document and its tests cover P3-A: distributing and operating a node independently.
  P3-B, economic and protocol interoperability between several independently operated nodes, is *not*
  covered and remains unproven.
- The boot gate also compares each shipped migration's SHA-256 with the checksum Prisma stored when it applied it,
  so a migration edited after being applied is refused. This is the *only* place that is caught: measured on
  Prisma 7.10, neither `migrate status` nor `migrate deploy` re-checks the checksum. There is no line-ending
  normalisation (Prisma does not normalise either, and normalising would hide real edits), so a database migrated
  from different *bytes* than the image ships is refused too, e.g. a CRLF checkout vs an LF one. `.gitattributes`
  pins `prisma/migrations/**/migration.sql` to LF so a checkout on any OS gives the same bytes; one `sails-node`
  build produces both images from a single checkout. Tested by unit tests and by a hand-started server on a
  database whose applied migration was edited (`scripts/self-host-test.sh`).
- Images are built from source on the operator's host. There is no signed registry release yet, so
  build provenance is your own checkout. `apt` packages in the migration image are not version-pinned
  (see the OpenSSL note in the P3 report): rebuilds pick up current Debian security updates.
