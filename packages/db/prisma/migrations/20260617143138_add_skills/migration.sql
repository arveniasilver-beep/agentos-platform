-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT NOT NULL,
    "riskCeiling" "RiskLevel" NOT NULL DEFAULT 'high',
    "stepBudget" INTEGER NOT NULL DEFAULT 12,
    "costBudgetUsd" DECIMAL(14,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skills_workspaceId_idx" ON "skills"("workspaceId");

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
