-- #308 / D-308: a pending row in this outbox is an event still owed, so deleting its dispute must be refused, not
-- cascade the debt away. Follow-up migration on purpose: 20261031120000_dispute_auto_proposal_generation_outbox was
-- already audited and is left untouched. No data is rewritten.

-- DropForeignKey
ALTER TABLE "dispute_transition_outbox" DROP CONSTRAINT "dispute_transition_outbox_disputeId_fkey";

-- AddForeignKey
ALTER TABLE "dispute_transition_outbox" ADD CONSTRAINT "dispute_transition_outbox_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
