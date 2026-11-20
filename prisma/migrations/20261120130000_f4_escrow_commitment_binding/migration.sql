-- F4 / invariant 3b (CTO Despacho 021, P63; P54b §§5-10, GK F3/F4 closed design): the economic cut.
--
-- WHAT THIS DOES, IN ONE TRANSACTION (P54b §6.2): it binds every NEW escrow to a COMMITTED commitment pair in the database
-- itself, so that no code path (a text scan cannot see an alias, raw SQL, a script or another process) can create an escrow, store a
-- deposit address or register funding without it; and it marks every escrow that already exists as legacy, so those finish their
-- cycle under the rules that already exist.
--
-- ORDER (do not reorder): lock -> columns -> marks -> triggers. The marks are written BEFORE the triggers exist, because the
-- immutability trigger would refuse the marking itself; and no INSERT can slip in between, because the table lock is held to COMMIT.
--
-- TRANSACTION: this file has NO BEGIN/COMMIT. It relies on `prisma migrate deploy` wrapping it in a transaction; LOCK TABLE
-- below is a GUARD for that: outside a transaction block it raises "LOCK TABLE can only be used in transaction blocks" and the
-- migration fails closed (A1: the wrapping is proved in a disposable PostgreSQL by the S1 test; if it is not wrapped, the file gets
-- explicit BEGIN/COMMIT instead).
--
-- DECIDED (CTO Despacho 029, B): deny by default; the only exemption is MOCK (function escrows_f4_pair_required() below).
--
-- Reversal (not applied automatically):
--   DROP TRIGGER escrows_f4_guard_lock ON "escrows"; DROP TRIGGER escrows_f4_guard_update ON "escrows";
--   DROP TRIGGER escrows_f4_guard_insert ON "escrows";
--   DROP FUNCTION escrows_f4_guard_lock(); DROP FUNCTION escrows_f4_guard_update(); DROP FUNCTION escrows_f4_guard_insert();
--   DROP FUNCTION escrows_f4_pair_required("EscrowType");
--   ALTER TABLE "escrows" DROP CONSTRAINT "escrows_commitmentPairId_fkey", DROP COLUMN "addressPresentAtCutAt",
--     DROP COLUMN "legacyPreCommitmentAt", DROP COLUMN "commitmentPairId";

-- A2: bounded waits BEFORE the lock. A queued lock otherwise blocks all traffic behind it (lesson of #622). If either limit is
-- hit, the migration fails clean and is re-run inside the maintenance window.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Block concurrent INSERT/UPDATE/DELETE on escrows (reads pass). An INSERT in progress finishes before this lock is granted;
--    one that arrives later waits and then runs under the triggers below. Also the guard that this file runs in a transaction.
LOCK TABLE "escrows" IN SHARE ROW EXCLUSIVE MODE;

-- 2. Columns and the foreign key. The two marks are written ONLY by this migration (step 3); the runtime role gets no grant on
--    them (scripts/db/runtime-grants.sql) and the triggers below refuse any other write.
ALTER TABLE "escrows"
    ADD COLUMN "commitmentPairId" TEXT,
    ADD COLUMN "legacyPreCommitmentAt" TIMESTAMPTZ(3),
    ADD COLUMN "addressPresentAtCutAt" TIMESTAMPTZ(3);

ALTER TABLE "escrows"
    ADD CONSTRAINT "escrows_commitmentPairId_fkey" FOREIGN KEY ("commitmentPairId") REFERENCES "commitment_pairs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. The two marks, from ONE instant taken under the table lock (no parameter anyone could move earlier or later):
--      legacyPreCommitmentAt  on EVERY existing row (no date filter);
--      addressPresentAtCutAt  only on rows that already HAD a deposit address at that instant.
DO $cut$
DECLARE
    cut timestamptz := clock_timestamp();
BEGIN
    UPDATE "escrows" SET "legacyPreCommitmentAt" = cut WHERE "legacyPreCommitmentAt" IS NULL;
    UPDATE "escrows" SET "addressPresentAtCutAt" = cut WHERE "multisigAddr" IS NOT NULL AND "addressPresentAtCutAt" IS NULL;
END
$cut$;

-- 4. Triggers. Declared with the narrowest column list (and, for the lock, a WHEN): the cooperative release/refund/split, dispute,
--    C4 and reconciler UPDATEs (status to COMPLETED/REFUNDED/SPLIT/DISPUTED, txReleaseId, ...) touch none of these columns and
--    never run a function of this migration (proved with pg_stat_user_functions; a generic BEFORE UPDATE would fail that test).

-- DENY BY DEFAULT (CTO Despacho 029, decision B): EVERY escrow type needs a COMMITTED pair; the ONLY explicit exemption is MOCK. A type
-- added to the enum later is required by default. MULTISIG and WDK_USDT_EVM are NOT exempt. MOCK moves no real value; its protection in
-- production is NOT this trigger: the enabledRails configuration refuses MOCK outside dev/test (R-C) and the production runtime role is
-- not granted anything that would let it create a MOCK escrow (see scripts/db/runtime-grants.sql and the R-C test). Authorizing MOCK here
-- is not a deploy decision.
CREATE FUNCTION escrows_f4_pair_required("t" "EscrowType") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT "t" <> 'MOCK'
$$;

-- INSERT: the marks must be NULL (no new row is born legacy); a required type needs a COMMITTED pair whose anchor is the trade's.
CREATE FUNCTION escrows_f4_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pair_state text;
    pair_anchor text;
    trade_anchor text;
    trade_status text;
BEGIN
    IF NEW."legacyPreCommitmentAt" IS NOT NULL OR NEW."addressPresentAtCutAt" IS NOT NULL THEN
        RAISE EXCEPTION 'escrows: the legacy marks are written only by the cut migration (escrow id=%)', NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT escrows_f4_pair_required(NEW."type") THEN
        RETURN NEW;
    END IF;
    IF NEW."commitmentPairId" IS NULL THEN
        RAISE EXCEPTION 'escrows: a new % escrow needs a COMMITTED commitment pair (escrow id=%)', NEW."type", NEW."id"
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."state", p."anchorRef" INTO pair_state, pair_anchor FROM "commitment_pairs" p WHERE p."id" = NEW."commitmentPairId";
    IF pair_state IS DISTINCT FROM 'COMMITTED' THEN
        RAISE EXCEPTION 'escrows: the commitment pair % is not COMMITTED (state=%)', NEW."commitmentPairId", pair_state
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT t."tradeIntentId", t."status"::text INTO trade_anchor, trade_status FROM "trades" t WHERE t."id" = NEW."tradeId";
    IF trade_anchor IS DISTINCT FROM pair_anchor THEN
        RAISE EXCEPTION 'escrows: the commitment pair % is not the pair of trade % (anchor mismatch)', NEW."commitmentPairId", NEW."tradeId"
            USING ERRCODE = 'check_violation';
    END IF;
    -- A cancelled trade has already given its capacity back (v4 §5): a parallel escrow must not consume it again.
    IF trade_status = 'CANCELLED' THEN
        RAISE EXCEPTION 'escrows: trade % is CANCELLED; no new escrow may be created for it', NEW."tradeId"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER escrows_f4_guard_insert
    BEFORE INSERT ON "escrows"
    FOR EACH ROW EXECUTE FUNCTION escrows_f4_guard_insert();

-- UPDATE OF the bound columns: the pair id and both marks never change; the deposit address never changes once written, and it is
-- written only under a COMMITTED pair (a legacy mark does NOT authorize a new address: a legacy escrow without an address at the
-- cut can only be cancelled); no escrow gets a cleared or LATER expiry once set (NULL -> value at funding is the start of the clock).
CREATE FUNCTION escrows_f4_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pair_state text;
BEGIN
    IF NEW."type" IS DISTINCT FROM OLD."type" OR NEW."tradeId" IS DISTINCT FROM OLD."tradeId" THEN
        RAISE EXCEPTION 'escrows: type and tradeId are immutable (escrow id=%)', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."commitmentPairId" IS DISTINCT FROM OLD."commitmentPairId" THEN
        RAISE EXCEPTION 'escrows: commitmentPairId is immutable (escrow id=%)', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."legacyPreCommitmentAt" IS DISTINCT FROM OLD."legacyPreCommitmentAt"
       OR NEW."addressPresentAtCutAt" IS DISTINCT FROM OLD."addressPresentAtCutAt" THEN
        RAISE EXCEPTION 'escrows: the legacy marks are immutable and written only by the cut migration (escrow id=%)', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."multisigAddr" IS NOT NULL AND NEW."multisigAddr" IS DISTINCT FROM OLD."multisigAddr" THEN
        RAISE EXCEPTION 'escrows: the deposit address is immutable once written (escrow id=%)', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."multisigAddr" IS NULL AND NEW."multisigAddr" IS NOT NULL AND escrows_f4_pair_required(NEW."type") THEN
        IF NEW."commitmentPairId" IS NULL THEN
            RAISE EXCEPTION 'escrows: a deposit address is stored only under a COMMITTED commitment pair (escrow id=%)', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        SELECT p."state" INTO pair_state FROM "commitment_pairs" p WHERE p."id" = NEW."commitmentPairId";
        IF pair_state IS DISTINCT FROM 'COMMITTED' THEN
            RAISE EXCEPTION 'escrows: the commitment pair % is not COMMITTED (state=%)', NEW."commitmentPairId", pair_state
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    -- GK (C): NULL > x is NULL, so clearing the deadline must be refused explicitly (NEW IS NULL branch).
    -- Principal (3): applies to EVERY escrow, not only legacy; the sole writer of expiresAt (updateLockResult) goes NULL -> value once.
    IF OLD."expiresAt" IS NOT NULL
       AND (NEW."expiresAt" IS NULL OR NEW."expiresAt" > OLD."expiresAt") THEN
        RAISE EXCEPTION 'escrows: the expiry of an escrow cannot be cleared or extended once set (escrow id=%)', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER escrows_f4_guard_update
    BEFORE UPDATE OF "type", "tradeId", "commitmentPairId", "legacyPreCommitmentAt", "addressPresentAtCutAt", "multisigAddr", "expiresAt" ON "escrows"
    FOR EACH ROW EXECUTE FUNCTION escrows_f4_guard_update();

-- CREATED -> FUNDS_LOCKED (A4): a COMMITTED pair, or the narrow legacy exception (BOTH marks, written only by the cut migration:
-- the escrow already had its address before the cut). Any other status change never fires this trigger (WHEN).
CREATE FUNCTION escrows_f4_guard_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pair_state text;
BEGIN
    IF NOT escrows_f4_pair_required(NEW."type") THEN
        RETURN NEW;
    END IF;
    IF NEW."commitmentPairId" IS NOT NULL THEN
        SELECT p."state" INTO pair_state FROM "commitment_pairs" p WHERE p."id" = NEW."commitmentPairId";
        IF pair_state = 'COMMITTED' THEN
            RETURN NEW;
        END IF;
    END IF;
    IF NEW."legacyPreCommitmentAt" IS NOT NULL AND NEW."addressPresentAtCutAt" IS NOT NULL THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'escrows: funding is registered only under a COMMITTED commitment pair, or for a legacy escrow that had its address at the cut (escrow id=%)', OLD."id"
        USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER escrows_f4_guard_lock
    BEFORE UPDATE OF "status" ON "escrows"
    FOR EACH ROW
    WHEN (OLD."status" = 'CREATED' AND NEW."status" = 'FUNDS_LOCKED')
    EXECUTE FUNCTION escrows_f4_guard_lock();

-- 5. The runtime role's column-level privileges on "escrows" are applied by scripts/db/runtime-grants.sql (it runs as the
--    migrator after every deploy). The lock taken in step 1 is released by the COMMIT of the transaction wrapping this file.
