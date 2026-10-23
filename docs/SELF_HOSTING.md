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
   migrations shipped in its own image (`src/common/database/migration-gate.ts`). This holds on any
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

Starts the previous server image. **The database schema is not rolled back.** That is why every
migration must be backward compatible with the previous server version (add before use; remove only in
a later release). A migration that must be undone is a new forward migration, or a restore from backup.

## Back up and restore

```bash
deploy/self-host/sails-node backup                       # pg_dump -Fc to ~/.sails-node/backups/
deploy/self-host/sails-node restore ~/.sails-node/backups/<file>.dump
```

`restore` refuses a database that is not empty, restores, then runs the migration job against it to
verify the result. Copy backups off the host and **test a restore** before you rely on them
(`docs/DEPLOYMENT.md` 6.2). The evidence bucket and `secrets/` are not in the dump: back them up
separately. A dump is as sensitive as the database.

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

## What this does not prove

- **Not multi-operator interoperability.** Running your own node proves you can host one. It does not
  prove that several independently operated nodes interoperate economically (shared market contexts,
  cross-operator disputes, identity/transport federation). Those are protocol-level tests that remain
  open; do not read "self-hostable" as "multi-operator complete".
- Not exercised: real TLS issuance, a real VPS, pgbouncer / managed PostgreSQL, very large databases,
  key management for real custody, and a restore drill on real data.
- Images are built from source on the operator's host. There is no signed registry release yet, so
  build provenance is your own checkout. `apt` packages in the migration image are not version-pinned
  (see the OpenSSL note in the P3 report): rebuilds pick up current Debian security updates.
