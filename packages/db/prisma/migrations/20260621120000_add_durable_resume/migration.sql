-- Durable resume (TICKET-002/003/004). FULLY ADDITIVE: new nullable/defaulted columns on `tasks`
-- and a new `task_snapshots` table. No existing column/table/index is altered or dropped; the
-- TaskLog structure and all event types are untouched. Inert unless RESUME_ENABLED=true at runtime.

-- Worker lease + fencing + resume bookkeeping on tasks.
ALTER TABLE "tasks" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "tasks" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN "fencingToken" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD COLUMN "resumeCount" INTEGER NOT NULL DEFAULT 0;

-- Latest serialized engine state per task (one row per task; upserted at step boundaries).
CREATE TABLE "task_snapshots" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_snapshots_taskId_key" ON "task_snapshots"("taskId");
CREATE INDEX "task_snapshots_workspaceId_idx" ON "task_snapshots"("workspaceId");

ALTER TABLE "task_snapshots"
    ADD CONSTRAINT "task_snapshots_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security for the new table, mirroring the existing tenant_isolation pattern
-- (ENABLE only, no FORCE — owner-exempt for migrations/admin; the non-owner runtime role
-- `agentos_app` is fully subject to it). Snapshots carry messages[] so they MUST be workspace
-- isolated exactly like task_logs: no cross-workspace read.
ALTER TABLE "task_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "task_snapshots";
CREATE POLICY tenant_isolation ON "task_snapshots"
  USING (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true))
  WITH CHECK (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true));

-- Grant CRUD to the least-privilege runtime role (ALTER DEFAULT PRIVILEGES from the rls_app_role
-- migration already covers owner-created tables, but grant explicitly to be safe if it pre-existed).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "task_snapshots" TO agentos_app;
  END IF;
END $$;
