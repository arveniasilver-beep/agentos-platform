-- A least-privilege runtime role for Row-Level Security enforcement.
--
-- Postgres superusers (and BYPASSRLS roles) ignore RLS unconditionally, so the policies added in
-- 20260617_add_rls only take effect when the application connects as a NON-superuser role. This
-- creates that role: it has full CRUD on the schema's tables but is not a superuser and does not
-- have BYPASSRLS, so the tenant_isolation policies apply to it. Migrations and admin tasks keep
-- using the owner role; the running app/worker should connect as `agentos_app` in production.
--
-- The dev password here is a placeholder — rotate it (ALTER ROLE agentos_app PASSWORD '...') and
-- restrict pg_hba/network access for any real deployment.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentos_app') THEN
    CREATE ROLE agentos_app LOGIN PASSWORD 'agentos_app'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO agentos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agentos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agentos_app;

-- Future tables/sequences created by the owner are granted automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agentos_app;
