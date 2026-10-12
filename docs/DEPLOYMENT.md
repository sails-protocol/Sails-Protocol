# DEPLOYMENT.md
### Sails Protocol — Reference Runtime Deployment Guide

> **Authority / status:** deployment guide for the TypeScript Reference Implementation. It is not a production-readiness certificate. Current production eligibility is governed by #105/#220 and bounded remediation owners; current scripts/configuration in the repository override dated deployment prose.
>
> **Rewritten 2026-07-18, updated 2026-08-02** — the 2026-07-18 rewrite
> predated `RFC-020`/`RFC-021`'s entire build-out and had already drifted
> in one concrete way: it documented `npm run db:migrate` (`prisma migrate
> dev`) as the schema-apply command, but at the time every real schema
> change in this repo since Prisma 7 landed had actually been applied via
> `npx prisma db push` — no `prisma/migrations/` directory existed yet.
> `package.json`'s own `db:migrate` script was silently wrong (still
> invoking `migrate dev`) until this pass fixed it to run `db push` for
> real, matching what actually worked at the time. This update also adds
> section 8 — a real AWS production deployment, written because a real
> deployment (real infrastructure, real MULTISIG custody, a self-funded
> live test — not opened to the public) is now actually happening, not a
> hypothetical future reader's problem.
>
> **Corrected 2026-08-09** — `prisma/migrations/` now exists (added
> 2026-08-07, real migration history, `db push` no longer the way schema
> changes ship) — the paragraph above is a historical record of the
> 2026-08-02 state, not current guidance. Real, reproduced bug found the
> same day diagnosing a fresh `docker compose up` from an empty
> database: a bare `prisma migrate deploy` fails applying the very first
> migration (`20260807_init`) immediately followed by any later
> migration in the same invocation. Fixed with a wrapper script
> (`scripts/migrate-deploy-safe.sh`, `docker-compose.yml`'s `migrate`
> service now uses it) — see that script's own header comment for the
> full diagnosis and workaround. The AWS RDS instance section 8 below
> describes was itself provisioned via `db push` before migration
> history existed, so this bug doesn't affect it directly; it matters
> for any genuinely fresh deployment going forward (a new environment,
> disaster recovery, or anyone cloning this repo and running `docker
> compose up` for the first time).

---

## 1. Prerequisites

- Node.js 20+ (`package.json`'s `engines` field)
- Docker + Docker Compose (for local Postgres/Redis — see section 3)
- Git

## 2. Environment Variables (`.env`, copy from `.env.example`)

`.env.example` at the repo root is the authoritative list — every
variable it defines is read in `src/config/index.ts`, which is itself
the single source of truth if this document and the code ever disagree.
The short version:

```bash
DATABASE_URL=postgresql://postgres:password@localhost:5432/sails_protocol
REDIS_URL=redis://localhost:6379
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
LOG_LEVEL=info
AUTH_CHALLENGE_TTL=120
AUTH_SESSION_TTL=3600
HYPERDHT_BOOTSTRAP=
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW=1 minute
RATE_LIMIT_AUTH_MAX=10
RATE_LIMIT_AUTH_WINDOW=1 minute
MOCK_ESCROW=true
MOCK_SETTLEMENT=true
# Required in production: escrow timelock policy in whole hours (>= 1),
# frozen on each escrow at creation (Master Backlog R5).
DEFAULT_TIMELOCK_HOURS=24
AUTO_SETTLE_ON_MATCH=false
TRUSTED_ARBITRATORS=
WDK_SEED_PHRASE=
WDK_RPC_URL=https://sepolia.drpc.org
WDK_USDT_CONTRACT=
```

There is no `JWT_SECRET` — authentication is real Ed25519 challenge-
response (`common/middleware/auth.ts`, `tweetnacl`), not JWTs. There is
no `PEAR_PEER_ID` env var either — a participant's `peerId` is generated
per-node at runtime (`pear.service.ts`'s `PearNode.start()`), not
configured statically.

**Important:** `MOCK_ESCROW=true`/`MOCK_SETTLEMENT=true` must be
`false` in any environment handling real value — `MockSettlementProvider`
generates fake transaction IDs and moves nothing real. Left `true` in
`NODE_ENV=production`, the app refuses to boot (`config/index.ts`'s own
hard stop, `RED_TEAM_REVIEW.md` RT-001) rather than silently running
theater-escrow in production.

**Low-priority hardening note (2026-09-06):** the `.env.example` values
shown above (`NODE_ENV=development`, `MOCK_ESCROW=true`,
`MOCK_SETTLEMENT=true`) are dev-oriented defaults, matching
`docker-compose.yml`'s own dev/mock posture — they are not a production
configuration and are not read as one anywhere in this document. This is
not a production blocker: the real Dockerfile sets
`NODE_ENV=production` explicitly, and the hard-stop guard above already
prevents the mock providers from running in production regardless of
what `.env.example` shows. Registered only as optional future DX
hardening — e.g. an inline comment in `.env.example` itself flagging
these three values as dev-only — not authorized or scheduled by this
note.

### 2.1 Database credentials and the price collector (#235 R7H-E2)

Migration `20261016120000_economic_authority_roles` creates two group roles
(`NOLOGIN`; no password is ever stored in a migration):

| Role | Used by | Can |
|---|---|---|
| `sails_app` | the application (`DATABASE_URL`) | read and write every application table; **read only** on valuation quotes, price observations and trade-limit policy rows; insert-only on exposure reservations |
| `sails_quote_collector` | the price collector (`QUOTE_COLLECTOR_DATABASE_URL`) | read the policy in force; insert valuation quotes and price observations; nothing else |

Migrations keep running as the schema owner (section 3). To separate the
runtime credentials, create one login per role, as the owner:

```sql
CREATE ROLE sails_app_login LOGIN PASSWORD '<secret>' IN ROLE sails_app;
CREATE ROLE sails_collector_login LOGIN PASSWORD '<other secret>' IN ROLE sails_quote_collector;
```

Then point `DATABASE_URL` at `sails_app_login` and set
`QUOTE_COLLECTOR_DATABASE_URL` to `sails_collector_login`. It must differ from
`DATABASE_URL`, or config load refuses to start.

While the application still connects as the owner, it logs an
`economic authority is not separated` error on every start. Until then, the
application credential can publish valuation quotes.

```bash
QUOTE_COLLECTOR_DATABASE_URL=postgresql://sails_collector_login:<other secret>@host:5432/sails_protocol
QUOTE_COLLECTOR_INTERVAL_MS=10000   # how often each node attempts the current 30 s window
QUOTE_SOURCE_TIMEOUT_MS=3000        # per exchange request (the publication bound is 10 s)
```

When `QUOTE_COLLECTOR_DATABASE_URL` is unset, no collector runs. No quote is
then published, so nothing new can be authorized once the newest quote passes
its maximum age. Existing escrows settle, dispute and recover without any
quote.

Every node may run the collector: the nodes publish one canonical quote per
window between them.

Check the exchanges from wherever the service runs:

```bash
npm run price:smoke
```

### 2.2 Trade-scoped Intent admission (B2): deployment prerequisites (#235 R7H-NF-E3C-5)

The audited B2 scope is **technically frozen** (RFC-018 Amendment A1). It is **not authorized for deployment**. The five
items below are mandatory prerequisites. **None is satisfied by this document or by the audit.** No production
environment was independently inspected, and nothing here claims production readiness.

| # | Prerequisite | How it is established | Status |
|---|---|---|---|
| 1 | Non-overlapping cutover (G-C1, R-2) | Every pre-B2 and pre-corrective instance is stopped **before** any B2 instance is started, and none remains active. A pre-B2 instance moves the *offer* Intent for B2 trades and keeps writing legacy-shaped trades and claims; a pre-corrective instance's attribution write is refused by the database (`23514`) and answers 500. A rolling or mixed-version deploy is not permitted. | NOT SATISFIED |
| 2 | No historical inferred attribution (R-1) | `SELECT count(*) FROM idempotency_reconciliation_audit WHERE decision <> 'UNRESOLVED';` returns **0** on the target database (equivalently `ALTER TABLE idempotency_reconciliation_audit VALIDATE CONSTRAINT idempotency_reconciliation_audit_unresolved_only;` succeeds). Migration `20261018140000` is forward-only: it does not undo an attribution that a pre-corrective build already persisted. | NOT VERIFIED on any environment |
| 3 | PostgreSQL session `TimeZone = UTC` (C-L2) | `SHOW TimeZone;` returns `UTC` on the application's connection (database, role and pool settings), until the admission-timestamp hardening is done. The B2 claim row's `createdAt` / `completedAt` use the session-local clock (measured +14 h and -12 h from the trade under UTC+14 / UTC-12 sessions). | NOT VERIFIED |
| 4 | B-1 resolved and verified | An offer cancelled or paused after validation, or inside the admission transaction, must refuse admission. Pre-existing: reproduced identically on the pre-B2 baseline `3ef9959`. Separate mission; must be resolved **before production exposure**. | OPEN |
| 5 | Explicit CTO authorization for deployment | A written CTO decision naming the exact commit. | NOT GRANTED |

Rollback note (R-3): the manual rollback comment in migration `20261018140000_legacy_claim_unresolved_only` re-adds the
old CHECK with validation, which fails once any `UNRESOLVED` row exists. Do not rely on it as written; the migration file
itself is not edited (it is already applied elsewhere).

## 3. Setup

**Docker-first path (2026-08-03) — no Node/npm on the host at all**, the
one this project now recommends by default (real per-service reasoning:
letting a non-technical project owner or a brand-new contributor get a
real, working instance up without installing a JS toolchain first):

```bash
git clone https://github.com/alan-schramm/Sails-Protocol.git
cd Sails-Protocol
docker compose up -d --build      # Postgres + Redis + the server itself — http://localhost:3000
```

That's the whole setup. `docker-compose.yml` (repo root) now has three
services: `postgres`/`redis` (real local infra, unchanged from before),
plus `migrate` (a one-shot `npx prisma db push` against `postgres`,
built from the Dockerfile's own `builder` stage so the real `prisma` CLI
is present) and `app` (the server itself, also built from `builder` —
deliberately not the slim `runtime` stage the production Dockerfile path
uses, since local dev wants `pino-pretty`'s readable logs, a
devDependency the production stage prunes). `app` waits for `migrate` to
finish successfully before starting, so a schema always exists before
the first request. `MOCK_ESCROW`/`MOCK_SETTLEMENT` stay `true` here —
this is the safe, no-secrets onboarding path; see section 8 for the real
AWS/`MULTISIG`-mainnet production path, which is deliberately separate.
**Verified against a real, cold run before this was written**, not just
reviewed — `docker compose down -v` first for a genuinely clean retry.

**If you're actively editing code** (hot-reload on save, not a Docker
rebuild per change):

```bash
cp .env.example .env              # defaults already match docker-compose.yml below
docker compose up -d postgres redis   # just the two real dependencies, not the app container
npm install
npm run db:migrate                # current command: `npx prisma migrate deploy`; applies committed migration history
npm run dev                       # http://localhost:3000 — hot-reload dev server
```

`docker compose down -v` removes the volumes if you want a clean database
either way.

**Not yet built:** `npm run db:seed` (`src/test/seeds/seed.ts`) is
referenced by `package.json` but the file doesn't exist — seeding is
still manual (via the routes, or `docs/HANDOFF.md`'s `npm run demo:qvac`
flow, which creates real participants/offers/intents/escrow as it runs).

**Verify it actually boots** rather than trusting this document — run
`npm test` first (600+ tests as of 2026-08-03, no external infra required, see section 4)
to confirm the code itself is sound, then `npm run dev` against the
Docker-composed Postgres/Redis above. `BACKLOG.md`, live GitHub Issues/Project, current provider/evidence records and exact-head CI carry current readiness truth. `HANDOFF.md` is historical and must not be used as the current readiness authority.

## 4. package.json Scripts (verified against the real file)

| Script | Command | Purpose |
|---|---|---|
| `dev` | `ts-node-dev --respawn --transpile-only src/main.ts` | Hot-reload dev server |
| `build` | `npm run build -w @satsails/p2p-schemas && npm run build -w @satsails/p2p-trading-sdk && tsc` | Builds both workspace packages, then the server (`dist/`) |
| `start` | `node dist/src/main.js` | Run the compiled build (note the `dist/src/` path — `tsc`'s inferred rootDir includes `packages/` via a `paths` alias, so output isn't flat under `dist/`) |
| `db:migrate` | `npx prisma migrate deploy` | Apply committed production migration history |
| `db:generate` | `npx prisma generate` | Regenerate the Prisma client (also runs automatically on `npm install`) |
| `db:seed` | `ts-node src/test/seeds/seed.ts` | ⚠️ Still not built — see section 3 |
| `db:studio` | `npx prisma studio` | Visual database browser |
| `demo:pix-to-usdt` | `ts-node --transpile-only examples/demo/pix-to-usdt-flow.ts` | The full QVAC → Pears → Intent Engine → WDK settlement flow |
| `demo:qvac` | `ts-node --transpile-only examples/demo/demo-satsails-qvac.ts` | Full-ecosystem entrypoint for the same flow — see `docs/HANDOFF.md` |
| `test` | `jest --runInBand` | 19 suites, 159 tests, no external infra required — every test mocks its own network/database boundary |

`src/main.ts` (the actual server entrypoint `dev`/`start` invoke) is
real — a thin wrapper around `app.ts`'s `startServer()`.

## 5. Dependencies (from `package.json`, current — spot-check this
   table against the real file if it's been a while since this doc was
   updated, rather than trusting it indefinitely)

**Runtime (selected — see `package.json` for the complete, exact-pinned
list):** `fastify` + `@fastify/cors`/`rate-limit`/`swagger`/`swagger-ui`/
`websocket`, `@prisma/client`, `zod`, `pino`, `dotenv` — the HTTP server
stack. `hyperdht`/`hyperswarm`/`b4a` — real Pears P2P transport.
`sodium-native` — real libsodium encryption for direct P2P Intent
delivery. `tweetnacl`/`tweetnacl-util` — real Ed25519 challenge-response
auth. `@tetherto/wdk-wallet-evm` — real signed USDT settlement (testnet).
`@qvac/sdk` — real local LLM inference. `@satsails/p2p-schemas` — the
in-repo types workspace package.

**Dev:** `typescript`, `ts-node`/`ts-node-dev`, `jest`/`ts-jest`,
`prisma`, `pino-pretty`, plus `@types/*` packages.

`npm install` also installs and builds `packages/sails-p2p-schemas` and
`packages/sails-sdk` (the real npm workspaces — root `package.json`'s
`workspaces` field).

## 6. Docker Compose

`docker-compose.yml` exists at the repo root (see section 3) — Postgres
16 + Redis 7, healthchecked, with named volumes for persistence across
restarts. No application container yet: the server itself still runs
via `npm run dev`/`npm start` on the host, not inside Compose — adding
an `app` service is reasonable follow-up work once there's a reason to
containerize the server too (e.g. a real staging deployment), not
required for local development.

## 6.1 Migration Failure Recovery (Prisma P3009)

Real incident, found and reproduced 2026-08-23 auditing this exact
`docker compose` path (Missão 11 Fase 7.3/7.3.1): `docker compose run
migrate` refused to run with:

```
Error: P3009
migrate found failed migrations in the target database, new migrations
will not be applied.
```

**What this means**: Prisma's own `_prisma_migrations` bookkeeping table
inside the target database has a row recording a migration that started
and never completed successfully. Prisma refuses to apply anything else
until an operator explicitly resolves that row — it will never guess on
your behalf, and neither should you.

**How this happens in practice**: an earlier deploy (or a local/dev
session) started applying a migration against this exact database, and
the process was interrupted, the migration's SQL genuinely failed
partway, or the migration file was later renamed/deleted before its
bookkeeping row was ever resolved. The failed row can reference a
migration name that no longer even exists in `prisma/migrations/` on
disk — this is not a corrupted repository, it is a database that
remembers an attempt the current codebase has moved past.

**The unsafe thing to do**: run `prisma migrate resolve
--rolled-back <name>` (or `--applied`) based on a guess, "it's probably
fine," or because that's what unblocks the deploy fastest. Both commands
only edit Prisma's bookkeeping — they do **not** touch the actual
database schema. Marking a migration `--rolled-back` when its SQL
actually *did* apply leaves the schema and Prisma's own belief about the
schema permanently out of sync; marking one `--applied` when it did not
actually run leaves referenced tables/columns/indexes missing until
something in production trips over their absence.

**The safe procedure — verify before touching bookkeeping, every time:**

1. `npx prisma migrate status` — identifies exactly which migration is
   marked failed, and lists everything else pending behind it.
2. Read that migration's `.sql` file from `prisma/migrations/<name>/` if
   it still exists on disk. If it doesn't exist in the current
   checkout, check `git log --all --diff-filter=A -- 'prisma/migrations/<name>/*'`
   to find the commit that introduced it, so you know exactly what it
   was supposed to do.
3. **Directly inspect the target database** for the specific
   tables/columns/indexes/constraints that migration's SQL would have
   created — `\d <table>` in `psql`, or the equivalent — to determine,
   from real evidence, whether it fully applied, partially applied, or
   never ran at all. Do not infer this from log output alone; logs can
   be incomplete or already rotated away.
4. Only once you know which of the three states above is true:
   - **Never ran / has zero effect visible in the schema** →
     `npx prisma migrate resolve --rolled-back <name>`, then re-run
     `migrate deploy` normally.
   - **Fully applied, schema matches exactly what the SQL describes** →
     `npx prisma migrate resolve --applied <name>`, then re-run
     `migrate deploy` normally.
   - **Partially applied** (some but not all of its DDL took effect) →
     do **not** use either resolve command yet. Manually apply or revert
     the missing/extra pieces via `prisma db execute` first (see
     `scripts/migrate-deploy-safe.sh`'s own header comment for a real,
     narrower precedent of this exact "apply outside the normal
     `migrate deploy` invocation, then resolve the bookkeeping" pattern),
     so the database and the migration's SQL agree completely, and only
     then mark it `--applied`.
5. Re-run `npx prisma migrate status` again after resolving — it must
   report a clean state (no failed migrations, only whatever is
   genuinely still pending) before proceeding to `migrate deploy`.

This same procedure applies identically whether the affected database is
a throwaway local Docker volume or a real production instance — the
stakes differ, the verification discipline should not.

## 6.2 Backup / Restore Procedure (Missão 11 Fase 8.1 LB-06)

Operator-driven for the first controlled launch — no automated backup
scheduler is wired into this codebase yet. A backup that has never been
restored is not a proven backup: the exact commands below were run for
real (2026-08-24) — a genuine `pg_dump` from a live database holding
representative rows across every economically-relevant table (escrows,
disputes, arbiter/participant key commitments, fee policies, distribution
policies, collection evidence, fee obligations, entitlement ledger,
custody attestations, migration state), restored into a brand-new, empty
Postgres instance, with `prisma migrate status` confirming a clean schema
match and exact row-counts confirmed identical across every table
afterward — not assumed to work from reading `pg_dump`'s own manual.

### Required PostgreSQL compatibility

**`pg_dump`/`pg_restore` must be the same major version as the target
server, or newer — never older.** Found for real running this rehearsal:
this project's local dev Postgres runs 18.4; a `postgres:16-alpine`
image's `pg_dump` refused outright (`pg_dump: error: aborting because of
server version mismatch`) against it. `docker-compose.yml`'s own
`postgres` service is pinned to `postgres:16-alpine` — if the real
production Postgres version differs from that (AWS RDS provisioning
determines this independently), the operator must use a `pg_dump`/
`pg_restore` binary matching *that* version, not necessarily this repo's
compose file. Confirm the live server's version first with `SELECT
version();` before choosing the dump tool's own image tag.

### Backup command

```bash
# Custom format (-Fc): supports pg_restore's own selective/parallel
# restore and is compressed by default — plain SQL (-Fp) also works but
# produces a much larger file for no real benefit here.
pg_dump -h <host> -p <port> -U <user> -d sails_protocol -Fc \
  -f sails_protocol_$(date +%Y%m%d_%H%M%S).dump
```

Run this against the real production connection string when the time
comes; rehearsed above against a local instance via a throwaway
`postgres:18-alpine` Docker container reaching the host database over
`host.docker.internal`.

### Restoration order

1. Provision a genuinely fresh, empty Postgres instance/database — never
   restore on top of an existing one (a partial restore into a
   non-empty database is a real corruption risk, not a shortcut).
2. `pg_restore -h <host> -p <port> -U <user> -d sails_protocol \
   --no-owner --no-privileges sails_protocol_<timestamp>.dump` —
   `--no-owner`/`--no-privileges` matter whenever the restore target's
   own role names differ from the source's (true by construction for a
   disaster-recovery restore onto new infrastructure).
3. `npx prisma migrate status` against the restored database — must
   report "Database schema is up to date!" with zero drift before
   anything else touches it.
4. Spot-check row counts against whatever monitoring/last-known-good
   numbers exist for the source (exact match is the expected outcome —
   `pg_dump`/`pg_restore` do not silently drop rows).
5. Only then repoint the application's own `DATABASE_URL` at the
   restored instance.

### Verification procedure (what "restore succeeded" actually means)

Confirmed for real during this rehearsal, not merely documented:

- `_prisma_migrations` row count and contents match the source exactly.
- Every hand-written database-native invariant survives the dump/restore
  byte-for-byte — confirmed directly: `custody_attestations_immutability_guard`
  (the append-only trigger) and `custody_attestations_single_active_per_recipient_asset_key`
  (the partial unique index) were both still present and named identically
  in the restored database. `pg_dump`'s default schema dump includes
  triggers/functions/indexes automatically; this is expected behavior,
  confirmed rather than assumed.
- Representative historical rows read back with identical content (not
  just count) — confirmed for a real `escrows` row.

### Encryption / storage expectations

Not yet decided operationally — recorded here as an open item, not
silently assumed either way. At minimum before a real production backup
is taken and stored: the dump file must be encrypted at rest (AWS S3
server-side encryption, or an explicit `gpg`/`age` step before upload,
either is acceptable — no preference recorded here) and access-controlled
separately from the application's own runtime credentials (a backup
containing every historical CustodyAttestation/FeePolicyVersion/escrow
row is at least as sensitive as the live database itself). Retention
period and off-host storage location are operator decisions for the real
launch runbook, not fixed by this document.

### Operator STOP conditions

Do not proceed with a restore, and escalate instead, if:

- The source dump's `pg_dump`/`pg_restore` tool version is older than the
  target server's major version (silently proceeding risks a subtly
  incomplete or failed restore, not just the loud refusal seen in this
  rehearsal — never force past a version-mismatch warning).
- The restore target is not genuinely empty (restoring on top of any
  existing rows is not a supported or rehearsed path).
- `prisma migrate status` reports drift or a failed migration after
  restore — treat this identically to the Migration Failure Recovery
  runbook (§6.1 above), on the restored copy, never on the only backup
  available.
- Row counts for any economically-relevant table (the list at the top of
  this section) do not match the last known source counts — investigate
  before repointing any application traffic at the restored database.

## 7. Production Considerations

- [ ] Reverse proxy/TLS — closed differently than originally planned:
      AWS App Runner terminates TLS itself (real HTTPS on its own
      `*.awsapprunner.com` domain, zero nginx/cert config needed) — see
      section 8. If a custom domain is later put in front via
      CloudFront/ALB instead, set Fastify's own `trustProxy` option
      (`app.ts`) so rate limiting's per-IP tracking sees the real client
      IP, not the proxy's.
- [x] **`MOCK_ESCROW=false`/`MOCK_SETTLEMENT=false` decision made,
      2026-08-02**: real custody goes live via **`MULTISIG`, not
      `WDK_USDT_EVM`** — deliberately. `MULTISIG` is a genuine 2-of-3
      (buyer/seller hold their own keys, only the arbiter is a server
      key); `WDK_USDT_EVM` is explicitly single-seed custody, and its own
      header comment says testnet-only for exactly that reason. See
      section 8 for the real `MULTISIG_NETWORK=bitcoin` production
      checklist.
- [x] **Rate limiting is in place** — `@fastify/rate-limit`, global +
      tighter auth-route tier (`docs/THREAT_MODEL.md`). Still open: no
      per-API-key tier, only per-IP.
- [x] **Ed25519 auth middleware is in place** — real challenge-response
      (`common/middleware/auth.ts`), not a placeholder. There is no
      `JWT_SECRET` to configure; nothing here needs one.
- [x] **Capability Authority is mandatory in production** (RFC-014,
      ADR-004, Issue #303): `NODE_ENV=production` refuses to boot unless
      `ENFORCE_CAPABILITIES=true` exactly (unset, `false`, or any other
      value is fatal). Participants self-issue the canonical grants
      (`trade-coordination`, `settlement`) via the SDK's
      `capabilities.ensureCanonicalGrants()` - the reference UI does it on
      every login. **Arbiters and sellers need the `settlement` grant
      too**: an assigned arbiter without it cannot execute a ruling, and
      the expiry sweeper refunds as the seller, so a seller without it is
      reported in `failed[]` until it onboards (no system exemption).
      Self-issued grants are the participant's own consent, **not
      independent third-party authorization**. **Escrow release has a
      two-person control option** (RFC-015, `REQUIRE_DUAL_APPROVAL_RELEASE`),
      real and off by default; turning it on changes the required calling
      pattern for a release - read RFC-015's Decision §5 before enabling it,
      it is not a drop-in flag flip.
- [x] **`MULTISIG`'s release/refund/split fee is a real rate lookup**
      (`mempool.space /v1/fees/recommended`, 2026-08-02) — the flat
      1000-sat placeholder this file previously left as future work is
      gone; a real Bitcoin spend now pays a real, current fee instead of
      risking an unconfirmed stuck transaction.
- [ ] **Not yet closed, stated plainly rather than glossed over now that
      real funds are actually in scope**: no external security audit of
      this codebase has happened. The plan (per the project owner,
      2026-08-02) is to have a real, working deployment first — small,
      self-funded, not opened to the public — specifically so an
      external reviewer (the intended next step, tied to a Tether grant
      conversation) has something real to evaluate rather than a
      hypothetical design. This is a deliberate, informed sequencing
      choice, not an oversight being carried forward silently.
- [ ] **`MULTISIG`'s single-arbiter limitation still applies** —
      exactly one `TRUSTED_ARBITRATORS` entry is baked into each escrow's
      script at creation time (`multisig.provider.ts`'s own comment). Not
      a blocker for a self-funded test with no disputes expected, but a
      real constraint before any third party's funds are involved.
- [x] **A real Postgres run against production infra is happening as
      part of this deployment** (section 8) — every schema change before
      this was only ever verified via `prisma generate` against no live
      Postgres. `npx prisma db push` (not `migrate dev`/`migrate deploy`
      — no migration history exists in this repo, see this file's own
      2026-08-02 header note) is the real, tested command, run once
      against the new RDS instance before the service's first real
      traffic.

## 8. AWS Production Deployment (2026-08-02)

**Scope, stated explicitly rather than assumed**: a real, live deployment
— real domain, real Postgres, real `MULTISIG` custody on Bitcoin mainnet
— funded by the project owner's own balance to validate the full flow in
practice, not opened to the public. The plan is to have this working
first, then bring in external security review with something real to
evaluate (tied to a Tether grant conversation) — a deliberate sequencing
choice, not a shortcut around review.

Architecture, chosen for this stage specifically (SLC: simple and
complete, not maximal):

- **Compute: AWS App Runner** — a container-based managed service with a
  real HTTPS endpoint out of the box (`*.awsapprunner.com`), no
  nginx/ALB/ACM certificate configuration needed to get real TLS. Builds
  from the repo's own `Dockerfile` (root, added 2026-08-02).
- **Database: Amazon RDS for PostgreSQL**, smallest real instance class
  (`db.t4g.micro`), single-AZ — a managed real Postgres, not the local
  Docker Compose one section 3 uses for development.
- **Secrets: AWS Secrets Manager** — `DATABASE_URL`, `MULTISIG_SEED`,
  and any other sensitive value are stored here and referenced by App
  Runner's own environment-variable-from-secret binding, never typed
  directly into the App Runner console's plain env var fields and never
  passed through a chat/AI session.

### 8.1 Dockerfile

Root `Dockerfile` (2026-08-02) — a two-stage build: `builder` installs
the full workspace (`npm ci`) and runs this repo's own `npm run build`
(the exact same command `section 4`'s table already documents, not a
Docker-specific build path), then `runtime` copies only the pruned
`node_modules`, `dist/`, `prisma/`, and the two workspace packages'
build output (`packages/sails-sdk`, `packages/sails-p2p-schemas` —
npm-workspaces symlinks, both sides need to exist). `node:20-bookworm-slim`
(glibc), not `alpine`: this project's native dependencies
(`sodium-native`, `tiny-secp256k1`) are markedly more reliable to build
against glibc than musl. **Not build-tested against a live Docker daemon
as of this writing** (this pass had no `docker` CLI available) — the
first real `docker build .` (locally, if Docker Desktop is available, or
via App Runner's own build service) is the actual first real test; if it
fails, the error will point at exactly which assumption above was wrong.

### 8.2 Setup order

1. **IAM** — a dedicated IAM user for deployment (not the AWS root
   account) with an access key, used only from your own machine/AWS
   CLI — never pasted into a chat session.
2. **RDS** — create the Postgres instance, keep it *not* publicly
   accessible (App Runner reaches it via a VPC connector, not the public
   internet).
3. **Secrets Manager** — store `DATABASE_URL` (built from the RDS
   endpoint + master password from step 2) and `MULTISIG_SEED` (a real,
   securely-generated seed — generate it locally, e.g. `openssl rand
   -hex 32`, and paste it directly into Secrets Manager, never into a
   chat session or a file that gets committed).
4. **App Runner** — create a service from the GitHub source, Dockerfile
   build mode, port 3000, environment variables per section 8.3 below
   (non-secret ones set directly, secret ones referenced from step 3).
5. **`npx prisma db push`** against the RDS instance — run once, from a
   machine that can reach the database (locally via an SSH
   tunnel/bastion, or as a one-off App Runner/ECS task), *before* the
   service serves its first real request. This is the "real Postgres
   migration run" section 7 flags as newly closed.

### 8.3 Production environment variables (real values, not the
    `.env.example` local-dev defaults)

```bash
NODE_ENV=production
DATABASE_URL=                      # from Secrets Manager — the real RDS endpoint
PORT=3000
HOST=0.0.0.0

MOCK_ESCROW=false
MOCK_SETTLEMENT=false

# MULTISIG — the real-custody path for this deployment (not WDK_USDT_EVM,
# see section 7's own reasoning). MULTISIG_SEED from Secrets Manager.
MULTISIG_SEED=                     # from Secrets Manager
MULTISIG_NETWORK=bitcoin
MULTISIG_EXPLORER_API_URL=https://mempool.space/api

# Exactly one arbiter identity — multisig.provider.ts's single-arbiter
# limitation (section 7) requires this to stay a single entry.
TRUSTED_ARBITRATORS=<one-participant-id>
ARBITRATION_MODE=trusted-list

# Everything else (RATE_LIMIT_*, AUTH_*, PROTOCOL_FEE_RATE, the sweeper
# flags) can stay at .env.example's own documented defaults unless this
# deployment specifically needs otherwise — see each variable's own
# comment there before changing it.
```

Deliberately **not** set for this deployment: `WDK_SEED_PHRASE`,
`AWS_KMS_KEY_ID` (`SAFE_GUARD_EVM`) — both stay empty, keeping those two
providers inert, consistent with the decision to bring exactly one real
custody path live at a time.

**Updated (Issue #220, 2026-09-27):** this is no longer only a
configuration convention. With `NODE_ENV=production`, the application
itself refuses to create or settle `LIGHTNING_HODL`, `SAFE_GUARD_EVM`, and
`WDK_USDT_EVM` escrows (`escrow-providers.ts`'s
`PRODUCTION_INELIGIBLE_TYPES`), regardless of which secrets are set. In
production, `LN_BTC` and `USDT_ERC20` escrow creation therefore fails with
an explicit "not economically eligible in production" error; `BTC` via
`MULTISIG` is the only production settlement rail.

## 9. Multi-Instance Deployment (Missão 08B, 2026-08-17)

Section 8's deployment above runs a single App Runner instance. Running
**two or more instances behind a load balancer** (App Runner's own
auto-scaling, or any other setup) is safe for the primary HTTP + WebSocket
trading experience as of this mission, provided every instance shares the
same real Postgres and Redis — real, tested via genuinely separate Node
processes sharing one dockerized Postgres/Redis, not simulated in one
process. What makes this true, and what still doesn't:

- **Durable state (source of truth) — Postgres, always instance-independent.**
  Every Trade/Message/Escrow/Dispute write, and the full `durable_events`
  event log (`PostgresEventStore`, RFC-010), lands in Postgres regardless
  of which instance handled the request. Restarting or replacing any
  instance never loses data.
- **Real-time push across instances — Redis Pub/Sub, a signal only.**
  `PostgresEventStore.publish()` broadcasts every event on
  `sails:cross-instance-events` (see `docs/DATABASE.md`'s Redis key
  table) so an instance whose WS clients didn't originate an event still
  learns about it immediately and pushes it to its own connected
  sockets. If Redis is briefly unreachable, this fan-out fails silently
  and is logged — the durable write already succeeded either way; the
  only thing lost is *live* delivery to another instance's sockets for
  events published during the outage (not: the events themselves, which
  remain queryable via `getEvents()`/reconcile). The subscriber
  reconnects and resumes automatically once Redis recovers — no app
  restart needed.
- **Which sockets get a push — process-local, and correctly so.**
  `chat-room-registry.ts`'s room membership is a plain in-process `Map`,
  one instance's own view of who's currently connected to *it*. This is
  deliberately not shared — fixing the event fan-out above is sufficient,
  since each instance already only needs to know about its own sockets.
- **Auth-tier and critical-tier rate limits — shared via Redis.**
  `/v1/identity/challenge`+`authenticate` and the dispute/capability-revoke/
  agent-intent routes share one counter across every instance
  (`common/middleware/redis-rate-limit.ts`) instead of each instance
  getting its own full budget. Both fail closed (503) if Redis is
  unreachable — both tiers already hard-depend on Redis independent of
  rate limiting (session/challenge lookups), so this adds no new failure
  mode. The global and WS-message tiers stay local/per-instance,
  unchanged, by design (low-severity volume ceiling, not a security
  boundary in the same sense).
- **Escrow circuit breaker — process-local by design, not a gap.**
  `escrow-circuit-breaker.ts` is a secondary fast-reject optimization; the
  real correctness guarantee is `claimEscrowTransition()`'s atomic
  Postgres `updateMany`+count-check, which is already instance-independent.
  Not moved to Redis.
- **`pearNodeRegistry` / Pears-HyperDHT P2P transport — process-local,
  a real deployment constraint, not fixed by this mission.** A `PearNode`
  holds live DHT/socket state with no serializable resumable form — a
  participant's real-time P2P connection is pinned to whichever instance
  first accepted it. Postgres reconciliation (RFC-011,
  `reconcileTrade()`) is what a client should fall back to for anything
  missed, same as it already is for any transient drop.
- **WS-ticket single-use property (GET-then-DEL)** — a documentation-only
  note carried over from Missão 08A's audit, not escalated: a real
  window exists in principle between reading and deleting a ticket in
  Redis where two racing requests could theoretically both see it valid.
  No real replay was produced during this mission's multi-instance
  testing; left as a known, disclosed limitation rather than a fixed
  finding.
- **OpenProof evidence storage — instance-independent ONLY when
  `EVIDENCE_PROVIDER=s3` (Issue #265).** `LocalFilesystemEvidenceProvider`
  (this section's silence on evidence storage before Issue #265 was
  itself a gap, found during Missão/Issue #234's own audit) writes to a
  path on the container's own local disk — not shared across instances
  and not durable across a redeploy. `S3EvidenceProvider`
  (`src/modules/open-proof/s3-evidence-provider.ts`) is the
  instance-independent, restart-durable alternative: any S3-compatible
  bucket (AWS S3, Cloudflare R2, MinIO) reachable by every instance.
  `config/index.ts` refuses to boot in production with
  `EVIDENCE_PROVIDER` unset/`local-fs` — see §8's env var table pattern;
  set `EVIDENCE_PROVIDER=s3` plus `EVIDENCE_S3_BUCKET`/
  `EVIDENCE_S3_ACCESS_KEY_ID`/`EVIDENCE_S3_SECRET_ACCESS_KEY` (and
  `EVIDENCE_S3_ENDPOINT`/`EVIDENCE_S3_REGION`/`EVIDENCE_S3_FORCE_PATH_STYLE`
  for a non-AWS S3-compatible vendor). `EVIDENCE_S3_REQUEST_TIMEOUT_MS` is an optional
  operator-selected per-request cancellation bound; there is intentionally no protocol
  default. For mutating S3 operations, expiry means the local request was cancelled and
  the remote outcome remains unknown — it is not proof that a write/delete did not commit.

None of the above requires sticky sessions at the load balancer — any
instance can serve any HTTP request or accept any new WebSocket
connection; a client's own SDK-side reconnect-with-backoff handles
picking up wherever it lands next.

### 9.1 Background sweepers — SINGLE-ACTIVE-WORKER constraint (Missão 11 Fase 8.1, not yet lifted)

The HTTP/WebSocket multi-instance safety proven above does **not** extend
to the background sweepers (`app.ts`'s `setInterval`-based jobs:
escrow-timelock, dispute-auto-resolution, MULTISIG fee-confirmation, and
the two Fase 8.1 reorg sweepers). Each is a plain per-process timer with
no cross-instance coordination — running two or more instances with any
of these sweepers enabled means **every** instance independently runs
its own copy on its own schedule.

This was deliberately **not** re-architected into a distributed
coordination system for the first controlled launch, per this Fase's own
"do not expand architecture merely to claim multi-instance readiness"
instruction. What is and isn't actually at risk, reasoned from the code
that exists today:

- **State corruption: not expected.** Every sweeper's actual state
  transition goes through the same atomic Postgres primitives the
  multi-instance HTTP proof above already relies on
  (`claimEscrowTransition()`'s conditional `updateMany`,
  `transitionCollectionStatus()`, `recordReorgAndRevert()`'s own status
  check) — a second instance's concurrent attempt on the same row loses
  the race and no-ops or is rejected, the same way two concurrent HTTP
  requests already are proven to behave.
- **Real, present cost: duplicate work.** Two instances both sweeping on
  the same interval means duplicate explorer API calls (MULTISIG
  confirmation/reorg sweepers), duplicate query load, and duplicate log
  noise for the same underlying event — wasteful, not corrupting.
- **Not independently verified under two real concurrent instances** —
  unlike the HTTP/WS proof above (genuinely tested with separate Node
  processes), this reasoning has not been exercised the same way for the
  sweepers specifically. Treated as unverified, not assumed safe.

**Operational constraint for the first controlled launch:** enable sweeper
feature flags (`ESCROW_TIMELOCK_SWEEPER`, `DISPUTE_AUTO_RESOLUTION_SWEEPER`,
`MULTISIG_FEE_CONFIRMATION_SWEEPER`, `MULTISIG_FEE_REORG_SWEEPER`,
`MULTISIG_FUNDING_REORG_SWEEPER`) on **exactly one** designated instance;
leave them unset (the default) on every other instance. This requires no
code change — every sweeper is already off by default and independently
flag-gated per instance's own environment.

**If/when a genuine need for sweepers-on-every-instance arises:** the
smallest deterministic fix, proposed here rather than built (per this
Fase's own instruction to propose before introducing new distributed
coordination), is a short-TTL Redis lease acquired at the top of each
sweeper tick (`SET sweeper:<name>:lease <instanceId> NX PX <intervalMs>`)
— only the instance holding the lease for that tick actually runs the
sweep body; every other instance's tick is a fast no-op. Redis is already
a hard dependency for this codebase (sessions, rate limiting, cross-
instance pub/sub), so this adds no new infrastructure, only a small,
well-understood locking primitive — not implemented in this phase.
