-- AUD1X-H1 legacy exposure inventory - READ ONLY (one READ ONLY transaction, SELECT only, nothing is written).
-- Plan and handling rules: docs/aud1x-h1-legacy-exposure-inventory.md
--
-- Run on a replica / snapshot of the production database, by someone who is allowed to see it. The output is a set of
-- identifiers and counts - it never selects a PSBT, a signature, a key or an address. Do NOT paste row-level output
-- outside the access-controlled channel the CTO names.
--
-- What each query means (rows = rows whose economic authority or bearer exposure is in doubt):
--   Q1  a disputed MULTISIG round built BEFORE any signed ruling existed (the audit's probe F1 / AUD1X-H1). Its stored
--       PSBT embeds the arbiter signature (see Q6), so the beneficiary can complete it outside Sails.
--   Q2  a disputed round whose kind contradicts the ruling it records, or the dispute's current ruling (AUD-1 / R1).
--   Q3  a committed Economic Disposition Authorization whose round contradicts the ruling it was committed under (R6).
--   Q4  an escrow already settled against its dispute's RESOLVED ruling: an effect that already happened (R4).
--   Q5  a recorded live correspondence evaluation that is not a MATCH for every beneficiary (R4 detection, M2).
--   Q6  a pending round whose stored PSBT ALREADY embeds the escrow's committed arbiter signature: executable by its
--       beneficiary with their own key alone. Written by code before AUD1X-H1; cannot be revoked by this change.
--   Q7  a stored client signature copy that embeds the arbiter signature (the same exposure through a participant's
--       own submitted copy).
--   Q8  an Economic Disposition Authorization committed by earlier code for a round that still exists and embeds the
--       arbiter signature: the reuse path will let it execute (after the AUD-1 binding judged it).
--
-- The embedded-signature test looks for the exact 35-byte PSBT_IN_PARTIAL_SIG key (0x22 0x02 || the escrow's own
-- committed arbiter pubkey) inside the decoded PSBT: key length 34, key type 0x02, 33-byte public key.
BEGIN TRANSACTION READ ONLY;

-- Q1
SELECT 'Q1_pre_ruling_disputed_round' AS q, p.id AS round_id, p."escrowId", p.kind, p."createdAt",
       d.status::text AS dispute_status, d.ruling::text AS dispute_ruling
FROM escrow_pending_transactions p
JOIN escrows e ON e.id = p."escrowId"
JOIN disputes d ON d.id = p."disputeId"
WHERE e.type = 'MULTISIG' AND p."disputeId" IS NOT NULL AND p."rulingOutcome" IS NULL;

-- Q2
SELECT 'Q2_contradicting_round' AS q, p.id AS round_id, p."escrowId", p.kind,
       p."rulingOutcome"::text AS recorded_ruling, d.ruling::text AS current_ruling,
       (SELECT count(*) FROM escrow_transaction_signatures s WHERE s."pendingTxId" = p.id) AS signatures
FROM escrow_pending_transactions p
JOIN disputes d ON d.id = p."disputeId"
WHERE p."disputeId" IS NOT NULL
  AND ((p."rulingOutcome" IS NOT NULL AND lower(p."rulingOutcome"::text) <> p.kind)
    OR (d.ruling IS NOT NULL AND lower(d.ruling::text) <> p.kind));

-- Q3
SELECT 'Q3_contradicting_authorization' AS q, a.id AS authorization_id, a."pendingOperationId", a."escrowId",
       a.ruling::text AS authorized_ruling, p.kind
FROM economic_disposition_authorizations a
JOIN escrow_pending_transactions p ON p.id = a."pendingOperationId"
WHERE lower(a.ruling::text) <> p.kind;

-- Q4
SELECT 'Q4_settled_against_ruling' AS q, e.id AS escrow_id, e.status::text AS escrow_status, d.ruling::text AS ruling, e."txReleaseId"
FROM escrows e
JOIN disputes d ON d."escrowId" = e.id
WHERE d.status = 'RESOLVED' AND e.status IN ('COMPLETED', 'REFUNDED', 'SPLIT')
  AND NOT ((d.ruling = 'RELEASE' AND e.status = 'COMPLETED') OR (d.ruling = 'REFUND' AND e.status = 'REFUNDED') OR (d.ruling = 'SPLIT' AND e.status = 'SPLIT'));

-- Q5
SELECT 'Q5_non_matching_correspondence' AS q, c."escrowId", c."appealRound", c.results
FROM correspondence_evaluations c
WHERE EXISTS (SELECT 1 FROM jsonb_each_text(c.results::jsonb) r WHERE r.value <> 'MATCH');

-- Q6
SELECT 'Q6_round_embeds_arbiter_signature' AS q, p.id AS round_id, p."escrowId", p.kind,
       (p."disputeId" IS NOT NULL) AS disputed, p."rulingOutcome"::text AS recorded_ruling, p."createdAt"
FROM escrow_pending_transactions p
JOIN escrows e ON e.id = p."escrowId" AND e.type = 'MULTISIG'
JOIN escrow_participant_keys k ON k."escrowId" = p."escrowId" AND k.role = 'arbiter'
WHERE position(('\x2202'::bytea || decode(k.pubkey, 'hex')) in decode(p."unsignedPsbtBase64", 'base64')) > 0;

-- Q7
SELECT 'Q7_signed_copy_embeds_arbiter_signature' AS q, s.id AS signature_id, s."pendingTxId", s."participantId", p."escrowId"
FROM escrow_transaction_signatures s
JOIN escrow_pending_transactions p ON p.id = s."pendingTxId"
JOIN escrows e ON e.id = p."escrowId" AND e.type = 'MULTISIG'
JOIN escrow_participant_keys k ON k."escrowId" = p."escrowId" AND k.role = 'arbiter'
WHERE position(('\x2202'::bytea || decode(k.pubkey, 'hex')) in decode(s."signedPsbtBase64", 'base64')) > 0;

-- Q8
SELECT 'Q8_authorization_for_embedding_round' AS q, a.id AS authorization_id, a."pendingOperationId", a."escrowId", a.ruling::text AS authorized_ruling
FROM economic_disposition_authorizations a
JOIN escrow_pending_transactions p ON p.id = a."pendingOperationId"
JOIN escrow_participant_keys k ON k."escrowId" = p."escrowId" AND k.role = 'arbiter'
WHERE position(('\x2202'::bytea || decode(k.pubkey, 'hex')) in decode(p."unsignedPsbtBase64", 'base64')) > 0;

ROLLBACK;
