-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'DEAD_LETTER');

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "deadLetteredAt" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING';

-- Update existing processed events to PUBLISHED status
UPDATE "OutboxEvent" SET "status" = 'PUBLISHED' WHERE "processedAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_createdAt_idx" ON "OutboxEvent"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_deadLetteredAt_idx" ON "OutboxEvent"("status", "deadLetteredAt");
