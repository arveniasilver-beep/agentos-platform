import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tenantContext } from '@agentos/db';

interface TenantRequest {
  params?: Record<string, string>;
  apiContext?: { workspaceId?: string };
}

/**
 * Establishes the per-request tenancy context that drives Postgres RLS. It runs AFTER guards (Nest
 * runs interceptors after guards), so the workspace is already resolved: from the `:workspaceId`
 * route param for the workspace-scoped API, or from `apiContext` set by the public-API key guard.
 *
 * Requests without a workspace (auth, health, the cross-workspace "list my workspaces") get NO
 * context: those routes never touch RLS-protected tables, and leaving the context empty keeps the
 * database fail-closed rather than silently bypassing RLS. HTTP only — WebSocket/queue paths set
 * their own context explicitly (the gateway per message, the worker/engine as system).
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<TenantRequest>();
    const workspaceId = req.params?.workspaceId ?? req.apiContext?.workspaceId;
    if (!workspaceId) return next.handle();
    return new Observable((subscriber) => {
      tenantContext.runWorkspace(workspaceId, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
