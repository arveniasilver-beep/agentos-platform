-- Workflow Builder (TICKET-8). FULLY ADDITIVE: two new tables (workflow definition + run). No existing
-- table is altered; single-step automations are untouched. Inert unless WORKFLOW_BUILDER_ENABLED.

CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "webhookSecretHash" TEXT,
    "cronExpression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflows_workspaceId_idx" ON "workflows"("workspaceId");
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "triggeredBy" TEXT NOT NULL,
    "currentStepId" TEXT,
    "stepStates" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflow_runs_workspaceId_status_idx" ON "workflow_runs"("workspaceId", "status");
CREATE INDEX "workflow_runs_workflowId_createdAt_idx" ON "workflow_runs"("workflowId", "createdAt");
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Link a task back to its workflow run step (additive nullable column, mirrors automationRunId).
ALTER TABLE "tasks" ADD COLUMN "workflowRunId" TEXT;
CREATE INDEX "tasks_workflowRunId_idx" ON "tasks"("workflowRunId");

-- Row-Level Security (tenant_isolation, ENABLE-only; agentos_app is the enforcing non-owner role).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflows','workflow_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ('
      || 'current_setting(''agentos.bypass_rls'', true) = ''on'' '
      || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true)) '
      || 'WITH CHECK ('
      || 'current_setting(''agentos.bypass_rls'', true) = ''on'' '
      || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true))', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO agentos_app', t);
    END IF;
  END LOOP;
END $$;
