-- M-1b slice 3 (CTO 28 Despachos 047/048, decision B1 = L1 + L2 + L3, FAIL-CLOSED economic validation): the ONLY path that
-- releases a reservation. "offer_capacity_try_release(tradeIntentId)" takes NO proof, no kind and no amount from the caller: it
-- re-derives everything from persisted facts, under locks, and either releases the WHOLE reservation or returns 'KEEP:<reason>'.
-- Unproven means kept: a missing fact is never read as "released".
--
--   L1  the trade is CANCELLED (committed state, read under the trade row lock) and NO escrow exists for it. The row lock on the
--       trade conflicts with the FOREIGN KEY check of a concurrent escrow INSERT (FOR KEY SHARE), so an in-flight escrow admission
--       either commits first (the escrow then exists: KEEP) or waits until this transaction ends, and its INSERT is refused for a
--       CANCELLED trade by the F4 trigger (a parallel escrow cannot consume released capacity).
--   L2  the escrow is REFUNDED and was NEVER FUNDED, proven strictly: no deposit address was ever assigned, no lock tx, no funding
--       or release evidence of any kind, no pending transaction, no WDK attempt, no fee-collection evidence. Absence of evidence
--       rows is NOT accepted as absence of funding on its own (the legacy "no rows = not uncertain" reading of the funding service is
--       NOT reused): an escrow that ever had an address keeps the reservation until an L3 proof exists.
--   L3  the escrow is COMPLETED / REFUNDED / SPLIT after funding AND the settlement leg is proven FINAL: the most recent release
--       evidence is a confirming kind observed at a depth >= the escrow's own fee-policy requiredConfirmations, no later
--       REORGED_INVALIDATED / REPLACEMENT_OBSERVED / AMBIGUOUS, the funding evidence is not uncertain, no pending transaction, no
--       open dispute, and no unfinished fee-collection reorg evidence. MULTISIG only: for the other rail types the database has no
--       on-chain finality evidence, so their reservation stays (declared limit, not an assumption).
--   NEVER: DISPUTED, EXPIRED, CREATED/FUNDS_LOCKED/PAYMENT_PENDING, uncertain funding, pending obligation, nominal status alone,
--          partial release.
--
-- Lock order: offer_capacity -> trade -> escrow -> disputes (FOR SHARE). Never called with an escrow lock already held by the caller.
-- The function is SECURITY DEFINER (owner = migration role, fixed search_path); it is callable by the runtime (it takes only a trade id and releases only what it proves), which has NO
-- UPDATE on the reservation table. A release writes releaseKind and a releaseProof naming the facts it relied on.
--
-- Reversal (manual, not applied automatically):
--   DROP FUNCTION offer_capacity_try_release(text);
--   DROP FUNCTION offer_capacity_settlement_proof(text);
--   (and restore the previous offer_capacity_reservations_guard() from 20261122130000_offer_capacity)

SET lock_timeout = '5s';

-- A release must carry one of the three kinds and a proof; the guard stays immutable for everything else.
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
  IF NEW."state" = 'RELEASED' AND (NEW."releaseKind" NOT IN ('L1_TRADE_CANCELLED_NO_ESCROW', 'L2_NEVER_FUNDED_REFUND', 'L3_FINALIZED_SETTLEMENT')
      OR NEW."releaseProof" IS NULL OR length(NEW."releaseProof") < 10) THEN
    RAISE EXCEPTION 'offer_capacity_reservations: a release needs one of the three release kinds and its proof (id=%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The shared L3 proof: the escrow of a trade is in a TERMINAL state AND its settlement leg is FINAL, derived only from persisted facts.
-- Returns 'FINAL:<json proof>' or 'KEEP:<reason>'. Used by the release path and by the reorg-unblock reviewer (same standard, one place).
CREATE OR REPLACE FUNCTION offer_capacity_settlement_proof(p_escrow_id text)
RETURNS text AS $$
DECLARE
  e record;
  need int;
  rel record;
  rel_n int;
  fund record;
  fund_n int;
BEGIN
  SELECT es."id", es."status"::text AS status, es."type"::text AS type, es."feePolicyVersionId" INTO e FROM "escrows" es WHERE es."id" = p_escrow_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'KEEP:escrow_not_found'; END IF;
    PERFORM 1 FROM "disputes" d WHERE d."escrowId" = e."id" AND d."status" <> 'RESOLVED' FOR SHARE;
    IF FOUND THEN RETURN 'KEEP:open_dispute'; END IF;
    IF e."status" NOT IN ('COMPLETED', 'REFUNDED', 'SPLIT') THEN RETURN 'KEEP:escrow_not_terminal_' || e."status"; END IF;
    IF EXISTS (SELECT 1 FROM "escrow_pending_transactions" p WHERE p."escrowId" = e."id") THEN RETURN 'KEEP:pending_transaction'; END IF;
    IF e."type" <> 'MULTISIG' THEN RETURN 'KEEP:rail_without_onchain_finality_evidence'; END IF;

    SELECT count(*) INTO fund_n FROM "escrow_funding_evidence" f WHERE f."escrowId" = e."id";
    SELECT count(*) INTO rel_n FROM "escrow_release_evidence" x WHERE x."escrowId" = e."id";
      IF fund_n = 0 THEN RETURN 'KEEP:no_funding_evidence_to_prove_final_settlement'; END IF;
      SELECT f."kind"::text AS kind INTO fund FROM "escrow_funding_evidence" f WHERE f."escrowId" = e."id" ORDER BY f."recordedAt" DESC, f."id" DESC LIMIT 1;
      IF fund."kind" NOT IN ('OBSERVED_CONFIRMED', 'RECONFIRMED') THEN RETURN 'KEEP:funding_uncertain'; END IF;
      IF (SELECT count(*) FROM "escrow_funding_evidence" f WHERE f."escrowId" = e."id" AND f."recordedAt" = (SELECT max(f2."recordedAt") FROM "escrow_funding_evidence" f2 WHERE f2."escrowId" = e."id")) > 1 THEN
        RETURN 'KEEP:funding_evidence_tie';
      END IF;
      SELECT fp."requiredConfirmations" INTO need FROM "fee_policy_versions" fp WHERE fp."id" = e."feePolicyVersionId";
      IF need IS NULL OR need < 1 THEN RETURN 'KEEP:no_confirmation_policy'; END IF;
      IF rel_n = 0 THEN RETURN 'KEEP:no_release_evidence'; END IF;
      IF (SELECT count(*) FROM "escrow_release_evidence" x WHERE x."escrowId" = e."id" AND x."recordedAt" = (SELECT max(x2."recordedAt") FROM "escrow_release_evidence" x2 WHERE x2."escrowId" = e."id")) > 1 THEN
        RETURN 'KEEP:release_evidence_tie';
      END IF;
      SELECT x."id", x."kind"::text AS kind, x."observedAtHeight", x."tipHeightAtObservation" INTO rel
        FROM "escrow_release_evidence" x WHERE x."escrowId" = e."id" ORDER BY x."recordedAt" DESC, x."id" DESC LIMIT 1;
      IF rel."kind" NOT IN ('OBSERVED_CONFIRMED', 'RECONFIRMED') THEN RETURN 'KEEP:release_not_confirmed_or_reorged'; END IF;
      IF rel."observedAtHeight" IS NULL OR rel."tipHeightAtObservation" IS NULL OR rel."tipHeightAtObservation" < rel."observedAtHeight"
         OR (rel."tipHeightAtObservation" - rel."observedAtHeight" + 1) < need THEN RETURN 'KEEP:release_not_deep_enough'; END IF;
      -- the fee-collection leg of the same escrow must not be in an unreconciled reorg/replacement
      IF EXISTS (
        SELECT 1 FROM "fee_collection_evidence" fe JOIN "fee_obligations" fo ON fo."id" = fe."feeObligationId"
         WHERE fo."escrowId" = e."id" AND fe."kind"::text IN ('REORGED_OUT', 'REPLACED', 'DROPPED', 'ALTERNATE_SPEND')
           AND fe."seq" = (SELECT max(f3."seq") FROM "fee_collection_evidence" f3 WHERE f3."feeObligationId" = fo."id")) THEN
        RETURN 'KEEP:fee_collection_leg_unreconciled';
      END IF;
  RETURN 'FINAL:' || format('{"rule":"L3","escrowId":"%s","status":"%s","releaseEvidenceId":"%s","observedAtHeight":%s,"tipHeightAtObservation":%s,"required":%s}',
        e."id", e."status", rel."id", rel."observedAtHeight", rel."tipHeightAtObservation", need);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION offer_capacity_try_release(p_trade_intent_id text)
RETURNS text AS $$
DECLARE
  r record;
  cur_state text;
  t record;
  e record;
  need int;
  rel record;
  rel_n int;
  fund record;
  fund_n int;
  kind text;
  proof text;
  v text;
BEGIN
  SELECT x."id", x."ownerPublicKey", x."logicalOfferId", x."state" INTO r FROM "offer_capacity_reservations" x WHERE x."tradeIntentId" = p_trade_intent_id;
  IF NOT FOUND THEN RETURN 'NOOP:no_reservation'; END IF;
  IF r."state" = 'RELEASED' THEN RETURN 'NOOP:already_released'; END IF;

  -- 1) capacity row, then re-read the reservation under the lock (a concurrent release/reserve is serialized here)
  PERFORM 1 FROM "offer_capacity" c WHERE c."ownerPublicKey" = r."ownerPublicKey" AND c."logicalOfferId" = r."logicalOfferId" FOR UPDATE;
  SELECT x."state" INTO cur_state FROM "offer_capacity_reservations" x WHERE x."id" = r."id" FOR UPDATE;
  IF cur_state = 'RELEASED' THEN RETURN 'NOOP:already_released'; END IF;

  -- 2) the trade, FOR UPDATE: its committed status is read under a lock that conflicts with a concurrent escrow INSERT's FK check
  SELECT tr."id", tr."status"::text AS status INTO t FROM "trades" tr WHERE tr."tradeIntentId" = p_trade_intent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'KEEP:trade_not_found'; END IF;

  -- 3) the escrow of the trade (if any), locked; its disputes FOR SHARE
  SELECT es."id", es."status"::text AS status, es."type"::text AS type, es."multisigAddr", es."txLockId", es."txReleaseId", es."feePolicyVersionId"
    INTO e FROM "escrows" es WHERE es."tradeId" = t."id" FOR UPDATE;

  IF NOT FOUND THEN
    IF t."status" = 'CANCELLED' THEN
      kind := 'L1_TRADE_CANCELLED_NO_ESCROW';
      proof := format('{"rule":"L1","tradeId":"%s","tradeStatus":"CANCELLED","escrow":null}', t."id");
    ELSE RETURN 'KEEP:no_escrow_but_trade_not_cancelled'; END IF;
  ELSE
    IF e."type" = 'MULTISIG' AND e."status" = 'REFUNDED' AND e."multisigAddr" IS NULL AND e."txLockId" IS NULL AND e."txReleaseId" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "disputes" d WHERE d."escrowId" = e."id")
       AND NOT EXISTS (SELECT 1 FROM "escrow_pending_transactions" p WHERE p."escrowId" = e."id")
       AND NOT EXISTS (SELECT 1 FROM "escrow_funding_evidence" f WHERE f."escrowId" = e."id")
       AND NOT EXISTS (SELECT 1 FROM "escrow_release_evidence" x WHERE x."escrowId" = e."id")
       AND NOT EXISTS (SELECT 1 FROM "wdk_transfer_attempts" w WHERE w."escrowId" = e."id")
       AND NOT EXISTS (SELECT 1 FROM "fee_collection_evidence" fe JOIN "fee_obligations" fo ON fo."id" = fe."feeObligationId" WHERE fo."escrowId" = e."id") THEN
      kind := 'L2_NEVER_FUNDED_REFUND';
      proof := format('{"rule":"L2","escrowId":"%s","status":"REFUNDED","addressAssigned":false,"fundingEvidence":0,"releaseEvidence":0}', e."id");
    ELSE
      v := offer_capacity_settlement_proof(e."id");
      IF v LIKE 'KEEP:%' THEN RETURN v; END IF;
      kind := 'L3_FINALIZED_SETTLEMENT';
      proof := substr(v, 7);
    END IF;
  END IF;

  UPDATE "offer_capacity_reservations" SET "state" = 'RELEASED', "releasedAt" = clock_timestamp(), "releaseKind" = kind, "releaseProof" = proof
   WHERE "id" = r."id" AND "state" = 'RESERVED';
  RETURN 'RELEASED:' || kind;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

RESET lock_timeout;
