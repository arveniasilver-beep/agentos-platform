-- Multi-turn follow-up (KEYSTONE). FULLY ADDITIVE: one new table for durable conversation turns on a task.
-- No existing table/column is altered. Inert unless FOLLOWUP_TURNS_ENABLED (only the follow-up path writes
-- rows). RLS workspace-isolated exactly like task_logs / task_snapshots.

CREATE TABLE "task_messages" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "task_messages_taskId_seq_key" ON "task_messages"("taskId", "seq");
CREATE INDEX "task_messages_taskId_createdAt_idx" ON "task_messages"("taskId", "createdAt");
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (tenant_isolation; agentos_app is the enforcing non-owner role).
ALTER TABLE "task_messages" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "task_messages";
CREATE POLICY tenant_isolation ON "task_messages"
  USING (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true))
  WITH CHECK (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true));
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON task_messages TO agentos_app';
  END IF;
END $$;
