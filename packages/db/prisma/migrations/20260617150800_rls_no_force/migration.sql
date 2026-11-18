-- Drop FORCE ROW LEVEL SECURITY (keep ENABLE).
--
-- Under FORCE, the policies apply even to the table OWNER. On a managed-Postgres deployment the
-- owner/master role is NOT a superuser, so an owner-run data migration (backfill/transform) on
-- these tables would silently match zero rows — a dangerous no-op. Under ENABLE-only, the owner is
-- naturally exempt (so migrations and admin tasks run as the owner work without any GUC), while the
-- non-owner runtime role `agentos_app` (NOSUPERUSER, NOBYPASSRLS) remains fully subject to the
-- tenant_isolation policies. This is the standard "app connects as a least-privilege non-owner
-- role" RLS model; enforcement for the app path is unchanged.

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
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
