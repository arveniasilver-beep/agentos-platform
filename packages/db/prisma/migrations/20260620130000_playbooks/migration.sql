-- Reusable task templates (Manus "Playbook"): a saved prompt + optional capability/effort the user
-- re-runs on demand to spawn a new task. Workspace-scoped with the same tenant-isolation RLS.
CREATE TABLE "playbooks" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "prompt"          TEXT NOT NULL,
  "capability"      TEXT,
  "effort"          TEXT,
  "createdByUserId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "playbooks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "playbooks_workspaceId_idx" ON "playbooks"("workspaceId");

ALTER TABLE "playbooks"
  ADD CONSTRAINT "playbooks_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "playbooks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "playbooks"
  USING (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true))
  WITH CHECK (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true));
