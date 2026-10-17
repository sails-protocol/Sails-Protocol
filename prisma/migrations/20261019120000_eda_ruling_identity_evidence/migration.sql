-- AUD1X-R3 (AR2-01): an Economic Disposition Authorization records WHICH signed ruling it authorized - the
-- authority signature of the generation and the durable Outcome record it was judged against - so a later ruling of
-- the same appeal round can never be taken for it. Additive and nullable: rows committed before this migration carry
-- no such evidence and are treated as unproven (fail closed), never back-filled by inference.
ALTER TABLE "economic_disposition_authorizations" ADD COLUMN "rulingAuthoritySignature" TEXT;
ALTER TABLE "economic_disposition_authorizations" ADD COLUMN "outcomeRecordId" TEXT;
