# Database migrations: classification, controls and expand/contract

Status: CURRENT (2026-10-24, introduced by P3-R3). Scope: `prisma/migrations/*/migration.sql` and how a release applies them.
This document describes controls that exist in the repository; where a control is only planned it says so.

## Why this matters for a self-hosted operator

A self-hosted node updates by running the migration job first and starting the new server second
(`docs/SELF_HOSTING.md`, `docs/DEPLOYMENT.md` 6.0). During the update, and after a rollback, the **previous** server
version runs against a **newer** schema. A migration that removes or reshapes something the previous version still uses
turns a routine update (or its rollback) into an outage, and the operator has no vendor to call. The controls below make
that visible in review and in CI.

## Classification

Every migration is classified by `scripts/migration-lint.js`, statement by statement (comments, string literals and
trigger-function bodies are ignored; a constraint added to a table created by the same migration is not a risk because the
table is empty):

| Class | Typical statements | What it means for the previous server version |
|---|---|---|
| `additive` | `CREATE TABLE`, `ADD COLUMN` (nullable or with `DEFAULT`), `CREATE INDEX`, `ALTER TYPE ... ADD VALUE`, constraints on a new table | Keeps working. |
| `potentially-destructive` | `DROP INDEX/CONSTRAINT/TRIGGER/FUNCTION/VIEW/DEFAULT`, `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `RENAME`, `ADD COLUMN ... NOT NULL` without `DEFAULT`, new `UNIQUE`/`FOREIGN KEY`/`CHECK` over an existing table, `UPDATE` | May break old code, or may fail on existing data and block the rollout. Needs a reviewed reason. |
| `destructive` | `DROP TABLE`, `DROP COLUMN`, `DROP TYPE/SCHEMA`, `TRUNCATE`, `DELETE FROM` | Loses data or an old code path. Needs a reviewed reason and an earlier expand step. |

The classification is a lint, not a proof: it reads SQL text. It cannot see that an `UPDATE` is harmless, or that a data
migration written in a function body is not. Reviewers decide; the lint makes sure they are asked.

## Controls in CI (`ci.yml`, step "Migration lint and old-version compatibility probe")

1. **Immutability.** `scripts/migration-lint.baseline.json` freezes every shipped migration with its SHA-256. Editing a
   frozen file fails CI, because the server compares Prisma's stored checksum with these exact bytes (no line-ending
   normalisation; `.gitattributes` pins the SQL to LF). Removing a frozen migration also fails.
2. **Annotation for non-additive new migrations.** A migration that is not in the baseline and is not `additive` must start
   with a line of the form

   ```
   -- migration-class: contract: <why this is safe, and which release stopped using the old shape (20+ characters)>
   ```

   Without it CI fails. The annotation is the author's statement that the expand/contract steps below were followed; it is
   a prompt for the reviewer, not a replacement for review.
3. **Old-version compatibility probe** (`scripts/migration-compat-probe.js`). On a throwaway database it applies the
   frozen migrations (what the previous release shipped), snapshots `information_schema`, applies the new migrations, and
   snapshots again. It fails on a removed table or column, a changed column type, a column that became `NOT NULL`, a new
   `NOT NULL` column without `DEFAULT` on an existing table, or a removed enum value. New tables, new nullable/defaulted
   columns and new enum values pass. It creates and drops its own database; it never touches an existing one.
4. **Freezing at release.** When a release is cut, `node scripts/migration-lint.js --write-baseline` records the
   migrations it shipped. That is a reviewed commit: it is what turns "new" into "shipped" for the two controls above.

Hardening added in P3-R4 after adversarial review (each has a test in `tests/migrationControls.test.ts`):
an anonymous `DO $$ ... $$` block is never classified additive (it can `EXECUTE` DDL the text lint cannot read); the
annotation counts only in the leading comment block (not after the statement, not inside a block comment or a function
body); the probe also flags a narrowed `varchar`/`numeric` and a `DEFAULT` removed from a `NOT NULL` column; a
whitespace-only or CRLF-only edit of a frozen migration fails.

### Schema compatibility is not query compatibility

The probe answers "does every column the old server knew still exist, with a type and nullability it can use?". It does
**not** answer "does every query of the old server still return the same result?". Things it cannot see: a new `UNIQUE`,
`CHECK` or foreign key that an old write now violates (it depends on the data and on the code); a changed meaning of an
existing column; an enum value added by the new version that the old Prisma client cannot read back (reading such a row
throws in the old client); row-level triggers; lock duration and table rewrites on large tables; data migrations. The
lint's `potentially-destructive` class and the reviewer's annotation cover the first of these by asking a human; nothing
here replaces running the previous server's own test suite against the new schema, which is a planned step
(`docs/P3_NEXT_PHASE_TEST_PLAN.md`).

What the probe does **not** prove: that the previous server's *queries* still work (it compares the schema shape, not the
code); behaviour of data migrations on production-sized data; lock durations. These need the staged tests listed in
`docs/P3_NEXT_PHASE_TEST_PLAN.md`.

## Expand / contract: how to change a shape safely

A breaking change is split across at least two releases; the migration for the second may only ship after the first has
been out long enough that nobody is expected to roll back past it.

| Change | Release N (expand) | Release N+1 or later (contract) |
|---|---|---|
| Drop a column | Stop reading and writing it in code; keep the column. | `DROP COLUMN`, annotated, after N is the oldest version anyone may roll back to. |
| Rename a column | Add the new column, write both, backfill, read the new one. | Drop the old column (as above). |
| Change a column type | Add a new column of the new type, write both, backfill. | Switch reads, then drop the old column. |
| Make a column `NOT NULL` | Backfill, write non-null values from code. | `SET NOT NULL`, annotated. |
| New `UNIQUE`/`FOREIGN KEY` over existing rows | Ship code that already respects it; check existing data for violations. | Add the constraint, annotated. |
| Remove an enum value | Stop writing it; migrate existing rows. | Recreate the type without it, annotated. |

Rollback rule that follows: **a release whose migrations are all `additive` can be rolled back by restarting the previous
image.** A release with a contract migration cannot. `sails-node rollback` does **not** check this: it starts the previous
image and prints a warning that the kit cannot verify the previous version still works on the newer schema. The pre-update
backup (`sails-node backup`) is the recovery path. Making rollback refuse automatically when the release notes list a
contract migration is a gap, recorded in `docs/BACKLOG.md`.

## Hard rules

- Never edit a migration that has shipped; write a new one.
- Never run migrations against a shared or production database from a development machine or from CI. CI uses its own
  throwaway PostgreSQL; the probe creates its own database inside it.
- A migration that fails halfway leaves a failed row in `_prisma_migrations` (Prisma error P3009). The migration gate
  (`src/common/database/migration-gate.ts`) ignores a failed row for a migration this image does not ship and refuses to
  boot on one it does; recovery is described in `docs/SELF_HOSTING.md`.

## Known limits of the existing history

The baseline freezes 37 migrations as they were on 2026-10-24: 25 additive, 11 potentially-destructive and 1 destructive
by this lint (`20260809090000_remove_offer_requires_kyc` drops `offers.requiresKyc`; the compatibility probe flags it
against a baseline that predates it, which is the check working on real history). That is a measurement of history, not a
defect list: most potentially-destructive entries are unique indexes or foreign keys added to tables that existed at the time. They are frozen without annotations because they already
shipped; the controls apply to everything after them.
