-- #308 / D-308 — additive only: a proposal-generation counter on disputes (existing rows start at 0) and a
-- transactional outbox for the AUTO_PROPOSED -> EVIDENCE_SUBMITTED transition event. No data is rewritten.

-- AlterTable
ALTER TABLE "disputes" ADD COLUMN "autoProposalGeneration" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "dispute_transition_outbox" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "dispute_transition_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dispute_transition_outbox_disputeId_generation_kind_key" ON "dispute_transition_outbox"("disputeId", "generation", "kind");

-- CreateIndex
CREATE INDEX "dispute_transition_outbox_publishedAt_createdAt_idx" ON "dispute_transition_outbox"("publishedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "dispute_transition_outbox" ADD CONSTRAINT "dispute_transition_outbox_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
