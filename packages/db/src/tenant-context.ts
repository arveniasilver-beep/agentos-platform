import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tenancy context for the current async execution. It drives the Postgres Row-Level Security
 * GUC the Prisma client sets on every workspace-scoped query:
 *  - `workspaceId` set  → the session may touch only that workspace's rows (RLS enforced).
 *  - `system` set       → trusted background/infra work that bypasses RLS (worker, boot reaper,
 *                         schedulers, migrations, tests). Never derived from untrusted input.
 *  - neither set        → fail closed: RLS denies all workspace-scoped rows.
 */
export interface TenantStore {
  workspaceId?: string;
  system?: boolean;
}

class TenantContext {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  /**
   * Run `fn` with an explicit store; nested async work inherits it. Use on the request path.
   *
   * IMPORTANT: when scoping a single database call, pass an ASYNC callback that AWAITS the query
   * (`runX(async () => { return await prisma.x.findMany(...) })`), not a bare thunk returning the
   * lazy Prisma promise (`runX(() => prisma.x.findMany(...))`). Prisma queries don't execute until
   * awaited, and a bare thunk returns the promise so it runs AFTER this scope has exited — losing
   * the tenancy context and getting denied/bypassed. Passing an async method that awaits internally
   * (e.g. a service method) is fine; the danger is only the bare lazy promise.
   */
  run<T>(store: TenantStore, fn: () => T): T {
    return this.als.run(store, fn);
  }

  /** Run `fn` scoped to a single workspace (RLS enforced to that workspace). */
  runWorkspace<T>(workspaceId: string, fn: () => T): T {
    return this.als.run({ workspaceId }, fn);
  }

  /** Run `fn` as trusted system/background work that bypasses RLS. */
  runSystem<T>(fn: () => T): T {
    return this.als.run({ system: true }, fn);
  }

  /**
   * Set system (RLS-bypass) context for the current async execution without a callback wrapper.
   * Intended for test setup, where wrapping every test body in a callback is impractical.
   */
  enterSystem(): void {
    this.als.enterWith({ system: true });
  }

  getStore(): TenantStore | undefined {
    return this.als.getStore();
  }
}

/** Process-wide tenancy context shared by the Prisma client and the API request lifecycle. */
export const tenantContext = new TenantContext();
