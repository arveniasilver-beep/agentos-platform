-- Connected third-party accounts (OAuth), e.g. GitHub. One row per (workspace, provider). The
-- access token lives encrypted in the secrets vault; this row tracks the account + scopes.
CREATE TABLE "connections" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  "externalId"      TEXT NOT NULL,
  "accountLabel"    TEXT NOT NULL,
  "scopes"          TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "connections_workspaceId_provider_key" ON "connections"("workspaceId", "provider");

ALTER TABLE "connections"
  ADD CONSTRAINT "connections_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Same tenant-isolation RLS as every other workspace-scoped table (ENABLE only, no FORCE).
ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "connections"
  USING (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true))
  WITH CHECK (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true));
