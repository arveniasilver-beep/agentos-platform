-- Browser Operator Hardening (TICKET-1). FULLY ADDITIVE: two new tables (durable browser session +
-- action trace). No existing table/column/index is altered. Inert unless BROWSER_OPERATOR_ENABLED.

CREATE TABLE "browser_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastUrl" TEXT,
    "lastAction" TEXT,
    "actionCount" INTEGER NOT NULL DEFAULT 0,
    "approvalCount" INTEGER NOT NULL DEFAULT 0,
    "deniedCount" INTEGER NOT NULL DEFAULT 0,
    "takeover" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "browser_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "browser_sessions_workspaceId_status_idx" ON "browser_sessions"("workspaceId", "status");
CREATE INDEX "browser_sessions_taskId_idx" ON "browser_sessions"("taskId");
ALTER TABLE "browser_sessions"
    ADD CONSTRAINT "browser_sessions_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "browser_actions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT,
    "callId" TEXT,
    "action" TEXT NOT NULL,
    "url" TEXT,
    "target" TEXT,
    "risk" TEXT NOT NULL DEFAULT 'low',
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "approvalId" TEXT,
    "screenshotArtifactId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "browser_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "browser_actions_sessionId_createdAt_idx" ON "browser_actions"("sessionId", "createdAt");
CREATE INDEX "browser_actions_workspaceId_createdAt_idx" ON "browser_actions"("workspaceId", "createdAt");
CREATE INDEX "browser_actions_callId_idx" ON "browser_actions"("callId");
ALTER TABLE "browser_actions"
    ADD CONSTRAINT "browser_actions_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "browser_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_actions"
    ADD CONSTRAINT "browser_actions_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security: same tenant_isolation pattern (ENABLE only; the non-owner runtime role agentos_app
-- is fully subject to it). Browser sessions/actions MUST be workspace-isolated.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['browser_sessions','browser_actions'] LOOP
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
