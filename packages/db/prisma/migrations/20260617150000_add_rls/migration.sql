-- Defense-in-depth tenancy: Postgres Row-Level Security on every always-single-workspace data
-- table. This sits BEHIND the application-level workspaceId filters (the primary control) — if an
-- app query ever forgets a tenancy filter, the database itself still refuses cross-workspace rows.
--
-- Each table gets a single FOR ALL policy. A row is visible/writable only when the trusted-bypass
-- GUC is on (system/background work) OR the row's workspaceId equals the per-transaction
-- `agentos.workspace_id` GUC that the application sets via set_config(..., is_local => true) on the
-- same connection as the query. With neither GUC set, current_setting(...) is NULL, so the
-- predicate is false and the policy matches no rows: fail closed.
--
-- FORCE ROW LEVEL SECURITY makes the policy apply even to the table owner (the role the app
-- connects as), so enforcement does not depend on provisioning a separate restricted role.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'tasks', 'task_logs', 'tool_calls', 'approvals', 'secrets', 'projects',
    'automations', 'skills', 'usage_records', 'cost_records', 'audit_logs',
    'notifications', 'vector_documents'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING (current_setting(''agentos.bypass_rls'', true) = ''on'' '
      || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true)) '
      || 'WITH CHECK (current_setting(''agentos.bypass_rls'', true) = ''on'' '
      || 'OR "workspaceId" = current_setting(''agentos.workspace_id'', true))',
      t
    );
  END LOOP;
END $$;
