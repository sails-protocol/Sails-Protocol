-- M-1b slice 4 (CTO 28 Despachos 029/047/048; GK B7): the durable reorg BLOCK of an Offer capacity and its two-role, evidence-bound UNBLOCK.
--
-- BLOCK is an APPEND-ONLY TABLE ("offer_capacity_blocks"), NOT an UPDATE of the capacity row (GK B7): the evidence writers (funding
-- evidence, release evidence, the reorg sweeps) may hold an escrow lock, and the release path takes capacity -> trade -> escrow, so a block
-- that locked the capacity row inside an evidence INSERT would invert the order (escrow -> capacity) and deadlock. The block table has
-- NO foreign key to offer_capacity (a FK would take KEY SHARE on the capacity row, the same lock) and the trigger never locks it. The
-- reservation function (replaced in the closure migration 20261122134000) reads the OPEN blocks under its own capacity lock.
-- When release/funding evidence of an escrow whose reservation was ALREADY released (L2/L3) is later invalidated, replaced or becomes
-- ambiguous (REORGED_INVALIDATED / REPLACEMENT_OBSERVED / AMBIGUOUS), an AFTER INSERT trigger on both evidence tables inserts a block row
-- IN THE SAME TRANSACTION as the evidence. The released reservation is never undone and no capacity is invented: the block stops NEW
-- COMMITTED reservations (E2503) until a reviewed unblock clears THAT block (one open block per escrow).
--
-- UNBLOCK (A1 + A3, two independent functions, no generic administrative path):
--   A  offer_capacity_request_unblock(blockId, evidence, requesterKey): an operator records an append-only REQUEST naming the block, the
--      evidence (must name the blocking escrow) and a canonical digest computed BY THE DATABASE (sha256 over the domain
--      "sails-offer-capacity-unblock-v1", the request id, the block id and instant, the identity, the evidence and the requester key).
--      It clears nothing.
--   B  offer_capacity_execute_unblock(requestId, reviewerKey, reviewerSignature): callable ONLY by the reviewer role. It rejects a reviewer
--      who is the requester (same session user, either being a member of the other's role, a session role that does not exist, or the same
--      Ed25519 key), re-verifies the digest, locks the request and the block, requires the block to be still open, re-runs the L3
--      settlement proof (confirmation depth of the policy, no REORGED_INVALIDATED/REPLACEMENT/AMBIGUOUS, funding certain, no pending
--      transaction, no open dispute) on the blocking escrow and refuses ANY unreconciled evidence in the Offer's scope. The request is
--      consumed once (a second execution is a NOOP); the block is cleared with the request that cleared it.
--   The database cannot verify Ed25519 (declared residual): it stores the reviewer's signature over the decision digest for re-verification
--   by scripts/audit-offer-capacity.ts. No timeout, no unilateral path, no signature accepted as proof of finality.
--
-- Reversal (manual, not applied automatically):
--   DROP TRIGGER offer_capacity_block_release_evidence ON "escrow_release_evidence";
--   DROP TRIGGER offer_capacity_block_funding_evidence ON "escrow_funding_evidence";
--   DROP FUNCTION offer_capacity_block_on_evidence();
--   DROP FUNCTION offer_capacity_execute_unblock(text, text, text);
--   DROP FUNCTION offer_capacity_request_unblock(text, jsonb, text);
--   DROP FUNCTION offer_capacity_unblock_digest(text, text, text, text, timestamptz, jsonb, text);
--   DROP TABLE "offer_capacity_unblock_requests";
--   DROP TABLE "offer_capacity_blocks";
--   (the role sails_capacity_reviewer is cluster-level and is left in place)

SET lock_timeout = '5s';

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sails_capacity_reviewer') THEN
    BEGIN
      CREATE ROLE sails_capacity_reviewer NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'the role sails_capacity_reviewer must be created by the cluster administrator before this migration (NOLOGIN; a separate login role holds the reviewer credential)';
    END;
  END IF;
END
$roles$;

CREATE TABLE "offer_capacity_blocks" (
    "id" TEXT NOT NULL,
    "ownerPublicKey" TEXT NOT NULL,
    "logicalOfferId" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "blockedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "clearedAt" TIMESTAMPTZ(3),
    "clearedByRequestId" TEXT,

    CONSTRAINT "offer_capacity_blocks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offer_capacity_blocks_cleared_check" CHECK (("clearedAt" IS NULL) = ("clearedByRequestId" IS NULL))
);
-- one OPEN block per escrow; the reservation reads the open blocks of the Offer
CREATE UNIQUE INDEX "offer_capacity_blocks_open_escrow_key" ON "offer_capacity_blocks"("ownerPublicKey", "logicalOfferId", "escrowId") WHERE "clearedAt" IS NULL;
CREATE INDEX "offer_capacity_blocks_open_idx" ON "offer_capacity_blocks"("ownerPublicKey", "logicalOfferId") WHERE "clearedAt" IS NULL;

CREATE TABLE "offer_capacity_unblock_requests" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "ownerPublicKey" TEXT NOT NULL,
    "logicalOfferId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "requesterKey" TEXT NOT NULL,
    "requestedBySession" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "digest" TEXT NOT NULL,
    "reviewerKey" TEXT,
    "reviewerSession" TEXT,
    "reviewerSignature" TEXT,
    "executedAt" TIMESTAMPTZ(3),

    CONSTRAINT "offer_capacity_unblock_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offer_capacity_unblock_requests_block_fkey" FOREIGN KEY ("blockId") REFERENCES "offer_capacity_blocks"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "offer_capacity_unblock_requests_keys_check" CHECK ("requesterKey" ~ '^[0-9a-f]{64}$' AND ("reviewerKey" IS NULL OR "reviewerKey" ~ '^[0-9a-f]{64}$')),
    CONSTRAINT "offer_capacity_unblock_requests_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "offer_capacity_unblock_requests_executed_check" CHECK (
        ("executedAt" IS NULL AND "reviewerKey" IS NULL AND "reviewerSession" IS NULL AND "reviewerSignature" IS NULL)
        OR ("executedAt" IS NOT NULL AND "reviewerKey" IS NOT NULL AND "reviewerSession" IS NOT NULL AND "reviewerSignature" ~ '^[0-9a-f]{128}$')
    )
);

-- Append-only trails: a block changes once (cleared), a request changes once (consumed); nothing is deleted or truncated.
CREATE OR REPLACE FUNCTION offer_capacity_blocks_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'offer_capacity_blocks: the trail is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."clearedAt" IS NOT NULL OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."ownerPublicKey" IS DISTINCT FROM OLD."ownerPublicKey"
     OR NEW."logicalOfferId" IS DISTINCT FROM OLD."logicalOfferId" OR NEW."escrowId" IS DISTINCT FROM OLD."escrowId"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."blockedAt" IS DISTINCT FROM OLD."blockedAt" THEN
    RAISE EXCEPTION 'offer_capacity_blocks: a block is immutable and cleared once (id=%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER offer_capacity_blocks_guard BEFORE UPDATE OR DELETE ON "offer_capacity_blocks" FOR EACH ROW EXECUTE FUNCTION offer_capacity_blocks_guard();
CREATE TRIGGER offer_capacity_blocks_no_truncate BEFORE TRUNCATE ON "offer_capacity_blocks" FOR EACH STATEMENT EXECUTE FUNCTION offer_capacity_blocks_guard();

CREATE OR REPLACE FUNCTION offer_capacity_unblock_requests_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'offer_capacity_unblock_requests: the trail is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."executedAt" IS NOT NULL OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."blockId" IS DISTINCT FROM OLD."blockId"
     OR NEW."ownerPublicKey" IS DISTINCT FROM OLD."ownerPublicKey" OR NEW."logicalOfferId" IS DISTINCT FROM OLD."logicalOfferId"
     OR NEW."evidence" IS DISTINCT FROM OLD."evidence" OR NEW."requesterKey" IS DISTINCT FROM OLD."requesterKey"
     OR NEW."requestedBySession" IS DISTINCT FROM OLD."requestedBySession" OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."digest" IS DISTINCT FROM OLD."digest" THEN
    RAISE EXCEPTION 'offer_capacity_unblock_requests: a request is immutable and consumed once (id=%)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER offer_capacity_unblock_requests_guard BEFORE UPDATE OR DELETE ON "offer_capacity_unblock_requests" FOR EACH ROW EXECUTE FUNCTION offer_capacity_unblock_requests_guard();
CREATE TRIGGER offer_capacity_unblock_requests_no_truncate BEFORE TRUNCATE ON "offer_capacity_unblock_requests" FOR EACH STATEMENT EXECUTE FUNCTION offer_capacity_unblock_requests_guard();

-- Canonical digest (computed by the database, never accepted from a caller).
CREATE OR REPLACE FUNCTION offer_capacity_unblock_digest(p_id text, p_block_id text, p_owner text, p_logical text, p_blocked_at timestamptz, p_evidence jsonb, p_requester_key text)
RETURNS text AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\x1f', 'sails-offer-capacity-unblock-v1', p_id, p_block_id, p_owner, p_logical,
    to_char(p_blocked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), p_evidence::text, p_requester_key), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- BLOCK trigger: an INSERT into the append-only block table, in the evidence's own transaction. It locks NOTHING on the capacity row.
CREATE OR REPLACE FUNCTION offer_capacity_block_on_evidence()
RETURNS TRIGGER AS $$
DECLARE
  cap record;
BEGIN
  FOR cap IN
    SELECT DISTINCT r."ownerPublicKey", r."logicalOfferId"
      FROM "offer_capacity_reservations" r
      JOIN "trades" t ON t."tradeIntentId" = r."tradeIntentId"
      JOIN "escrows" e ON e."tradeId" = t."id"
     WHERE e."id" = NEW."escrowId" AND r."state" = 'RELEASED' AND r."releaseKind" IN ('L2_NEVER_FUNDED_REFUND', 'L3_FINALIZED_SETTLEMENT')
  LOOP
    INSERT INTO "offer_capacity_blocks" ("id", "ownerPublicKey", "logicalOfferId", "escrowId", "reason")
      VALUES (gen_random_uuid()::text, cap."ownerPublicKey", cap."logicalOfferId", NEW."escrowId", 'EVIDENCE_' || NEW."kind"::text)
      ON CONFLICT ("ownerPublicKey", "logicalOfferId", "escrowId") WHERE "clearedAt" IS NULL DO NOTHING;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE TRIGGER offer_capacity_block_release_evidence AFTER INSERT ON "escrow_release_evidence"
  FOR EACH ROW WHEN (NEW."kind"::text IN ('REORGED_INVALIDATED', 'REPLACEMENT_OBSERVED', 'AMBIGUOUS')) EXECUTE FUNCTION offer_capacity_block_on_evidence();
CREATE TRIGGER offer_capacity_block_funding_evidence AFTER INSERT ON "escrow_funding_evidence"
  FOR EACH ROW WHEN (NEW."kind"::text IN ('REORGED_INVALIDATED', 'REPLACEMENT_OBSERVED', 'AMBIGUOUS')) EXECUTE FUNCTION offer_capacity_block_on_evidence();

-- A: record the request (clears nothing).
CREATE OR REPLACE FUNCTION offer_capacity_request_unblock(p_block_id text, p_evidence jsonb, p_requester_key text)
RETURNS text AS $$
DECLARE
  b record;
  rid text := gen_random_uuid()::text;
BEGIN
  SELECT x."ownerPublicKey", x."logicalOfferId", x."escrowId", x."blockedAt", x."clearedAt" INTO b FROM "offer_capacity_blocks" x WHERE x."id" = p_block_id FOR SHARE;
  IF NOT FOUND OR b."clearedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'E25_UNBLOCK_NOT_BLOCKED: the block does not exist or is already cleared' USING ERRCODE = 'E2510';
  END IF;
  IF p_evidence IS NULL OR p_evidence->>'escrowId' IS DISTINCT FROM b."escrowId" THEN
    RAISE EXCEPTION 'E25_UNBLOCK_EVIDENCE_MISMATCH: the evidence must name the escrow that caused the block (%)', b."escrowId" USING ERRCODE = 'E2511';
  END IF;
  INSERT INTO "offer_capacity_unblock_requests" ("id", "blockId", "ownerPublicKey", "logicalOfferId", "evidence", "requesterKey", "requestedBySession", "digest")
    VALUES (rid, p_block_id, b."ownerPublicKey", b."logicalOfferId", p_evidence, p_requester_key, session_user,
            offer_capacity_unblock_digest(rid, p_block_id, b."ownerPublicKey", b."logicalOfferId", b."blockedAt", p_evidence, p_requester_key));
  RETURN rid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- B: the reviewer executes. Lock order: request row -> block row -> (settlement proof) escrow/disputes. The capacity row is never locked.
CREATE OR REPLACE FUNCTION offer_capacity_execute_unblock(p_request_id text, p_reviewer_key text, p_signature text)
RETURNS text AS $$
DECLARE
  q record;
  b record;
  v text;
  bad record;
BEGIN
  IF NOT pg_has_role(session_user, 'sails_capacity_reviewer', 'member') THEN
    RAISE EXCEPTION 'E25_UNBLOCK_NOT_REVIEWER: only the reviewer role may execute an unblock' USING ERRCODE = 'E2512';
  END IF;
  IF p_reviewer_key IS NULL OR p_reviewer_key !~ '^[0-9a-f]{64}$' OR p_signature IS NULL OR p_signature !~ '^[0-9a-f]{128}$' THEN
    RAISE EXCEPTION 'E25_UNBLOCK_BAD_SIGNATURE_SHAPE: reviewer key (64 hex) and signature (128 hex) are required' USING ERRCODE = 'E2513';
  END IF;

  SELECT x."id", x."blockId", x."ownerPublicKey", x."logicalOfferId", x."evidence", x."requesterKey", x."requestedBySession", x."digest", x."executedAt"
    INTO q FROM "offer_capacity_unblock_requests" x WHERE x."id" = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E25_UNBLOCK_NO_REQUEST: unknown request' USING ERRCODE = 'E2514'; END IF;
  IF q."executedAt" IS NOT NULL THEN RETURN 'NOOP:already_executed'; END IF;

  -- independence: A and B can never be the same effective principal. A requester session role that no longer exists FAILS CLOSED.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = q."requestedBySession") THEN
    RAISE EXCEPTION 'E25_UNBLOCK_SAME_PRINCIPAL: the requester session role cannot be resolved; independence cannot be proven' USING ERRCODE = 'E2515';
  END IF;
  IF q."requestedBySession" = session_user OR pg_has_role(session_user, q."requestedBySession", 'member') OR pg_has_role(q."requestedBySession", session_user, 'member')
     OR q."requesterKey" = p_reviewer_key THEN
    RAISE EXCEPTION 'E25_UNBLOCK_SAME_PRINCIPAL: the reviewer must be independent of the requester' USING ERRCODE = 'E2515';
  END IF;

  SELECT x."escrowId", x."blockedAt", x."clearedAt" INTO b FROM "offer_capacity_blocks" x WHERE x."id" = q."blockId" FOR UPDATE;
  IF q."digest" IS DISTINCT FROM offer_capacity_unblock_digest(q."id", q."blockId", q."ownerPublicKey", q."logicalOfferId", b."blockedAt", q."evidence", q."requesterKey") THEN
    RAISE EXCEPTION 'E25_UNBLOCK_DIGEST_MISMATCH: the stored request does not match its canonical digest' USING ERRCODE = 'E2516';
  END IF;
  IF b."clearedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'E25_UNBLOCK_STALE: the block of this request is already cleared' USING ERRCODE = 'E2517';
  END IF;

  -- the same L3 standard the release uses, re-derived now from persisted facts on the blocking escrow
  v := offer_capacity_settlement_proof(b."escrowId");
  IF v LIKE 'KEEP:%' THEN
    RAISE EXCEPTION 'E25_UNBLOCK_EVIDENCE_INSUFFICIENT: %', v USING ERRCODE = 'E2518';
  END IF;
  -- any unreconciled evidence (reorg, replacement, ambiguity) anywhere in the Offer's scope refuses the unblock
  SELECT e."id" INTO bad
    FROM "offer_capacity_reservations" r
    JOIN "trades" t ON t."tradeIntentId" = r."tradeIntentId"
    JOIN "escrows" e ON e."tradeId" = t."id"
   WHERE r."ownerPublicKey" = q."ownerPublicKey" AND r."logicalOfferId" = q."logicalOfferId"
     AND ( (SELECT f."kind"::text FROM "escrow_funding_evidence" f WHERE f."escrowId" = e."id" ORDER BY f."recordedAt" DESC, f."id" DESC LIMIT 1) IN ('REORGED_INVALIDATED', 'REPLACEMENT_OBSERVED', 'AMBIGUOUS')
        OR (SELECT x."kind"::text FROM "escrow_release_evidence" x WHERE x."escrowId" = e."id" ORDER BY x."recordedAt" DESC, x."id" DESC LIMIT 1) IN ('REORGED_INVALIDATED', 'REPLACEMENT_OBSERVED', 'AMBIGUOUS') )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'E25_UNBLOCK_SCOPE_AMBIGUOUS: unreconciled evidence remains in the Offer scope (escrow %)', bad."id" USING ERRCODE = 'E2519';
  END IF;

  UPDATE "offer_capacity_unblock_requests" SET "reviewerKey" = p_reviewer_key, "reviewerSession" = session_user, "reviewerSignature" = p_signature, "executedAt" = clock_timestamp()
   WHERE "id" = q."id" AND "executedAt" IS NULL;
  UPDATE "offer_capacity_blocks" SET "clearedAt" = clock_timestamp(), "clearedByRequestId" = q."id" WHERE "id" = q."blockId" AND "clearedAt" IS NULL;
  RETURN 'EXECUTED';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

RESET lock_timeout;
