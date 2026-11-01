-- Issue #267 — OpenProof Evidence Upload Policy V1.
-- Persist the actual authorized uploader and decoded media byte size so
-- PostgreSQL, not object storage, is the durable cumulative quota ledger.
--
-- Existing rows predate durable uploader/size accounting and cannot be
-- reconstructed safely from Proof.submittedBy or provider metadata.
-- Day-0 migration therefore fails closed if evidence already exists rather
-- than fabricating quota provenance. A production operator with legacy rows
-- must explicitly reconcile/backfill them before applying this migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM evidence_references LIMIT 1) THEN
    RAISE EXCEPTION
      'Issue #267 migration requires explicit reconciliation of existing evidence_references before durable uploader/size quota accounting can be enabled';
  END IF;
END $$;

ALTER TABLE evidence_references
  ADD COLUMN "submittedBy" TEXT NOT NULL,
  ADD COLUMN "sizeBytes" INTEGER NOT NULL;

ALTER TABLE evidence_references
  ADD CONSTRAINT evidence_references_size_bytes_positive
  CHECK ("sizeBytes" > 0);

CREATE INDEX evidence_references_proofId_submittedBy_idx
  ON evidence_references("proofId", "submittedBy");

-- Durable pre-storage quota reservations. RESERVED/UNKNOWN rows consume
-- quota; COMMITTED rows are represented by their EvidenceReference and
-- RELEASED rows consume none.
CREATE TYPE "EvidenceUploadReservationStatus" AS ENUM ('RESERVED', 'COMMITTED', 'UNKNOWN', 'RELEASED');

CREATE TABLE evidence_upload_reservations (
  id TEXT PRIMARY KEY,
  "proofId" TEXT NOT NULL,
  "submittedBy" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes" > 0),
  "operationKey" TEXT NOT NULL,
  "mediaSha256" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  status "EvidenceUploadReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "evidenceRefId" TEXT,
  "eventRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX evidence_upload_reservations_submittedBy_operationKey_key
  ON evidence_upload_reservations("submittedBy", "operationKey");
CREATE INDEX evidence_upload_reservations_proofId_idx
  ON evidence_upload_reservations("proofId");
CREATE INDEX evidence_upload_reservations_proofId_submittedBy_idx
  ON evidence_upload_reservations("proofId", "submittedBy");

CREATE UNIQUE INDEX evidence_upload_reservations_eventRecordId_key
  ON evidence_upload_reservations("eventRecordId");

CREATE TABLE "evidence_object_cleanup_claims" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "uri" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_object_cleanup_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "evidence_object_cleanup_claims_provider_uri_key"
  ON "evidence_object_cleanup_claims"("provider", "uri");
