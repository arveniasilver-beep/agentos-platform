-- Durable Artifact Persistence (TICKET-ART). FULLY ADDITIVE: two new tables. No existing
-- table/column/index/event-type is altered. Inert unless ARTIFACT_PERSISTENCE_ENABLED=true.

CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "artifacts_taskId_name_key" ON "artifacts"("taskId", "name");
CREATE INDEX "artifacts_workspaceId_idx" ON "artifacts"("workspaceId");
CREATE INDEX "artifacts_taskId_idx" ON "artifacts"("taskId");

ALTER TABLE "artifacts"
    ADD CONSTRAINT "artifacts_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "artifact_versions" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "blobKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "artifact_versions_artifactId_version_key" ON "artifact_versions"("artifactId", "version");
CREATE INDEX "artifact_versions_workspaceId_idx" ON "artifact_versions"("workspaceId");
CREATE INDEX "artifact_versions_artifactId_idx" ON "artifact_versions"("artifactId");

ALTER TABLE "artifact_versions"
    ADD CONSTRAINT "artifact_versions_artifactId_fkey"
    FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security mirroring the existing tenant_isolation pattern (ENABLE only, no FORCE; the
-- non-owner runtime role agentos_app is fully subject to it). Artifacts MUST be workspace-isolated.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['artifacts','artifact_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING (current_setting(''agentos.bypass_rls'', true) = ''on'' '
      || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true)) '
      || 'WITH CHECK (current_setting(''agentos.bypass_rls'', true) = ''on'' '
      || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true))',
      t
    );
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO agentos_app', t);
    END IF;
  END LOOP;
END $$;
