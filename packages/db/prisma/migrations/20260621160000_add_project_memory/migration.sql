-- Project Memory / Context System (TICKET-AUTOMATION → TICKET-MEMORY). FULLY ADDITIVE: one new table.
-- No existing table/column/index/event-type is altered or renamed. Inert unless PROJECT_MEMORY_ENABLED.

CREATE TABLE "project_memory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "sourceTaskId" TEXT,
    "sourceArtifactId" TEXT,
    "sourceCommitHash" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_memory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_memory_workspaceId_kind_idx" ON "project_memory"("workspaceId", "kind");
CREATE INDEX "project_memory_workspaceId_projectId_archivedAt_idx" ON "project_memory"("workspaceId", "projectId", "archivedAt");
CREATE INDEX "project_memory_workspaceId_archivedAt_priority_idx" ON "project_memory"("workspaceId", "archivedAt", "priority");

ALTER TABLE "project_memory"
    ADD CONSTRAINT "project_memory_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security mirroring the existing tenant_isolation pattern (ENABLE only, no FORCE; the
-- non-owner runtime role agentos_app is fully subject to it). Memory MUST be workspace-isolated.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE project_memory ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON project_memory';
  EXECUTE
    'CREATE POLICY tenant_isolation ON project_memory '
    || 'USING (current_setting(''agentos.bypass_rls'', true) = ''on'' '
    || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true)) '
    || 'WITH CHECK (current_setting(''agentos.bypass_rls'', true) = ''on'' '
    || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true))';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON project_memory TO agentos_app';
  END IF;
END $$;
