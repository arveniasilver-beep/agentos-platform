-- Desktop Runner Foundation (TICKET-7). FULLY ADDITIVE: one new table for registered desktop local
-- runners (tied to a Device). No existing table is altered. Inert unless DESKTOP_RUNNER_ENABLED.

CREATE TABLE "desktop_runners" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "version" TEXT,
    "capabilities" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "desktop_runners_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "desktop_runners_workspaceId_deviceId_key" ON "desktop_runners"("workspaceId", "deviceId");
CREATE INDEX "desktop_runners_workspaceId_status_idx" ON "desktop_runners"("workspaceId", "status");

ALTER TABLE "desktop_runners"
    ADD CONSTRAINT "desktop_runners_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "desktop_runners"
    ADD CONSTRAINT "desktop_runners_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security: tenant_isolation (ENABLE only; the non-owner runtime role agentos_app is subject
-- to it). Desktop runners MUST be workspace-isolated.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE desktop_runners ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON desktop_runners';
  EXECUTE
    'CREATE POLICY tenant_isolation ON desktop_runners '
    || 'USING (current_setting(''agentos.bypass_rls'', true) = ''on'' '
    || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true)) '
    || 'WITH CHECK (current_setting(''agentos.bypass_rls'', true) = ''on'' '
    || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true))';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON desktop_runners TO agentos_app';
  END IF;
END $$;
