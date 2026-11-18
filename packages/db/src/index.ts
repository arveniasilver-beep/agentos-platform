export * from '@prisma/client';
import { PrismaClient, Prisma } from '@prisma/client';
import { tenantContext } from './tenant-context';

export { tenantContext } from './tenant-context';
export type { TenantStore } from './tenant-context';

/**
 * Prisma MODEL names (not table names) that carry a `workspaceId` and are protected by Postgres
 * Row-Level Security. Excluded by design: User/Session (global), Workspace/WorkspaceMember
 * (accessed cross-workspace, e.g. listing a user's memberships before any workspace context
 * exists) and ApiKey (a bearer token is resolved across workspaces in the guard before the
 * workspace is known). Those rely on the app-level tenancy filters.
 *
 * NOTE: the GUC is applied below only for Prisma MODEL operations. RAW SQL ($queryRaw/$executeRaw)
 * against these tables — e.g. a future pgvector KNN over VectorDocument — bypasses this wrapper, so
 * it must set the GUC itself by running inside `base.$transaction([set_config(...), <raw query>])`
 * (read the same tenantContext store), or it will be denied under the enforcing role.
 */
const RLS_MODELS = new Set<string>([
  'Task',
  'TaskLog',
  'TaskSnapshot',
  'TaskMessage',
  'Artifact',
  'ArtifactVersion',
  'ToolCall',
  'Approval',
  'Secret',
  'Project',
  'Automation',
  'AutomationRun',
  'ProjectMemory',
  'BrowserSession',
  'BrowserAction',
  'DesktopRunner',
  'Workflow',
  'WorkflowRun',
  'ConnectorEvent',
  'Skill',
  'UsageRecord',
  'CostRecord',
  'AuditLog',
  'Notification',
  'VectorDocument',
  'Personalization',
  'Connection',
  'InboundAddress',
  'Playbook',
  'LocalFolder',
]);

/**
 * Build the canonical client with the RLS tenancy extension. Every operation on an RLS-protected
 * model is wrapped in a short transaction that first sets the per-transaction GUC the table
 * policies read (`SET LOCAL` semantics via set_config(..., is_local=true)) and then runs the
 * query on the SAME connection — the only pooling-safe way to bind a session variable to a query.
 * Operations on non-RLS models run directly (no extra round-trip). With no tenancy context the GUC
 * is left empty, so the policies match no rows: fail closed.
 */
function createClient(url?: string) {
  const base = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, args, query }) {
          if (!RLS_MODELS.has(model)) return query(args);
          const store = tenantContext.getStore();
          const name = store?.system ? 'agentos.bypass_rls' : 'agentos.workspace_id';
          const value = store?.system ? 'on' : (store?.workspaceId ?? '');
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config(${name}, ${value}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

/** The RLS-aware client type (a Prisma client extended with the tenancy guard). */
type RlsClient = ReturnType<typeof createClient>;

let client: RlsClient | undefined;

/**
 * Lazily-instantiated singleton RLS-aware client (no connection until the first query). Typed as
 * PrismaClient for callers: the tenancy guard is a transparent runtime behavior and the extended
 * client is a functional superset of the base for every operation the app uses ($extends only drops
 * the rarely-used $on/$use hooks, which nothing here calls).
 */
export function getPrisma(): PrismaClient {
  client ??= createClient();
  return client as unknown as PrismaClient;
}

/**
 * Build a fresh RLS-aware client on an explicit connection string — used to run as the
 * least-privilege `agentos_app` role (under which RLS is actually enforced; the owner/superuser
 * bypasses it). The caller owns its lifecycle ($disconnect). Production may point the whole app
 * here by giving DATABASE_URL the restricted role's credentials.
 */
export function makeRlsClient(url: string): PrismaClient {
  return createClient(url) as unknown as PrismaClient;
}

function tenantGuc(): { name: string; value: string } {
  const store = tenantContext.getStore();
  return store?.system
    ? { name: 'agentos.bypass_rls', value: 'on' }
    : { name: 'agentos.workspace_id', value: store?.workspaceId ?? '' };
}

/**
 * Run a raw SELECT against an RLS-protected table (e.g. pgvector KNN over vector_documents) WITH
 * the tenant GUC applied in the same transaction — the model-operation extension only wraps Prisma
 * model calls, so raw SQL must bind the GUC itself or it is denied under the enforcing role.
 */
export async function tenantRawQuery<T = unknown>(query: Prisma.Sql): Promise<T[]> {
  const c = getPrisma();
  const { name, value } = tenantGuc();
  const [, rows] = await c.$transaction([
    c.$executeRaw`SELECT set_config(${name}, ${value}, true)`,
    c.$queryRaw<T[]>(query),
  ]);
  return rows;
}

/** Like tenantRawQuery, for a raw INSERT/UPDATE/DELETE. Returns the affected row count. */
export async function tenantRawExec(query: Prisma.Sql): Promise<number> {
  const c = getPrisma();
  const { name, value } = tenantGuc();
  const [, count] = await c.$transaction([
    c.$executeRaw`SELECT set_config(${name}, ${value}, true)`,
    c.$executeRaw(query),
  ]);
  return count;
}

/** Disconnect the singleton (graceful shutdown / tests). */
export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
