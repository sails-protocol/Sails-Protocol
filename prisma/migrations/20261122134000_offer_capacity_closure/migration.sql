-- M-1b closure (GK B6, B7, B8): three corrections that belong to the M-1b chain but must not edit the earlier migrations.
--
-- B6  escrows_f4_guard_insert() (created by the F4b migration 20261122122000, NOT edited there) is replaced so that it reads the trade
--     FOR SHARE: the CANCELLED check and the release path (trade FOR UPDATE) now serialize in every order (see the comment in the body).
-- B7  commitment_pairs_reserve_capacity() (created by 20261122130000) is replaced so that it also refuses while an OPEN row of
--     offer_capacity_blocks exists for the Offer (the block is an append-only table; see 20261122133000).
-- B8  EXECUTE is no longer PUBLIC for any M-1b function: the SECURITY DEFINER functions and the trigger functions are revoked from
--     PUBLIC; the reviewer role gets offer_capacity_execute_unblock; the runtime gets try_release and request_unblock in
--     scripts/db/runtime-grants.sql (the runtime role may not exist yet when migrations run).
--
-- Reversal (manual, not applied automatically): re-run the definitions of escrows_f4_guard_insert() from 20261122122000 and of
-- commitment_pairs_reserve_capacity() from 20261122130000 (CREATE OR REPLACE), and
--   GRANT EXECUTE ON FUNCTION offer_capacity_try_release(text), offer_capacity_settlement_proof(text), offer_capacity_request_unblock(text, jsonb, text), offer_capacity_block_on_evidence(), commitment_pairs_reserve_capacity() TO PUBLIC;
-- (no object is created by this migration, so it has no DROP statement)

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION escrows_f4_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pair_state text;
    pair_anchor text;
    trade_anchor text;
    trade_status text;
BEGIN
    -- A BEFORE ROW trigger runs before the NOT NULL check. With the schema default gone (D030) an INSERT without a type reaches here with a
    -- NULL type: refuse it with the same code the NOT NULL would give, so the outcome is stable with or without the default.
    IF NEW."type" IS NULL THEN
        RAISE EXCEPTION 'escrows: type is required (escrow id=%)', NEW."id" USING ERRCODE = 'not_null_violation';
    END IF;
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
    -- GK B6: the trade is read FOR SHARE. The escrow's foreign key to the trade takes only KEY SHARE, which a cancel (NO KEY UPDATE) does not
    -- conflict with, so a plain read could see ACTIVE while the cancel commits and the release (trade FOR UPDATE) finds no escrow. FOR SHARE
    -- conflicts with the cancel's UPDATE and with the release's FOR UPDATE: either the cancel commits first (this INSERT then sees CANCELLED
    -- and is refused) or this INSERT commits first (the release then sees the escrow and keeps the reservation).
    SELECT t."tradeIntentId", t."status"::text INTO trade_anchor, trade_status FROM "trades" t WHERE t."id" = NEW."tradeId" FOR SHARE;
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
  -- GK B7: a block is an append-only row (offer_capacity_blocks, no lock on the capacity row); OPEN blocks of this Offer refuse the reservation.
  IF cap."blockedAt" IS NOT NULL OR EXISTS (SELECT 1 FROM "offer_capacity_blocks" b WHERE b."ownerPublicKey" = env."ownerPublicKey" AND b."logicalOfferId" = env."logicalOfferId" AND b."clearedAt" IS NULL) THEN
    RAISE EXCEPTION 'E25_OFFER_CAPACITY_BLOCKED: the Offer capacity is blocked (pair=%)', NEW."id" USING ERRCODE = 'E2503';
  END IF;

  -- (3) Idempotent: the same pair is already reserved; another pair holding this trade's life is refused.
  SELECT r."commitmentPairId", r."amount", r."state" INTO have FROM "offer_capacity_reservations" r WHERE r."tradeIntentId" = NEW."anchorRef";
  IF FOUND THEN
    -- Idempotent ONLY for the very same reservation: same pair, same amount, still RESERVED (GK B4). Anything else (a smaller
    -- pre-inserted amount, a RELEASED row, another pair) is refused, so a reservation can never be pre-seeded to dodge the capacity.
    IF have."commitmentPairId" = NEW."id" AND have."amount" = amt AND have."state" = 'RESERVED' THEN RETURN NEW; END IF;
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
-- SECURITY DEFINER (owner = the migration role) with a fixed search_path: the runtime has NO INSERT on offer_capacity_reservations
-- (GK B4); only this function, run by the COMMITTED transition, creates a reservation.
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION offer_capacity_try_release(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION offer_capacity_settlement_proof(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION offer_capacity_request_unblock(text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION offer_capacity_execute_unblock(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION offer_capacity_block_on_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION offer_capacity_unblock_digest(text, text, text, text, timestamptz, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION commitment_pairs_reserve_capacity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION offer_capacity_execute_unblock(text, text, text) TO sails_capacity_reviewer;

RESET lock_timeout;
