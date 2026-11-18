-- "My Computer": host folders the user approved the agent to operate on. Workspace-scoped with the
-- standard tenant-isolation RLS. Only honored when the server runs with ENABLE_LOCAL_FS.
CREATE TABLE "local_folders" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "label"           TEXT NOT NULL,
  "path"            TEXT NOT NULL,
  "writable"        BOOLEAN NOT NULL DEFAULT false,
  "createdByUserId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "local_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "local_folders_workspaceId_idx" ON "local_folders"("workspaceId");

ALTER TABLE "local_folders"
  ADD CONSTRAINT "local_folders_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "local_folders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "local_folders"
  USING (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true))
  WITH CHECK (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true));
