-- CreateTable
CREATE TABLE "automations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "cronExpression" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "riskCeiling" "RiskLevel" NOT NULL DEFAULT 'high',
    "stepBudget" INTEGER NOT NULL DEFAULT 12,
    "costBudgetUsd" DECIMAL(14,6),
    "lastRunAt" TIMESTAMP(3),
    "lastTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automations_workspaceId_enabled_idx" ON "automations"("workspaceId", "enabled");

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
