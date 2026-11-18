-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'planning', 'awaiting_approval', 'running', 'paused', 'verifying', 'completed', 'failed', 'stopped');

-- DropIndex
DROP INDEX "vector_documents_embedding_hnsw";

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "riskCeiling" "RiskLevel" NOT NULL DEFAULT 'high',
    "stepBudget" INTEGER NOT NULL DEFAULT 12,
    "costBudgetUsd" DECIMAL(14,6),
    "estCostUsd" DECIMAL(14,6),
    "result" JSONB,
    "errorText" TEXT,
    "killRequested" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_logs" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_calls" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "risk" "RiskLevel" NOT NULL,
    "args" JSONB NOT NULL,
    "output" JSONB,
    "ok" BOOLEAN,
    "errorText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "risk" "RiskLevel" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedByUserId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "model" TEXT NOT NULL DEFAULT 'claude-opus-4-8',
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheReadTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheWriteTokens" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_records" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT,
    "amountUsd" DECIMAL(14,6) NOT NULL,
    "tokenCount" BIGINT NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_workspaceId_status_idx" ON "tasks"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "tasks_createdAt_idx" ON "tasks"("createdAt");

-- CreateIndex
CREATE INDEX "task_logs_taskId_createdAt_idx" ON "task_logs"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "task_logs_taskId_seq_key" ON "task_logs"("taskId", "seq");

-- CreateIndex
CREATE INDEX "tool_calls_workspaceId_toolName_idx" ON "tool_calls"("workspaceId", "toolName");

-- CreateIndex
CREATE UNIQUE INDEX "tool_calls_taskId_callId_key" ON "tool_calls"("taskId", "callId");

-- CreateIndex
CREATE INDEX "approvals_workspaceId_status_idx" ON "approvals"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_taskId_approvalId_key" ON "approvals"("taskId", "approvalId");

-- CreateIndex
CREATE INDEX "usage_records_workspaceId_createdAt_idx" ON "usage_records"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "cost_records_workspaceId_idx" ON "cost_records"("workspaceId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
