-- M-1b (CTO 28 Despachos 026-029, F4 design v4.3): aggregate capacity per LOGICAL Offer and its atomic reservation.
--
-- ONE capacity row per (ownerPublicKey, logicalOfferId) for ALL revisions of that Offer, so two revisions can never hold two
-- balances. NULL capacityTotal = not configured = no executable reservation (fail-closed, never "unlimited", never 0).
-- The capacity is raised or lowered ONLY by a declaration signed by the owner's economic key (service, slice 2); the database
-- keeps the signed declaration for offline re-verification but cannot check Ed25519 itself (declared residual): it enforces the
-- shape, a strictly increasing capacityRevision, and that a signature accompanies every configured capacity.
--
-- This migration is ISOLATED: it creates the tables, the guards and the reservation function
-- "commitment_pairs_reserve_capacity()", but does NOT attach it to commitment_pairs. Attaching it (the COMMITTED transition)
-- is a separate step, taken together with the corpus fixtures that declare a capacity.
--
-- Reversal (manual, not applied automatically):
--   DROP TABLE "offer_capacity_reservations"; DROP TABLE "offer_capacity";
--   DROP FUNCTION commitment_pairs_reserve_capacity(); DROP FUNCTION offer_capacity_guard(); DROP FUNCTION offer_capacity_refuse_removal();
--   DROP FUNCTION offer_capacity_reservations_guard();

SET lock_timeout = '5s';

CREATE TABLE "offer_capacity" (
    "ownerPublicKey" TEXT NOT NULL,
    "logicalOfferId" TEXT NOT NULL,
    "capacityTotal" NUMERIC(24,8),
    "capacityRevision" INTEGER NOT NULL,
    "declaredAt" TIMESTAMPTZ(3),
    "declaration" JSONB,
    "declarationSignature" TEXT,
    "blockedAt" TIMESTAMPTZ(3),
    "blockReason" TEXT,
    "blockEvidence" TEXT,
    "unblockProof" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "offer_capacity_pkey" PRIMARY KEY ("ownerPublicKey", "logicalOfferId"),
    CONSTRAINT "offer_capacity_owner_check" CHECK ("ownerPublicKey" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "offer_capacity_revision_check" CHECK ("capacityRevision" >= 0), -- 0 = row created to take the lock, never declared (capacityTotal NULL)
    CONSTRAINT "offer_capacity_total_check" CHECK ("capacityTotal" IS NULL OR "capacityTotal" > 0),
    -- a configured capacity always carries its signed declaration (audit re-verifies it)
    CONSTRAINT "offer_capacity_declared_check" CHECK (
        "capacityTotal" IS NULL OR ("declarationSignature" ~ '^[0-9a-f]{128}$' AND "declaration" IS NOT NULL AND "declaredAt" IS NOT NULL)
    ),
    CONSTRAINT "offer_capacity_block_check" CHECK (("blockedAt" IS NULL) = ("blockReason" IS NULL))
);

CREATE TABLE "offer_capacity_reservations" (
    "id" TEXT NOT NULL,
    "ownerPublicKey" TEXT NOT NULL,
    "logicalOfferId" TEXT NOT NULL,
    "tradeIntentId" TEXT NOT NULL,
    "commitmentPairId" TEXT NOT NULL,
    "amount" NUMERIC(24,8) NOT NULL,
    "capacityRevisionObserved" INTEGER NOT NULL,
    "capacityTotalAtReservation" NUMERIC(24,8) NOT NULL,
    "offerRevision" INTEGER NOT NULL,
    "offerEnvelopeDigest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "releasedAt" TIMESTAMPTZ(3),
    "releaseKind" TEXT,
    "releaseProof" TEXT,

    CONSTRAINT "offer_capacity_reservations_pkey" PRIMARY KEY ("id"),
    -- one life per trade, one reservation per pair: a re-sent COMMITTED can never reserve twice
    CONSTRAINT "offer_capacity_reservations_trade_key" UNIQUE ("tradeIntentId"),
    CONSTRAINT "offer_capacity_reservations_pair_key" UNIQUE ("commitmentPairId"),
    CONSTRAINT "offer_capacity_reservations_capacity_fkey" FOREIGN KEY ("ownerPublicKey", "logicalOfferId")
        REFERENCES "offer_capacity"("ownerPublicKey", "logicalOfferId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "offer_capacity_reservations_pair_fkey" FOREIGN KEY ("commitmentPairId")
        REFERENCES "commitment_pairs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "offer_capacity_reservations_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "offer_capacity_reservations_state_check" CHECK ("state" IN ('RESERVED', 'RELEASED')),
    CONSTRAINT "offer_capacity_reservations_released_check" CHECK (
        ("state" = 'RESERVED' AND "releasedAt" IS NULL AND "releaseKind" IS NULL AND "releaseProof" IS NULL)
        OR ("state" = 'RELEASED' AND "releasedAt" IS NOT NULL AND "releaseKind" IS NOT NULL AND "releaseProof" IS NOT NULL)
    )
);
-- the aggregate the reservation sums while it holds the capacity row lock
CREATE INDEX "offer_capacity_reservations_open_idx" ON "offer_capacity_reservations"("ownerPublicKey", "logicalOfferId") WHERE "state" = 'RESERVED';

CREATE OR REPLACE FUNCTION offer_capacity_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- born unconfigured or with its first declaration; never born blocked (a block is a later, evidenced fact)
    IF NEW."blockedAt" IS NOT NULL OR NEW."unblockProof" IS NOT NULL THEN
      RAISE EXCEPTION 'offer_capacity: a row is not born blocked (owner=%, offer=%)', NEW."ownerPublicKey", NEW."logicalOfferId" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."ownerPublicKey" IS DISTINCT FROM OLD."ownerPublicKey" OR NEW."logicalOfferId" IS DISTINCT FROM OLD."logicalOfferId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'offer_capacity: the identity is immutable (owner=%, offer=%)', OLD."ownerPublicKey", OLD."logicalOfferId" USING ERRCODE = 'check_violation';
  END IF;
  -- Anti-replay: the declaration (and everything derived from it) changes ONLY together with a strictly higher revision.
  IF NEW."capacityRevision" < OLD."capacityRevision" OR NEW."capacityRevision" = OLD."capacityRevision" AND (
       NEW."capacityTotal" IS DISTINCT FROM OLD."capacityTotal" OR NEW."declaredAt" IS DISTINCT FROM OLD."declaredAt"
       OR NEW."declaration" IS DISTINCT FROM OLD."declaration" OR NEW."declarationSignature" IS DISTINCT FROM OLD."declarationSignature") THEN
    RAISE EXCEPTION 'offer_capacity: a declaration needs a strictly higher capacityRevision (have %, got %)', OLD."capacityRevision", NEW."capacityRevision" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."capacityRevision" > OLD."capacityRevision" AND NEW."declaration" IS NOT DISTINCT FROM OLD."declaration" THEN
    RAISE EXCEPTION 'offer_capacity: a new capacityRevision carries a new declaration' USING ERRCODE = 'check_violation';
  END IF;
  -- A block is set once and cleared only with a proof (the two-role procedure writes it); it is never cleared by omission.
  IF OLD."blockedAt" IS NOT NULL AND NEW."blockedAt" IS NULL AND (NEW."unblockProof" IS NULL OR NEW."unblockProof" IS NOT DISTINCT FROM OLD."unblockProof") THEN
    RAISE EXCEPTION 'offer_capacity: a block is removed only with a new unblockProof' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."blockedAt" IS NOT NULL AND NEW."blockedAt" IS NOT NULL
     AND (NEW."blockedAt" IS DISTINCT FROM OLD."blockedAt" OR NEW."blockReason" IS DISTINCT FROM OLD."blockReason" OR NEW."blockEvidence" IS DISTINCT FROM OLD."blockEvidence") THEN
    RAISE EXCEPTION 'offer_capacity: an existing block is not rewritten' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."blockedAt" IS NULL AND NEW."unblockProof" IS DISTINCT FROM OLD."unblockProof" THEN
    RAISE EXCEPTION 'offer_capacity: unblockProof is written only while removing a block' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offer_capacity_guard_insert BEFORE INSERT ON "offer_capacity" FOR EACH ROW EXECUTE FUNCTION offer_capacity_guard();
CREATE TRIGGER offer_capacity_guard_update BEFORE UPDATE ON "offer_capacity" FOR EACH ROW EXECUTE FUNCTION offer_capacity_guard();

CREATE OR REPLACE FUNCTION offer_capacity_refuse_removal()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'offer_capacity: rows are never deleted (%)', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offer_capacity_no_delete BEFORE DELETE ON "offer_capacity" FOR EACH ROW EXECUTE FUNCTION offer_capacity_refuse_removal();
CREATE TRIGGER offer_capacity_no_truncate BEFORE TRUNCATE ON "offer_capacity" FOR EACH STATEMENT EXECUTE FUNCTION offer_capacity_refuse_removal();
CREATE TRIGGER offer_capacity_reservations_no_delete BEFORE DELETE ON "offer_capacity_reservations" FOR EACH ROW EXECUTE FUNCTION offer_capacity_refuse_removal();
CREATE TRIGGER offer_capacity_reservations_no_truncate BEFORE TRUNCATE ON "offer_capacity_reservations" FOR EACH STATEMENT EXECUTE FUNCTION offer_capacity_refuse_removal();

-- A reservation's facts never change; the only transition is RESERVED -> RELEASED (the release path, slice 3, adds its proof rules).
CREATE OR REPLACE FUNCTION offer_capacity_reservations_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."ownerPublicKey" IS DISTINCT FROM OLD."ownerPublicKey" OR NEW."logicalOfferId" IS DISTINCT FROM OLD."logicalOfferId"
     OR NEW."tradeIntentId" IS DISTINCT FROM OLD."tradeIntentId" OR NEW."commitmentPairId" IS DISTINCT FROM OLD."commitmentPairId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."capacityRevisionObserved" IS DISTINCT FROM OLD."capacityRevisionObserved"
     OR NEW."capacityTotalAtReservation" IS DISTINCT FROM OLD."capacityTotalAtReservation" OR NEW."offerRevision" IS DISTINCT FROM OLD."offerRevision"
     OR NEW."offerEnvelopeDigest" IS DISTINCT FROM OLD."offerEnvelopeDigest" OR NEW."reservedAt" IS DISTINCT FROM OLD."reservedAt" THEN
    RAISE EXCEPTION 'offer_capacity_reservations: a reservation is immutable (id=%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" = 'RELEASED' THEN
    RAISE EXCEPTION 'offer_capacity_reservations: RELEASED is terminal (id=%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offer_capacity_reservations_guard BEFORE UPDATE ON "offer_capacity_reservations" FOR EACH ROW EXECUTE FUNCTION offer_capacity_reservations_guard();

-- Atomic reservation, run by the COMMITTED transition of a pair (BEFORE UPDATE OF state ... WHEN OLD <> COMMITTED AND NEW = COMMITTED; not
-- attached here). Everything is read from the PAIR and from the trade it anchors, never from a caller parameter. The capacity row is
-- resolved AND locked by ONE statement (FOR UPDATE), so the total and the reserved sum are read after the lock.
-- SQLSTATEs (the service maps them, never a raw check_violation): E2501 offer not resolved, E2502 capacity not configured,
-- E2503 blocked, E2504 exceeded, E2505 anchor already reserved by another pair.
CREATE OR REPLACE FUNCTION commitment_pairs_reserve_capacity()
RETURNS TRIGGER AS $$
DECLARE
  accepted text;
  env record;
  cap record;
  amt numeric := (NEW."trade"->>'amount')::numeric;
  taken numeric;
  have record;
BEGIN
  -- (1) The Offer actually accepted: the envelope the trade fixed at admission (R1) must be the one the pair names.
  SELECT t."acceptedEnvelopeId" INTO accepted FROM "trades" t WHERE t."tradeIntentId" = NEW."anchorRef";
  SELECT e."ownerPublicKey", e."logicalOfferId", e."revision", e."contentDigest" INTO env FROM "offer_envelopes" e WHERE e."id" = accepted;
  -- IS NOT TRUE: an unknown (NULL) value, a trade without acceptedEnvelopeId (legacy) or a missing envelope is a refusal, never a pass.
  IF accepted IS NULL OR env."ownerPublicKey" IS NULL OR (
       env."ownerPublicKey" = NEW."trade"->>'makerPublicKey'
   AND env."logicalOfferId" = NEW."trade"->>'offerLogicalId'
   AND env."revision" = (NEW."trade"->>'offerRevision')::int
   AND env."contentDigest" = NEW."trade"->>'offerEnvelopeDigest') IS NOT TRUE THEN
    RAISE EXCEPTION 'E25_OFFER_NOT_RESOLVED: the pair does not name the envelope its trade accepted (pair=%)', NEW."id" USING ERRCODE = 'E2501';
  END IF;

  -- (2) Resolve and lock in ONE statement: the values below are read after the row lock.
  SELECT c."capacityTotal", c."capacityRevision", c."blockedAt" INTO cap
    FROM "offer_capacity" c WHERE c."ownerPublicKey" = env."ownerPublicKey" AND c."logicalOfferId" = env."logicalOfferId" FOR UPDATE;
  IF NOT FOUND OR cap."capacityTotal" IS NULL THEN
    RAISE EXCEPTION 'E25_OFFER_CAPACITY_NOT_CONFIGURED: no declared capacity for the accepted Offer (pair=%)', NEW."id" USING ERRCODE = 'E2502';
  END IF;
  IF cap."blockedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'E25_OFFER_CAPACITY_BLOCKED: the Offer capacity is blocked (pair=%)', NEW."id" USING ERRCODE = 'E2503';
  END IF;

  -- (3) Idempotent: the same pair is already reserved; another pair holding this trade's life is refused.
  SELECT r."commitmentPairId" INTO have FROM "offer_capacity_reservations" r WHERE r."tradeIntentId" = NEW."anchorRef";
  IF FOUND THEN
    IF have."commitmentPairId" = NEW."id" THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'E25_OFFER_CAPACITY_ANCHOR_RESERVED: the trade already holds a reservation for another pair (pair=%)', NEW."id" USING ERRCODE = 'E2505';
  END IF;

  SELECT COALESCE(SUM(r."amount"), 0) INTO taken FROM "offer_capacity_reservations" r
    WHERE r."ownerPublicKey" = env."ownerPublicKey" AND r."logicalOfferId" = env."logicalOfferId" AND r."state" = 'RESERVED';
  IF taken + amt > cap."capacityTotal" THEN
    RAISE EXCEPTION 'E25_OFFER_CAPACITY_EXCEEDED: reserved % + % exceeds the declared %', taken, amt, cap."capacityTotal" USING ERRCODE = 'E2504';
  END IF;

  INSERT INTO "offer_capacity_reservations" ("id", "ownerPublicKey", "logicalOfferId", "tradeIntentId", "commitmentPairId", "amount",
      "capacityRevisionObserved", "capacityTotalAtReservation", "offerRevision", "offerEnvelopeDigest")
    VALUES (gen_random_uuid()::text, env."ownerPublicKey", env."logicalOfferId", NEW."anchorRef", NEW."id", amt,
      cap."capacityRevision", cap."capacityTotal", env."revision", env."contentDigest");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

RESET lock_timeout;
