-- E25/E26 F3 (CTO 28 Despacho 021, P63) - persistence of the bilateral TradeCommitmentV1 + ArbitrationCommitmentV1 pair.
-- One row per pair (design PRINCIPAL-P43-F3-desenho-v2.md, GK VERIFY): every invariant is a CHECK of the row itself,
-- the pair is signed in ONE UPDATE per party, and the canonical objects never change. Additive: no existing table or
-- row is touched. anchorRef is an OPAQUE uuid here: the FK to trades("tradeIntentId") waits for #651 (CTO).
--
-- Reversal (not applied automatically; drop the guards first, they also block TRUNCATE):
--   DROP TRIGGER commitment_pairs_no_truncate ON "commitment_pairs";
--   DROP TRIGGER commitment_pairs_no_delete ON "commitment_pairs";
--   DROP TRIGGER commitment_pairs_guard_update ON "commitment_pairs";
--   DROP TRIGGER commitment_pairs_guard_insert ON "commitment_pairs";
--   DROP FUNCTION commitment_pairs_guard(); DROP FUNCTION commitment_pairs_refuse_removal();
--   DROP TABLE "commitment_pairs";

CREATE TABLE "commitment_pairs" (
    "id" TEXT NOT NULL,
    "anchorRef" TEXT NOT NULL,
    "committedAnchorRef" TEXT,
    "commitmentDigest" TEXT NOT NULL,
    "arbitrationCommitmentDigest" TEXT NOT NULL,
    "trade" JSONB NOT NULL,
    "arbitration" JSONB NOT NULL,
    "policy" JSONB NOT NULL,
    "feePolicyVersionId" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "makerTradeSig" TEXT,
    "makerArbitrationSig" TEXT,
    "makerReceivedAt" TIMESTAMPTZ(3),
    "takerTradeSig" TEXT,
    "takerArbitrationSig" TEXT,
    "takerReceivedAt" TIMESTAMPTZ(3),
    "withdrawnBy" TEXT,
    "withdrawProof" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "commitment_pairs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commitment_pairs_state_check" CHECK ("state" IN ('PROPOSED', 'PARTIALLY_SIGNED', 'COMMITTED', 'WITHDRAWN', 'EXPIRED')),
    CONSTRAINT "commitment_pairs_capability_check" CHECK ("capability" IN ('FIXED_ARBITER_COMMITMENT', 'DYNAMIC_REASSIGNABLE', 'UNAVAILABLE', 'UNKNOWN')),
    CONSTRAINT "commitment_pairs_hex_check" CHECK (
        "commitmentDigest" ~ '^[0-9a-f]{64}$'
        AND "arbitrationCommitmentDigest" ~ '^[0-9a-f]{64}$'
        AND "anchorRef" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND ("makerTradeSig" IS NULL OR "makerTradeSig" ~ '^[0-9a-f]{128}$')
        AND ("makerArbitrationSig" IS NULL OR "makerArbitrationSig" ~ '^[0-9a-f]{128}$')
        AND ("takerTradeSig" IS NULL OR "takerTradeSig" ~ '^[0-9a-f]{128}$')
        AND ("takerArbitrationSig" IS NULL OR "takerArbitrationSig" ~ '^[0-9a-f]{128}$')
    ),
    -- BL-1: one party's two signatures and its single server stamp are all set together or not at all.
    CONSTRAINT "commitment_pairs_maker_triple_check" CHECK (
        ("makerTradeSig" IS NULL) = ("makerArbitrationSig" IS NULL) AND ("makerTradeSig" IS NULL) = ("makerReceivedAt" IS NULL)
    ),
    CONSTRAINT "commitment_pairs_taker_triple_check" CHECK (
        ("takerTradeSig" IS NULL) = ("takerArbitrationSig" IS NULL) AND ("takerTradeSig" IS NULL) = ("takerReceivedAt" IS NULL)
    ),
    -- K1: COMMITTED needs all four signatures and a capability the protocol may execute; UNKNOWN/UNAVAILABLE never get there.
    CONSTRAINT "commitment_pairs_k1_committed_check" CHECK (
        "state" <> 'COMMITTED'
        OR ("makerReceivedAt" IS NOT NULL AND "takerReceivedAt" IS NOT NULL AND "capability" IN ('FIXED_ARBITER_COMMITMENT', 'DYNAMIC_REASSIGNABLE'))
    ),
    -- K2 (R7): PARTIALLY_SIGNED is exactly one party; a non-executable pair only ever sits in PROPOSED (or a terminal state).
    CONSTRAINT "commitment_pairs_k2_signed_check" CHECK (
        ("state" <> 'PARTIALLY_SIGNED' OR (("makerReceivedAt" IS NULL) <> ("takerReceivedAt" IS NULL)))
        AND ("state" <> 'PROPOSED' OR ("makerReceivedAt" IS NULL AND "takerReceivedAt" IS NULL) OR "capability" IN ('UNKNOWN', 'UNAVAILABLE'))
        AND ("capability" NOT IN ('UNKNOWN', 'UNAVAILABLE') OR "state" IN ('PROPOSED', 'WITHDRAWN', 'EXPIRED'))
    ),
    -- K3: the reason is exactly the one of the capability (P22/P32), and only for those two.
    CONSTRAINT "commitment_pairs_k3_reason_check" CHECK (
        "reason" IS NOT DISTINCT FROM (CASE "capability" WHEN 'UNKNOWN' THEN 'E26_CAPABILITY_UNPROVEN' WHEN 'UNAVAILABLE' THEN 'E26_ARBITRATION_UNAVAILABLE' END)
    ),
    -- K4 (+R1): the copies and the 8 binding fields never diverge from the canonical objects.
    CONSTRAINT "commitment_pairs_k4_binding_check" CHECK (
        "rail" = ("trade"->>'rail')
        AND "anchorRef" = ("trade"->>'anchorRef')
        AND "feePolicyVersionId" = ("trade"->>'feePolicyVersionId')
        AND "capability" = ("arbitration"->>'arbitrationCapability')
        AND "commitmentDigest" = ("arbitration"->>'commitmentDigest')
        AND ("arbitration"->>'commitmentDomainTag') = 'sails-trade-commitment-v1'
        AND ("arbitration"->>'anchorRef') = ("trade"->>'anchorRef')
        AND ("arbitration"->>'makerPublicKey') = ("trade"->>'makerPublicKey')
        AND ("arbitration"->>'takerPublicKey') = ("trade"->>'takerPublicKey')
        AND ("arbitration"->>'rail') = ("trade"->>'rail')
        AND ("arbitration"->>'proposedAt') = ("trade"->>'proposedAt')
        AND ("arbitration"->>'expiresAt') = ("trade"->>'expiresAt')
    ),
    -- INV-5 / C2 without a partial index: the column is the anchor exactly while COMMITTED, NULL otherwise; UNIQUE below.
    CONSTRAINT "commitment_pairs_committed_anchor_check" CHECK (
        "committedAnchorRef" IS NOT DISTINCT FROM (CASE WHEN "state" = 'COMMITTED' THEN "anchorRef" END)
    ),
    -- B8: a withdrawal records who withdrew and its proof, both once, and only in WITHDRAWN.
    CONSTRAINT "commitment_pairs_withdraw_check" CHECK (
        ("withdrawnBy" IS NULL) = ("withdrawProof" IS NULL)
        AND ("withdrawnBy" IS NULL OR "withdrawnBy" IN ('maker', 'taker'))
        AND (("state" = 'WITHDRAWN') = ("withdrawnBy" IS NOT NULL))
        AND ("withdrawProof" IS NULL OR "withdrawProof" ~ '^[0-9a-f]{128}$')
    )
);

CREATE UNIQUE INDEX "commitment_pairs_commitmentDigest_key" ON "commitment_pairs"("commitmentDigest");
CREATE UNIQUE INDEX "commitment_pairs_arbitrationCommitmentDigest_key" ON "commitment_pairs"("arbitrationCommitmentDigest");
CREATE UNIQUE INDEX "commitment_pairs_committedAnchorRef_key" ON "commitment_pairs"("committedAnchorRef");
CREATE INDEX "commitment_pairs_anchorRef_idx" ON "commitment_pairs"("anchorRef");

ALTER TABLE "commitment_pairs" ADD CONSTRAINT "commitment_pairs_feePolicyVersionId_fkey" FOREIGN KEY ("feePolicyVersionId") REFERENCES "fee_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- B5 + B1/(A) + R2: the state machine, immutability and the server-stamp window, enforced by the database itself.
CREATE OR REPLACE FUNCTION commitment_pairs_guard()
RETURNS TRIGGER AS $$
DECLARE
  expires timestamptz := (NEW."trade"->>'expiresAt')::timestamptz;
  win_start timestamptz := date_trunc('milliseconds', transaction_timestamp());
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- T1: the taker signs first; a pair is born PROPOSED or PARTIALLY_SIGNED, never with the maker or a withdrawal.
    IF NEW."makerTradeSig" IS NOT NULL OR NEW."withdrawnBy" IS NOT NULL OR NEW."state" NOT IN ('PROPOSED', 'PARTIALLY_SIGNED') THEN
      RAISE EXCEPTION 'commitment_pairs: a pair is proposed by the taker only (state=%)', NEW."state" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."takerReceivedAt" IS NOT NULL AND NOT (NEW."takerReceivedAt" >= win_start AND NEW."takerReceivedAt" <= clock_timestamp() AND NEW."takerReceivedAt" < expires) THEN
      RAISE EXCEPTION 'commitment_pairs: takerReceivedAt must be this transaction''s database clock and before expiresAt' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."state" IN ('COMMITTED', 'WITHDRAWN', 'EXPIRED') THEN
    RAISE EXCEPTION 'commitment_pairs: % is terminal (id=%)', OLD."state", OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."anchorRef" IS DISTINCT FROM OLD."anchorRef"
     OR NEW."commitmentDigest" IS DISTINCT FROM OLD."commitmentDigest" OR NEW."arbitrationCommitmentDigest" IS DISTINCT FROM OLD."arbitrationCommitmentDigest"
     OR NEW."trade" IS DISTINCT FROM OLD."trade" OR NEW."arbitration" IS DISTINCT FROM OLD."arbitration" OR NEW."policy" IS DISTINCT FROM OLD."policy"
     OR NEW."feePolicyVersionId" IS DISTINCT FROM OLD."feePolicyVersionId" OR NEW."rail" IS DISTINCT FROM OLD."rail"
     OR NEW."capability" IS DISTINCT FROM OLD."capability" OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'commitment_pairs: the canonical pair is immutable (id=%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  -- A signature, a stamp or a withdrawal is written once: NULL -> value, never changed, never cleared.
  IF (OLD."makerTradeSig" IS NOT NULL AND NEW."makerTradeSig" IS DISTINCT FROM OLD."makerTradeSig")
     OR (OLD."makerArbitrationSig" IS NOT NULL AND NEW."makerArbitrationSig" IS DISTINCT FROM OLD."makerArbitrationSig")
     OR (OLD."makerReceivedAt" IS NOT NULL AND NEW."makerReceivedAt" IS DISTINCT FROM OLD."makerReceivedAt")
     OR (OLD."takerTradeSig" IS NOT NULL AND NEW."takerTradeSig" IS DISTINCT FROM OLD."takerTradeSig")
     OR (OLD."takerArbitrationSig" IS NOT NULL AND NEW."takerArbitrationSig" IS DISTINCT FROM OLD."takerArbitrationSig")
     OR (OLD."takerReceivedAt" IS NOT NULL AND NEW."takerReceivedAt" IS DISTINCT FROM OLD."takerReceivedAt")
     OR (OLD."withdrawnBy" IS NOT NULL AND NEW."withdrawnBy" IS DISTINCT FROM OLD."withdrawnBy")
     OR (OLD."withdrawProof" IS NOT NULL AND NEW."withdrawProof" IS DISTINCT FROM OLD."withdrawProof") THEN
    RAISE EXCEPTION 'commitment_pairs: signatures, stamps and withdrawals are write-once (id=%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  -- (A) A new stamp is an instant of THIS transaction's database clock (read once after the row lock), before expiry.
  IF NEW."makerReceivedAt" IS DISTINCT FROM OLD."makerReceivedAt"
     AND NOT (NEW."makerReceivedAt" >= win_start AND NEW."makerReceivedAt" <= clock_timestamp() AND NEW."makerReceivedAt" < expires) THEN
    RAISE EXCEPTION 'commitment_pairs: makerReceivedAt must be this transaction''s database clock and before expiresAt' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."takerReceivedAt" IS DISTINCT FROM OLD."takerReceivedAt"
     AND NOT (NEW."takerReceivedAt" >= win_start AND NEW."takerReceivedAt" <= clock_timestamp() AND NEW."takerReceivedAt" < expires) THEN
    RAISE EXCEPTION 'commitment_pairs: takerReceivedAt must be this transaction''s database clock and before expiresAt' USING ERRCODE = 'check_violation';
  END IF;
  -- Transitions: PROPOSED -> PROPOSED | PARTIALLY_SIGNED | COMMITTED | WITHDRAWN | EXPIRED; PARTIALLY_SIGNED -> COMMITTED | WITHDRAWN | EXPIRED.
  IF NOT (
       (OLD."state" = 'PROPOSED' AND NEW."state" IN ('PROPOSED', 'PARTIALLY_SIGNED', 'COMMITTED', 'WITHDRAWN', 'EXPIRED'))
    OR (OLD."state" = 'PARTIALLY_SIGNED' AND NEW."state" IN ('COMMITTED', 'WITHDRAWN', 'EXPIRED'))) THEN
    RAISE EXCEPTION 'commitment_pairs: transition % -> % is not allowed (id=%)', OLD."state", NEW."state", OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" = 'EXPIRED' AND clock_timestamp() < expires THEN
    RAISE EXCEPTION 'commitment_pairs: EXPIRED only once expiresAt has passed on the database clock (id=%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commitment_pairs_guard_insert BEFORE INSERT ON "commitment_pairs" FOR EACH ROW EXECUTE FUNCTION commitment_pairs_guard();
CREATE TRIGGER commitment_pairs_guard_update BEFORE UPDATE ON "commitment_pairs" FOR EACH ROW EXECUTE FUNCTION commitment_pairs_guard();

CREATE OR REPLACE FUNCTION commitment_pairs_refuse_removal()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'commitment_pairs: pairs are never removed (%)', TG_OP USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commitment_pairs_no_delete BEFORE DELETE ON "commitment_pairs" FOR EACH ROW EXECUTE FUNCTION commitment_pairs_refuse_removal();
CREATE TRIGGER commitment_pairs_no_truncate BEFORE TRUNCATE ON "commitment_pairs" FOR EACH STATEMENT EXECUTE FUNCTION commitment_pairs_refuse_removal();
