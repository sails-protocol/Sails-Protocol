-- #235 R7H-E3 — seller, PaymentAccount and payment-method binding of every new escrow on a governed rail.
--
-- A rail (escrow type + asset) is GOVERNED once any trade-limit policy version has ever listed it (V1: MULTISIG/BTC).
-- Governance is monotonic: a later version that omits the rail makes it ineligible, never ungoverned, so dropping a
-- rail from the policy can only refuse escrows, not release them from these checks. An escrow on a governed rail is
-- created only when, under the policy version in force at that moment:
--   - the rail is eligible;
--   - the trade's seller is the party economically committed by its offer (SELL: the offer's owner; BUY: the
--     counterparty);
--   - the trade is bound to a seller PaymentAccount (trades."sellerPaymentAccountId", already write-once) that the
--     seller owns, whose method is the offer's method, and that method is eligible.
-- Ungoverned rails (MOCK, LIGHTNING_HODL, WDK_USDT_EVM, SAFE_GUARD_EVM) are production-ineligible and refused at
-- creation in production by the application (escrow.service.ts); they are untouched here.
--
-- Once committed, the terms the binding rests on cannot drift: a PaymentAccount's owner, hash and method never
-- change; an offer's owner, side, asset, method and account are fixed once a trade references it; a trade's
-- parties, offer, asset and amount are fixed once it has an escrow. No application path writes any of these
-- columns, so the guards have no effect on existing behaviour.
--
-- Who may ask for an escrow (the seller only) is an application-boundary rule (escrow.service.ts createEscrow): the
-- database has no caller identity. Nothing existing is rewritten.

-- The rail has been listed by some policy version.
CREATE OR REPLACE FUNCTION escrow_rail_governed(escrow_type "EscrowType", escrow_asset "AssetType") RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "trade_limit_rail_policies" WHERE "escrowType" = escrow_type AND "asset" = escrow_asset)
$$ LANGUAGE sql STABLE;

-- NULL when an escrow of this rail may be created for the trade now; otherwise '<CODE>: <reason>'. Locks the trade,
-- its offer and the bound account FOR SHARE, so none of them can change before the calling transaction ends.
CREATE OR REPLACE FUNCTION escrow_economic_binding_violation(trade_id text, escrow_type "EscrowType", escrow_asset "AssetType") RETURNS text AS $$
DECLARE
  p text := trade_limit_effective_policy_version(clock_timestamp() AT TIME ZONE 'UTC');
  tr "trades"%ROWTYPE;
  o "offers"%ROWTYPE;
  pa "payment_accounts"%ROWTYPE;
BEGIN
  IF NOT escrow_rail_governed(escrow_type, escrow_asset) THEN
    RETURN NULL;
  END IF;
  IF p IS NULL OR NOT EXISTS (SELECT 1 FROM "trade_limit_rail_policies" WHERE "policyVersionId" = p AND "escrowType" = escrow_type AND "asset" = escrow_asset) THEN
    RETURN format('RAIL_NOT_ELIGIBLE: rail %s/%s is not eligible under the policy version in force', escrow_type, escrow_asset);
  END IF;
  SELECT * INTO tr FROM "trades" WHERE "id" = trade_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN format('TRADE_MISSING: trade %s does not exist', trade_id);
  END IF;
  SELECT * INTO o FROM "offers" WHERE "id" = tr."offerId" FOR SHARE;
  IF NOT ((o."side"::text = 'SELL' AND tr."sellerId" = o."userId") OR (o."side"::text = 'BUY' AND tr."buyerId" = o."userId")) THEN
    RETURN format('SELLER_NOT_COMMITTED: trade %s seller %s is not the seller committed by offer %s', tr."id", tr."sellerId", o."id");
  END IF;
  IF tr."sellerPaymentAccountId" IS NULL THEN
    RETURN format('UNBOUND_ACCOUNT: trade %s is not bound to a seller payment account', tr."id");
  END IF;
  SELECT * INTO pa FROM "payment_accounts" WHERE "id" = tr."sellerPaymentAccountId" FOR SHARE;
  IF pa."ownerId" IS DISTINCT FROM tr."sellerId" THEN
    RETURN format('FOREIGN_ACCOUNT: payment account %s is not owned by seller %s', pa."id", tr."sellerId");
  END IF;
  IF pa."paymentMethod" IS DISTINCT FROM o."paymentMethod" THEN
    RETURN format('METHOD_MISMATCH: payment account %s is %s but offer %s is paid by %s', pa."id", pa."paymentMethod", o."id", o."paymentMethod");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "trade_limit_method_policies" WHERE "policyVersionId" = p AND "paymentMethod" = o."paymentMethod" AND "eligible") THEN
    RETURN format('METHOD_NOT_ELIGIBLE: payment method %s is not eligible under the policy version in force', o."paymentMethod");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Every new escrow, and any change of an escrow's trade or rail, is checked: a direct write cannot create, or move
-- an escrow onto, a governed rail without the binding. (Named to fire after the existing F8 escrow guards.)
CREATE OR REPLACE FUNCTION escrows_enforce_trade_economic_binding() RETURNS trigger AS $$
DECLARE
  violation text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."tradeId", NEW."type", NEW."asset") IS NOT DISTINCT FROM (OLD."tradeId", OLD."type", OLD."asset") THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND escrow_rail_governed(OLD."type", OLD."asset") THEN
    RAISE EXCEPTION 'escrows: economic binding refused — escrow % on governed rail %/% cannot change its trade or rail', OLD."id", OLD."type", OLD."asset"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  violation := escrow_economic_binding_violation(NEW."tradeId", NEW."type", NEW."asset");
  IF violation IS NOT NULL THEN
    RAISE EXCEPTION 'escrows: economic binding refused — %', violation
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrows_trade_economic_binding_guard
  BEFORE INSERT OR UPDATE OF "tradeId", "type", "asset" ON "escrows"
  FOR EACH ROW EXECUTE FUNCTION escrows_enforce_trade_economic_binding();

-- Committed terms cannot drift.
CREATE OR REPLACE FUNCTION economic_binding_terms_immutable() RETURNS trigger AS $$
DECLARE
  changed boolean;
  committed boolean;
BEGIN
  IF TG_TABLE_NAME = 'payment_accounts' THEN
    changed := (NEW."ownerId", NEW."accountHash", NEW."paymentMethod") IS DISTINCT FROM (OLD."ownerId", OLD."accountHash", OLD."paymentMethod");
    committed := true;
  ELSIF TG_TABLE_NAME = 'offers' THEN
    changed := (NEW."userId", NEW."side", NEW."asset", NEW."paymentMethod", NEW."paymentAccountId") IS DISTINCT FROM (OLD."userId", OLD."side", OLD."asset", OLD."paymentMethod", OLD."paymentAccountId");
    committed := EXISTS (SELECT 1 FROM "trades" WHERE "offerId" = OLD."id");
  ELSE
    changed := (NEW."sellerId", NEW."buyerId", NEW."offerId", NEW."asset", NEW."amount") IS DISTINCT FROM (OLD."sellerId", OLD."buyerId", OLD."offerId", OLD."asset", OLD."amount");
    committed := EXISTS (SELECT 1 FROM "escrows" WHERE "tradeId" = OLD."id");
  END IF;
  IF changed AND committed THEN
    RAISE EXCEPTION '%: row % carries committed economic terms (seller, account, method, asset, amount) that cannot change', TG_TABLE_NAME, OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_accounts_committed_terms_guard
  BEFORE UPDATE OF "ownerId", "accountHash", "paymentMethod" ON "payment_accounts"
  FOR EACH ROW EXECUTE FUNCTION economic_binding_terms_immutable();
CREATE TRIGGER offers_committed_terms_guard
  BEFORE UPDATE OF "userId", "side", "asset", "paymentMethod", "paymentAccountId" ON "offers"
  FOR EACH ROW EXECUTE FUNCTION economic_binding_terms_immutable();
CREATE TRIGGER trades_committed_terms_guard
  BEFORE UPDATE OF "sellerId", "buyerId", "offerId", "asset", "amount" ON "trades"
  FOR EACH ROW EXECUTE FUNCTION economic_binding_terms_immutable();
