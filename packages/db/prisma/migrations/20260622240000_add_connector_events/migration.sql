-- Connectors v2 (TICKET-9). FULLY ADDITIVE: one nullable webhook-secret-hash column on connections +
-- one new table for inbound connector webhook events. No existing column is altered. Inert unless
-- CONNECTORS_V2_ENABLED.

ALTER TABLE "connections" ADD COLUMN "webhookSecretHash" TEXT;

CREATE TABLE "connector_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "connector_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "connector_events_workspaceId_createdAt_idx" ON "connector_events"("workspaceId", "createdAt");
CREATE INDEX "connector_events_connectionId_createdAt_idx" ON "connector_events"("connectionId", "createdAt");
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (tenant_isolation, ENABLE-only; agentos_app is the enforcing non-owner role).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE connector_events ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON connector_events';
  EXECUTE
    'CREATE POLICY tenant_isolation ON connector_events '
    || 'USING (current_setting(''agentos.bypass_rls'', true) = ''on'' '
    || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true)) '
    || 'WITH CHECK (current_setting(''agentos.bypass_rls'', true) = ''on'' '
    || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true))';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON connector_events TO agentos_app';
  END IF;
END $$;
