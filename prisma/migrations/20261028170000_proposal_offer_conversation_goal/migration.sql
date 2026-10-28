-- Proposals created by accepting an offer remember that offer, so a proposal that is rejected,
-- expires or fails releases it instead of hiding it for the whole 7-day window.
ALTER TABLE "ActionProposal" ADD COLUMN "offerId" TEXT;
CREATE INDEX "ActionProposal_offerId_idx" ON "ActionProposal"("offerId");

-- Backfill from the audit trail: every offer.accepted entry records the proposal it created.
UPDATE "ActionProposal" ap
SET "offerId" = substring(a."resource" FROM 7)
FROM "AuditLog" a
WHERE a."action" = 'offer.accepted'
  AND a."resource" LIKE 'offer:%'
  AND a."details"->>'proposalId' = ap."id"
  AND ap."offerId" IS NULL;

-- A conversation can be about one of the user's goals (goal chat).
ALTER TABLE "Conversation" ADD COLUMN "goalId" TEXT;
