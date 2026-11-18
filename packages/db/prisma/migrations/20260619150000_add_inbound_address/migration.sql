-- Mail-to-task inbound address: an email service POSTs parsed mail to /inbound-email/<token>; a
-- matching enabled row creates a task. The token is the capability (looked up in system context).
CREATE TABLE "inbound_addresses" (
  "id"              TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "token"           TEXT NOT NULL,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "allowedSenders"  JSONB NOT NULL DEFAULT '[]',
  "createdByUserId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inbound_addresses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbound_addresses_workspaceId_key" ON "inbound_addresses"("workspaceId");
CREATE UNIQUE INDEX "inbound_addresses_token_key" ON "inbound_addresses"("token");

ALTER TABLE "inbound_addresses"
  ADD CONSTRAINT "inbound_addresses_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-isolation RLS (ENABLE only). The unauthenticated webhook resolves the token in system
-- (bypass) context, then creates the task in the workspace's context.
ALTER TABLE "inbound_addresses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inbound_addresses"
  USING (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true))
  WITH CHECK (current_setting('agentos.bypass_rls', true) = 'on'
    OR "workspaceId" = current_setting('agentos.workspace_id', true));
