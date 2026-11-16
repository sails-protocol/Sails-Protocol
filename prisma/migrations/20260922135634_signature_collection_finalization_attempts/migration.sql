-- CreateEnum
CREATE TYPE "SignatureCollectionFinalizationStatus" AS ENUM ('SUBMISSION_UNKNOWN', 'SUBMITTED', 'CONFIRMED');

-- CreateTable
CREATE TABLE "signature_collection_finalization_attempts" (
    "id" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "pendingTxId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "SignatureCollectionFinalizationStatus" NOT NULL DEFAULT 'SUBMISSION_UNKNOWN',
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_collection_finalization_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signature_collection_finalization_attempts_escrowId_key" ON "signature_collection_finalization_attempts"("escrowId");

-- AddForeignKey
ALTER TABLE "signature_collection_finalization_attempts" ADD CONSTRAINT "signature_collection_finalization_attempts_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "escrows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
