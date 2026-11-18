-- Durable AutomationRun / Scheduled Tasks (TICKET-AUTOMATION). FULLY ADDITIVE: one new table +
-- one new nullable column on "tasks". No existing table/column/index/event-type is altered or renamed.
-- Inert unless AUTOMATION_RUNS_ENABLED=true.

CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "triggeredBy" TEXT NOT NULL,
    "scheduledFireKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "retryOfRunId" TEXT,
    "skipReason" TEXT,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- Idempotency + retry-safety: a duplicate delivery of the SAME scheduled fire collides here (dedup);
-- a run-level retry uses a higher attempt so it never collides.
CREATE UNIQUE INDEX "automation_runs_automationId_scheduledFireKey_attempt_key"
    ON "automation_runs"("automationId", "scheduledFireKey", "attempt");
CREATE INDEX "automation_runs_automationId_createdAt_idx" ON "automation_runs"("automationId", "createdAt");
CREATE INDEX "automation_runs_workspaceId_status_idx" ON "automation_runs"("workspaceId", "status");

ALTER TABLE "automation_runs"
    ADD CONSTRAINT "automation_runs_automationId_fkey"
    FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Link a task back to the automation run that launched it (additive, nullable, no enforced FK).
ALTER TABLE "tasks" ADD COLUMN "automationRunId" TEXT;
CREATE INDEX "tasks_automationRunId_idx" ON "tasks"("automationRunId");

-- Row-Level Security mirroring the existing tenant_isolation pattern (ENABLE only, no FORCE; the
-- non-owner runtime role agentos_app is fully subject to it). Automation runs MUST be workspace-isolated.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON automation_runs';
  EXECUTE
    'CREATE POLICY tenant_isolation ON automation_runs '
    || 'USING (current_setting(''agentos.bypass_rls'', true) = ''on'' '
    || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true)) '
    || 'WITH CHECK (current_setting(''agentos.bypass_rls'', true) = ''on'' '
    || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true))';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON automation_runs TO agentos_app';
  END IF;
END $$;
