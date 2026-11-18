-- Always-on agent personalization (Manus-style): one row per workspace holding the profile, custom
-- instructions, and remembered facts prepended to every task's system prompt.
CREATE TABLE "personalizations" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "nickname"     TEXT,
  "profession"   TEXT,
  "about"        TEXT,
  "instructions" TEXT,
  "memories"     JSONB NOT NULL DEFAULT '[]',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "personalizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "personalizations_workspaceId_key" ON "personalizations"("workspaceId");

ALTER TABLE "personalizations"
  ADD CONSTRAINT "personalizations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Same tenant-isolation RLS as every other workspace-scoped table (ENABLE only, no FORCE: the
-- non-owner agentos_app runtime role is subject to it; the owner runs migrations exempt).
ALTER TABLE "personalizations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "personalizations"
  USING (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true))
  WITH CHECK (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true));
