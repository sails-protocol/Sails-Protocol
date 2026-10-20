-- #235 R7H-E1 — economic authorization foundation (R7_TRADE_AUTHORIZATION_POLICY_V1).
--
-- Additive only. New tables: versioned trade-limit policy (with per-rail and per-payment-method rows), canonical
-- BTC/USD valuation quotes with their source observations, and immutable per-escrow exposure reservations. Nothing
-- existing is rewritten or backfilled: an escrow without a reservation is a legacy/unclassified escrow, never a
-- zero-exposure one. No production flow writes these tables yet (later R7H slices); the database enforces their
-- invariants on its own, so any future writer — including direct SQL — is held to them.

-- CreateEnum
CREATE TYPE "PolicyEvidenceClass" AS ENUM ('REGULATORY', 'PROVIDER_TERMS', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "PolicyConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "trade_limit_policy_versions" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openSettlementCapUsd" DECIMAL(24,2) NOT NULL,
    "rollingFiatCapUsd" DECIMAL(24,2) NOT NULL,
    "quoteMaxAgeSeconds" INTEGER NOT NULL,
    "quoteWindowSeconds" INTEGER NOT NULL,
    "quotePublicationMaxSeconds" INTEGER NOT NULL,
    "maxSourceDisagreementBps" INTEGER NOT NULL,
    "minAgreeingOperators" INTEGER NOT NULL,
    "sourceMaxAgeSeconds" INTEGER NOT NULL,
    "sourceFutureSkewSeconds" INTEGER NOT NULL,
    "dbTxId" BIGINT NOT NULL DEFAULT txid_current(),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_limit_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_limit_rail_policies" (
    "policyVersionId" TEXT NOT NULL,
    "escrowType" "EscrowType" NOT NULL,
    "asset" "AssetType" NOT NULL,

    CONSTRAINT "trade_limit_rail_policies_pkey" PRIMARY KEY ("policyVersionId","escrowType","asset")
);

-- CreateTable
CREATE TABLE "trade_limit_method_policies" (
    "policyVersionId" TEXT NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "fiatWindowDays" INTEGER,
    "evidenceClass" "PolicyEvidenceClass" NOT NULL,
    "confidence" "PolicyConfidence" NOT NULL,
    "note" TEXT,

    CONSTRAINT "trade_limit_method_policies_pkey" PRIMARY KEY ("policyVersionId","paymentMethod")
);

-- CreateTable
CREATE TABLE "valuation_quotes" (
    "id" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "baseAsset" "AssetType" NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "priceMaxUsd" DECIMAL(24,8) NOT NULL,
    "priceMedianUsd" DECIMAL(24,8) NOT NULL,
    "observationCount" INTEGER NOT NULL,
    "sourceSpreadBps" INTEGER NOT NULL,
    "dbTxId" BIGINT NOT NULL DEFAULT txid_current(),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "valuation_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_observations" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "priceUsd" DECIMAL(24,8) NOT NULL,
    "sourceTimestamp" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "payloadSha256" TEXT NOT NULL,

    CONSTRAINT "price_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exposure_reservations" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "paymentAccountId" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "escrowType" "EscrowType" NOT NULL,
    "asset" "AssetType" NOT NULL,
    "assetAmount" DECIMAL(24,8) NOT NULL,
    "exposureUsd" DECIMAL(24,2) NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exposure_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_limit_policy_versions_version_key" ON "trade_limit_policy_versions"("version");

-- CreateIndex
CREATE INDEX "valuation_quotes_baseAsset_windowStart_idx" ON "valuation_quotes"("baseAsset", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "price_observations_quoteId_operator_key" ON "price_observations"("quoteId", "operator");

-- CreateIndex
CREATE UNIQUE INDEX "exposure_reservations_tradeId_key" ON "exposure_reservations"("tradeId");

-- CreateIndex
CREATE UNIQUE INDEX "exposure_reservations_escrowId_key" ON "exposure_reservations"("escrowId");

-- CreateIndex
CREATE INDEX "exposure_reservations_sellerId_idx" ON "exposure_reservations"("sellerId");

-- CreateIndex
CREATE INDEX "exposure_reservations_paymentAccountId_idx" ON "exposure_reservations"("paymentAccountId");

-- AddForeignKey
ALTER TABLE "trade_limit_rail_policies" ADD CONSTRAINT "trade_limit_rail_policies_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "trade_limit_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_limit_method_policies" ADD CONSTRAINT "trade_limit_method_policies_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "trade_limit_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "valuation_quotes" ADD CONSTRAINT "valuation_quotes_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "trade_limit_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "valuation_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposure_reservations" ADD CONSTRAINT "exposure_reservations_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposure_reservations" ADD CONSTRAINT "exposure_reservations_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "escrows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposure_reservations" ADD CONSTRAINT "exposure_reservations_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposure_reservations" ADD CONSTRAINT "exposure_reservations_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposure_reservations" ADD CONSTRAINT "exposure_reservations_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "trade_limit_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposure_reservations" ADD CONSTRAINT "exposure_reservations_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "valuation_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- Value constraints ------------------------------------------------------------------------------------------

-- A version always carries finite, positive caps (no unlimited tier) and at least two agreeing operators (one
-- operator alone is a single point of price manipulation). A quote stays usable for at least its own window.
ALTER TABLE "trade_limit_policy_versions" ADD CONSTRAINT "trade_limit_policy_versions_values_check" CHECK (
  "version" >= 1 AND length(btrim("label")) > 0
  AND "openSettlementCapUsd" > 0 AND "rollingFiatCapUsd" > 0
  AND "quoteWindowSeconds" > 0 AND "quoteMaxAgeSeconds" >= "quoteWindowSeconds"
  AND "quotePublicationMaxSeconds" > 0 AND "quotePublicationMaxSeconds" <= "quoteMaxAgeSeconds"
  AND "maxSourceDisagreementBps" BETWEEN 0 AND 10000
  AND "minAgreeingOperators" >= 2
  AND "sourceMaxAgeSeconds" > 0 AND "sourceFutureSkewSeconds" >= 0
);

-- An eligible method has a positive fiat window and documented (not UNVERIFIED) evidence.
ALTER TABLE "trade_limit_method_policies" ADD CONSTRAINT "trade_limit_method_policies_values_check" CHECK (
  ("fiatWindowDays" IS NULL OR "fiatWindowDays" > 0)
  AND (NOT "eligible" OR ("fiatWindowDays" IS NOT NULL AND "evidenceClass" <> 'UNVERIFIED'))
);

ALTER TABLE "valuation_quotes" ADD CONSTRAINT "valuation_quotes_values_check" CHECK (
  "priceMaxUsd" > 0 AND "priceMedianUsd" > 0 AND "priceMedianUsd" <= "priceMaxUsd"
  AND "observationCount" >= 2 AND "sourceSpreadBps" BETWEEN 0 AND 10000
  AND "asOf" >= "windowStart" AND "collectedAt" >= "asOf"
);

-- Operators are canonical upper-case identifiers, so 'Kraken' and 'KRAKEN' cannot count as two operators.
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_values_check" CHECK (
  "priceUsd" > 0
  AND "operator" ~ '^[A-Z][A-Z0-9_]{1,31}$'
  AND "payloadSha256" ~ '^[0-9a-f]{64}$'
);

ALTER TABLE "exposure_reservations" ADD CONSTRAINT "exposure_reservations_values_check" CHECK (
  "assetAmount" > 0 AND "exposureUsd" > 0
);

-- --- Immutability -----------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION economic_authority_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: economic authorization rows are immutable (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trade_limit_policy_versions_immutability_guard BEFORE UPDATE OR DELETE ON "trade_limit_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER trade_limit_policy_versions_truncate_guard BEFORE TRUNCATE ON "trade_limit_policy_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER trade_limit_rail_policies_immutability_guard BEFORE UPDATE OR DELETE ON "trade_limit_rail_policies"
  FOR EACH ROW EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER trade_limit_rail_policies_truncate_guard BEFORE TRUNCATE ON "trade_limit_rail_policies"
  FOR EACH STATEMENT EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER trade_limit_method_policies_immutability_guard BEFORE UPDATE OR DELETE ON "trade_limit_method_policies"
  FOR EACH ROW EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER trade_limit_method_policies_truncate_guard BEFORE TRUNCATE ON "trade_limit_method_policies"
  FOR EACH STATEMENT EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER valuation_quotes_immutability_guard BEFORE UPDATE OR DELETE ON "valuation_quotes"
  FOR EACH ROW EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER valuation_quotes_truncate_guard BEFORE TRUNCATE ON "valuation_quotes"
  FOR EACH STATEMENT EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER price_observations_immutability_guard BEFORE UPDATE OR DELETE ON "price_observations"
  FOR EACH ROW EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER price_observations_truncate_guard BEFORE TRUNCATE ON "price_observations"
  FOR EACH STATEMENT EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER exposure_reservations_immutability_guard BEFORE UPDATE OR DELETE ON "exposure_reservations"
  FOR EACH ROW EXECUTE FUNCTION economic_authority_immutable();
CREATE TRIGGER exposure_reservations_truncate_guard BEFORE TRUNCATE ON "exposure_reservations"
  FOR EACH STATEMENT EXECUTE FUNCTION economic_authority_immutable();

-- --- Policy versions --------------------------------------------------------------------------------------------

-- The version in force at `at` (UTC): the latest activation not after it, ties broken by the higher version.
-- NULL when no version is active, which authorizes nothing.
CREATE OR REPLACE FUNCTION trade_limit_effective_policy_version(at timestamp) RETURNS text AS $$
  SELECT "id" FROM "trade_limit_policy_versions"
  WHERE "activatedAt" <= at
  ORDER BY "activatedAt" DESC, "version" DESC
  LIMIT 1
$$ LANGUAGE sql STABLE;

-- Versions are append-only and activate in version order, never retroactively.
CREATE OR REPLACE FUNCTION trade_limit_policy_versions_insert() RETURNS trigger AS $$
DECLARE
  tx_start timestamp := now() AT TIME ZONE 'UTC';
BEGIN
  NEW."dbTxId" := txid_current();
  NEW."createdAt" := tx_start;
  IF NEW."activatedAt" < date_trunc('second', tx_start) THEN
    RAISE EXCEPTION 'trade_limit_policy_versions: version % cannot activate in the past (activatedAt %, now %)', NEW."version", NEW."activatedAt", tx_start
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "trade_limit_policy_versions" WHERE "version" >= NEW."version" OR "activatedAt" > NEW."activatedAt") THEN
    RAISE EXCEPTION 'trade_limit_policy_versions: version % must be higher, and activate no earlier, than every existing version', NEW."version"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trade_limit_policy_versions_insert_guard BEFORE INSERT ON "trade_limit_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION trade_limit_policy_versions_insert();

-- A version's rail and method rows are written together with it, in its own transaction: once committed, a
-- version's content is closed (no method can be added to, or made eligible in, an existing version).
CREATE OR REPLACE FUNCTION trade_limit_policy_children_insert() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "trade_limit_policy_versions" WHERE "id" = NEW."policyVersionId" AND "dbTxId" = txid_current()) THEN
    RAISE EXCEPTION '%: policy version % is closed — its rows can only be written in the transaction that created it', TG_TABLE_NAME, NEW."policyVersionId"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trade_limit_rail_policies_insert_guard BEFORE INSERT ON "trade_limit_rail_policies"
  FOR EACH ROW EXECUTE FUNCTION trade_limit_policy_children_insert();
CREATE TRIGGER trade_limit_method_policies_insert_guard BEFORE INSERT ON "trade_limit_method_policies"
  FOR EACH ROW EXECUTE FUNCTION trade_limit_policy_children_insert();

-- --- Valuation quotes -------------------------------------------------------------------------------------------

-- A quote is published under the version in force, for a rail asset, under its deterministic id, for the aligned
-- window containing asOf, and within the publication bound of asOf (no backdated or future quotes). The bound is
-- checked again at commit (valuation_quote_assert_complete): a transaction held open cannot publish a late quote.
CREATE OR REPLACE FUNCTION valuation_quotes_insert() RETURNS trigger AS $$
DECLARE
  t timestamp := clock_timestamp() AT TIME ZONE 'UTC';
  p "trade_limit_policy_versions"%ROWTYPE;
  w interval;
BEGIN
  NEW."dbTxId" := txid_current();
  NEW."createdAt" := t;
  IF NEW."policyVersionId" IS DISTINCT FROM trade_limit_effective_policy_version(t) THEN
    RAISE EXCEPTION 'valuation_quotes: policy version % is not the version in force', NEW."policyVersionId"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO p FROM "trade_limit_policy_versions" WHERE "id" = NEW."policyVersionId";
  w := make_interval(secs => p."quoteWindowSeconds");
  IF NOT EXISTS (SELECT 1 FROM "trade_limit_rail_policies" WHERE "policyVersionId" = p."id" AND "asset" = NEW."baseAsset") THEN
    RAISE EXCEPTION 'valuation_quotes: % is not a rail asset of policy version %', NEW."baseAsset", p."version"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM NEW."baseAsset"::text || ':' || extract(epoch FROM NEW."windowStart")::bigint THEN
    RAISE EXCEPTION 'valuation_quotes: quote id % is not the deterministic id %', NEW."id", NEW."baseAsset"::text || ':' || extract(epoch FROM NEW."windowStart")::bigint
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF mod(extract(epoch FROM NEW."windowStart"), p."quoteWindowSeconds") <> 0 OR NEW."asOf" >= NEW."windowStart" + w THEN
    RAISE EXCEPTION 'valuation_quotes: windowStart % is not the %-second window containing asOf %', NEW."windowStart", p."quoteWindowSeconds", NEW."asOf"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."collectedAt" > t OR t - NEW."asOf" > make_interval(secs => p."quotePublicationMaxSeconds") THEN
    RAISE EXCEPTION 'valuation_quotes: a quote is published within % s of its asOf and never ahead of the clock (asOf %, collectedAt %, now %)', p."quotePublicationMaxSeconds", NEW."asOf", NEW."collectedAt", t
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER valuation_quotes_insert_guard BEFORE INSERT ON "valuation_quotes"
  FOR EACH ROW EXECUTE FUNCTION valuation_quotes_insert();

-- Observations are written only in the quote's own publishing transaction.
CREATE OR REPLACE FUNCTION price_observations_insert() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "valuation_quotes" WHERE "id" = NEW."quoteId" AND "dbTxId" = txid_current()) THEN
    RAISE EXCEPTION 'price_observations: quote % is closed — observations can only be written in the transaction that published it', NEW."quoteId"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER price_observations_insert_guard BEFORE INSERT ON "price_observations"
  FOR EACH ROW EXECUTE FUNCTION price_observations_insert();

-- Checked at commit (and re-checked for every observation added): the quote's summary is exactly what its
-- observations say. UNIQUE(windowStart) alone would let an incomplete or inconsistent quote become authoritative.
CREATE OR REPLACE FUNCTION valuation_quote_assert_complete(quote_id text) RETURNS void AS $$
DECLARE
  q "valuation_quotes"%ROWTYPE;
  p "trade_limit_policy_versions"%ROWTYPE;
  n int; n_ts int; hi numeric; lo numeric; med numeric; bad_ts int; bad_collected int;
BEGIN
  SELECT * INTO q FROM "valuation_quotes" WHERE "id" = quote_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO p FROM "trade_limit_policy_versions" WHERE "id" = q."policyVersionId";
  IF (clock_timestamp() AT TIME ZONE 'UTC') - q."asOf" > make_interval(secs => p."quotePublicationMaxSeconds") THEN
    RAISE EXCEPTION 'valuation_quotes: quote % commits more than % s after its asOf %', quote_id, p."quotePublicationMaxSeconds", q."asOf"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT count(*), count("sourceTimestamp"), max("priceUsd"), min("priceUsd"),
         count(*) FILTER (WHERE "sourceTimestamp" IS NOT NULL AND ("sourceTimestamp" < q."asOf" - make_interval(secs => p."sourceMaxAgeSeconds")
                                                              OR "sourceTimestamp" > q."asOf" + make_interval(secs => p."sourceFutureSkewSeconds"))),
         count(*) FILTER (WHERE "collectedAt" < q."asOf" OR "collectedAt" > q."collectedAt")
    INTO n, n_ts, hi, lo, bad_ts, bad_collected
    FROM "price_observations" WHERE "quoteId" = quote_id;
  SELECT avg(x."priceUsd") INTO med FROM (
    SELECT "priceUsd", row_number() OVER (ORDER BY "priceUsd") AS rn FROM "price_observations" WHERE "quoteId" = quote_id
  ) x WHERE x.rn IN ((n + 1) / 2, (n + 2) / 2);
  IF n <> q."observationCount" OR n < p."minAgreeingOperators" THEN
    RAISE EXCEPTION 'valuation_quotes: quote % declares % observations, has % (policy minimum %)', quote_id, q."observationCount", n, p."minAgreeingOperators"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF n_ts = 0 OR bad_ts > 0 OR bad_collected > 0 THEN
    RAISE EXCEPTION 'valuation_quotes: quote % has observations outside its time bounds (timestamped %, stale/future %, collected out of range %)', quote_id, n_ts, bad_ts, bad_collected
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF hi <> q."priceMaxUsd" OR round(med, 8) <> q."priceMedianUsd" THEN
    RAISE EXCEPTION 'valuation_quotes: quote % summary (max %, median %) differs from its observations (max %, median %)', quote_id, q."priceMaxUsd", q."priceMedianUsd", hi, med
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF q."sourceSpreadBps" <> ceil((hi - lo) * 10000 / med) OR (hi - lo) * 10000 > p."maxSourceDisagreementBps" * med THEN
    RAISE EXCEPTION 'valuation_quotes: quote % sources disagree by % bps (declared %, policy maximum %)', quote_id, ceil((hi - lo) * 10000 / med), q."sourceSpreadBps", p."maxSourceDisagreementBps"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION valuation_quotes_enforce_complete() RETURNS trigger AS $$
BEGIN
  PERFORM valuation_quote_assert_complete(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION price_observations_enforce_complete() RETURNS trigger AS $$
BEGIN
  PERFORM valuation_quote_assert_complete(NEW."quoteId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER valuation_quotes_completeness_guard
  AFTER INSERT ON "valuation_quotes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION valuation_quotes_enforce_complete();

CREATE CONSTRAINT TRIGGER price_observations_completeness_guard
  AFTER INSERT ON "price_observations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION price_observations_enforce_complete();

-- --- Exposure reservations --------------------------------------------------------------------------------------

-- A reservation is the snapshot of exactly what is being authorized: the trade's seller, the trade's bound
-- account and its method, the escrow's rail, asset and principal, valued at the newest fresh quote of the
-- version in force, rounded up to the cent. Written only for a new, unfunded escrow (never a backfill).
CREATE OR REPLACE FUNCTION exposure_reservations_insert() RETURNS trigger AS $$
DECLARE
  t timestamp := clock_timestamp() AT TIME ZONE 'UTC';
  p "trade_limit_policy_versions"%ROWTYPE;
  q "valuation_quotes"%ROWTYPE;
  tr "trades"%ROWTYPE;
  es "escrows"%ROWTYPE;
  pa "payment_accounts"%ROWTYPE;
  offer_method "PaymentMethod";
  latest_quote text;
BEGIN
  NEW."authorizedAt" := t;
  IF NEW."policyVersionId" IS DISTINCT FROM trade_limit_effective_policy_version(t) THEN
    RAISE EXCEPTION 'exposure_reservations: policy version % is not the version in force', NEW."policyVersionId"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT * INTO p FROM "trade_limit_policy_versions" WHERE "id" = NEW."policyVersionId";

  SELECT * INTO tr FROM "trades" WHERE "id" = NEW."tradeId" FOR SHARE;
  SELECT * INTO es FROM "escrows" WHERE "id" = NEW."escrowId" FOR SHARE;
  SELECT * INTO pa FROM "payment_accounts" WHERE "id" = NEW."paymentAccountId" FOR SHARE;
  SELECT "paymentMethod" INTO offer_method FROM "offers" WHERE "id" = tr."offerId";
  IF tr."id" IS NULL OR es."id" IS NULL OR pa."id" IS NULL
     OR tr."sellerId" IS DISTINCT FROM NEW."sellerId"
     OR tr."sellerPaymentAccountId" IS DISTINCT FROM NEW."paymentAccountId"
     OR pa."ownerId" IS DISTINCT FROM NEW."sellerId"
     OR pa."paymentMethod" IS DISTINCT FROM NEW."paymentMethod"
     OR offer_method IS DISTINCT FROM NEW."paymentMethod"
     OR es."tradeId" IS DISTINCT FROM NEW."tradeId"
     OR es."type" IS DISTINCT FROM NEW."escrowType"
     OR es."asset" IS DISTINCT FROM NEW."asset" OR tr."asset" IS DISTINCT FROM NEW."asset"
     OR es."lockedAmount" IS DISTINCT FROM NEW."assetAmount" OR tr."amount" IS DISTINCT FROM NEW."assetAmount" THEN
    RAISE EXCEPTION 'exposure_reservations: snapshot of trade % does not match its seller, bound payment account, method, escrow, asset and amount', NEW."tradeId"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF tr."status"::text NOT IN ('PENDING', 'ACTIVE') OR es."status"::text <> 'CREATED' OR es."txLockId" IS NOT NULL THEN
    RAISE EXCEPTION 'exposure_reservations: escrow % is not a new, unfunded escrow of an open trade (trade %, escrow %) — reservations are never backfilled', NEW."escrowId", tr."status", es."status"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "trade_limit_rail_policies" WHERE "policyVersionId" = p."id" AND "escrowType" = NEW."escrowType" AND "asset" = NEW."asset") THEN
    RAISE EXCEPTION 'exposure_reservations: rail %/% is not eligible under policy version %', NEW."escrowType", NEW."asset", p."version"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "trade_limit_method_policies" WHERE "policyVersionId" = p."id" AND "paymentMethod" = NEW."paymentMethod" AND "eligible") THEN
    RAISE EXCEPTION 'exposure_reservations: payment method % is not eligible under policy version %', NEW."paymentMethod", p."version"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT "id" INTO latest_quote FROM "valuation_quotes" WHERE "baseAsset" = NEW."asset" ORDER BY "windowStart" DESC LIMIT 1;
  SELECT * INTO q FROM "valuation_quotes" WHERE "id" = NEW."quoteId";
  IF q."id" IS NULL OR q."id" IS DISTINCT FROM latest_quote OR q."policyVersionId" IS DISTINCT FROM p."id"
     OR t - q."asOf" > make_interval(secs => p."quoteMaxAgeSeconds") THEN
    RAISE EXCEPTION 'exposure_reservations: quote % is not the newest fresh quote of policy version % (newest %)', NEW."quoteId", p."version", latest_quote
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."exposureUsd" <> ceil(NEW."assetAmount" * q."priceMaxUsd" * 100) / 100 THEN
    RAISE EXCEPTION 'exposure_reservations: exposureUsd % is not % x % rounded up to the cent (%)', NEW."exposureUsd", NEW."assetAmount", q."priceMaxUsd", ceil(NEW."assetAmount" * q."priceMaxUsd" * 100) / 100
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."exposureUsd" > p."openSettlementCapUsd" THEN
    RAISE EXCEPTION 'exposure_reservations: exposure % USD alone exceeds the open settlement cap % USD', NEW."exposureUsd", p."openSettlementCapUsd"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exposure_reservations_insert_guard BEFORE INSERT ON "exposure_reservations"
  FOR EACH ROW EXECUTE FUNCTION exposure_reservations_insert();

-- Once reserved, the snapshot's sources cannot drift from it. No current write path changes these columns, and
-- the guard only refuses when a reservation exists (zero effect on every existing row).
CREATE OR REPLACE FUNCTION exposure_reservation_sources_frozen() RETURNS trigger AS $$
DECLARE
  changed boolean;
  reserved boolean;
BEGIN
  IF TG_TABLE_NAME = 'trades' THEN
    changed := (NEW."sellerId", NEW."sellerPaymentAccountId", NEW."offerId", NEW."asset", NEW."amount")
      IS DISTINCT FROM (OLD."sellerId", OLD."sellerPaymentAccountId", OLD."offerId", OLD."asset", OLD."amount");
    reserved := EXISTS (SELECT 1 FROM "exposure_reservations" WHERE "tradeId" = OLD."id");
  ELSIF TG_TABLE_NAME = 'escrows' THEN
    changed := (NEW."tradeId", NEW."type", NEW."asset", NEW."lockedAmount")
      IS DISTINCT FROM (OLD."tradeId", OLD."type", OLD."asset", OLD."lockedAmount");
    reserved := EXISTS (SELECT 1 FROM "exposure_reservations" WHERE "escrowId" = OLD."id");
  ELSIF TG_TABLE_NAME = 'payment_accounts' THEN
    changed := (NEW."ownerId", NEW."paymentMethod") IS DISTINCT FROM (OLD."ownerId", OLD."paymentMethod");
    reserved := EXISTS (SELECT 1 FROM "exposure_reservations" WHERE "paymentAccountId" = OLD."id");
  ELSE
    changed := (NEW."paymentMethod") IS DISTINCT FROM (OLD."paymentMethod");
    reserved := EXISTS (SELECT 1 FROM "exposure_reservations" r JOIN "trades" t ON t."id" = r."tradeId" WHERE t."offerId" = OLD."id");
  END IF;
  IF changed AND reserved THEN
    RAISE EXCEPTION '%: row % backs an exposure reservation — the fields it snapshotted are immutable', TG_TABLE_NAME, OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trades_exposure_reservation_source_guard
  BEFORE UPDATE OF "sellerId", "sellerPaymentAccountId", "offerId", "asset", "amount" ON "trades"
  FOR EACH ROW EXECUTE FUNCTION exposure_reservation_sources_frozen();
CREATE TRIGGER escrows_exposure_reservation_source_guard
  BEFORE UPDATE OF "tradeId", "type", "asset", "lockedAmount" ON "escrows"
  FOR EACH ROW EXECUTE FUNCTION exposure_reservation_sources_frozen();
CREATE TRIGGER payment_accounts_exposure_reservation_source_guard
  BEFORE UPDATE OF "ownerId", "paymentMethod" ON "payment_accounts"
  FOR EACH ROW EXECUTE FUNCTION exposure_reservation_sources_frozen();
CREATE TRIGGER offers_exposure_reservation_source_guard
  BEFORE UPDATE OF "paymentMethod" ON "offers"
  FOR EACH ROW EXECUTE FUNCTION exposure_reservation_sources_frozen();

-- --- R7_TRADE_AUTHORIZATION_POLICY_V1 ---------------------------------------------------------------------------
-- Experimental. MULTISIG/BTC only; PIX only (receiver-side contest window per BCB MED rules, 90 days). Every other
-- payment method and rail has no row and is therefore not eligible. No promotion, no unlimited tier.
-- One statement (DO block) = one transaction: the rail and method rows must share the version's transaction.
DO $$
BEGIN
  INSERT INTO "trade_limit_policy_versions" (
    "id", "version", "label", "activatedAt", "openSettlementCapUsd", "rollingFiatCapUsd", "quoteMaxAgeSeconds",
    "quoteWindowSeconds", "quotePublicationMaxSeconds", "maxSourceDisagreementBps", "minAgreeingOperators", "sourceMaxAgeSeconds",
    "sourceFutureSkewSeconds"
  ) VALUES (
    'r7-trade-authorization-policy-v1', 1, 'R7_TRADE_AUTHORIZATION_POLICY_V1 (experimental)', now() AT TIME ZONE 'UTC',
    250.00, 750.00, 120, 30, 10, 100, 2, 60, 15
  );
  INSERT INTO "trade_limit_rail_policies" ("policyVersionId", "escrowType", "asset")
    VALUES ('r7-trade-authorization-policy-v1', 'MULTISIG', 'BTC');
  INSERT INTO "trade_limit_method_policies" ("policyVersionId", "paymentMethod", "eligible", "fiatWindowDays", "evidenceClass", "confidence", "note")
    VALUES ('r7-trade-authorization-policy-v1', 'PIX', true, 90, 'REGULATORY', 'MEDIUM',
            'BCB MED: receiver-side contest window; Day-0 allowlist pending explicit CTO/Product approval');
END;
$$;
