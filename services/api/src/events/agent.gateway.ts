import { Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { tenantContext, type MemberRole } from '@agentos/db';
import { loadServerEnv } from '@agentos/config';
import { hasAtLeast } from '../rbac/roles';
import {
  clientMessageSchema,
  type AgentEvent,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@agentos/protocol';
import { AuthService, type SessionUser } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_COOKIE } from '../auth/cookie';
import { TasksService } from '../tasks/tasks.service';
import { TaskEventBus } from './task-event-bus';

interface SocketData {
  user: SessionUser;
  taskId: string;
  workspaceId: string;
  role: MemberRole;
  unsubscribe: () => void;
}
type AgentSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

type Ack = { ok: boolean; error?: string };

/** Minimal cookie-header parser (avoids a dependency just to read one value off the handshake). */
function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

// Same origin policy as the REST CORS: an explicit allowlist when CORS_ORIGINS is set, else reflect
// (dev). main.ts refuses to boot in production without CORS_ORIGINS, so reflect-mode never runs in
// prod. Avoids the cross-site WebSocket hijacking risk of an unconditional origin:true.
const GATEWAY_CORS = (() => {
  const env = loadServerEnv();
  const origin = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : true;
  return { origin, credentials: true };
})();

/**
 * Streams a task's agent events live to authenticated, authorized clients and accepts control
 * messages (stop / approve / deny). A client connects with `?taskId=<id>` and its session cookie;
 * the gateway validates workspace membership, replays the persisted backlog, then forwards live
 * events from the TaskEventBus. One socket watches one task.
 */
@WebSocketGateway({ cors: GATEWAY_CORS })
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AgentGateway.name);

  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly bus: TaskEventBus,
  ) {}

  async handleConnection(socket: AgentSocket): Promise<void> {
    try {
      const token = parseCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      const user = token ? await this.auth.resolveSession(token) : null;
      if (!user) {
        return this.reject(socket, 'unauthenticated');
      }

      const raw = socket.handshake.query.taskId;
      const taskId = Array.isArray(raw) ? raw[0] : raw;
      if (!taskId) {
        return this.reject(socket, 'missing taskId');
      }

      // Trusted server-side lookup keyed by the client-supplied taskId (the workspace isn't known
      // yet) — run it in system context so RLS doesn't deny it, mirroring the worker. The query
      // must be AWAITED inside the callback: Prisma promises are lazy, so returning one unawaited
      // would execute it after the ALS scope has exited (losing the system context).
      const task = await tenantContext.runSystem(async () => {
        const found = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { workspaceId: true },
        });
        return found;
      });
      if (!task) {
        return this.reject(socket, 'task not found');
      }
      const member = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: task.workspaceId, userId: user.id } },
      });
      if (!member) {
        return this.reject(socket, 'forbidden');
      }

      // Buffer live events until the persisted backlog has been flushed, so a late joiner gets a
      // gap-free, ordered stream. The synchronous flush section can't be interleaved by publish().
      const buffer: AgentEvent[] = [];
      let flushed = false;
      const unsubscribe = this.bus.subscribe(taskId, (event) => {
        if (flushed) socket.emit('agent_event', event);
        else buffer.push(event);
      });
      // Live browser screencast frames (transient). volatile = drop frames a slow client can't keep
      // up with instead of queueing them unbounded in the socket write buffer (backpressure safety).
      const unsubscribeFrames = this.bus.subscribeFrames(taskId, (data) =>
        socket.volatile.emit('browser_frame', data),
      );

      socket.data.user = user;
      socket.data.taskId = taskId;
      socket.data.workspaceId = task.workspaceId;
      socket.data.role = member.role;
      socket.data.unsubscribe = () => {
        unsubscribe();
        unsubscribeFrames();
      };

      try {
        const backlog = await tenantContext.runWorkspace(task.workspaceId, () =>
          this.tasks.events(task.workspaceId, taskId),
        );
        const seen = new Set<number>();
        for (const row of backlog) {
          socket.emit('agent_event', row.payload as unknown as AgentEvent);
          seen.add(row.seq);
        }
        for (const event of buffer) {
          if (!seen.has(event.seq)) socket.emit('agent_event', event);
        }
      } finally {
        flushed = true;
      }
    } catch (err) {
      this.logger.error(`connection error: ${err instanceof Error ? err.message : err}`);
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: AgentSocket): void {
    socket.data?.unsubscribe?.();
  }

  @SubscribeMessage('client_message')
  async onClientMessage(
    @ConnectedSocket() socket: AgentSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const user = socket.data?.user;
    const subscribedTaskId = socket.data?.taskId;
    const workspaceId = socket.data?.workspaceId;
    if (!user || !subscribedTaskId || !workspaceId) {
      return { ok: false, error: 'unauthenticated' };
    }
    const parsed = clientMessageSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: 'invalid message' };
    }
    const msg = parsed.data;

    // A socket only controls the task it subscribed to.
    const isControl =
      msg.type === 'stop' || msg.type === 'approve' || msg.type === 'deny' || msg.type === 'browser_input';
    if (isControl && msg.taskId !== subscribedTaskId) {
      return { ok: false, error: 'taskId mismatch' };
    }
    // Control actions need at least 'member' — viewers may watch but not stop/approve/take over (RBAC,
    // mirroring the @MinRole('member') HTTP gate).
    if (isControl && !hasAtLeast(socket.data.role, 'member')) {
      return { ok: false, error: 'forbidden' };
    }

    try {
      // Set the tenancy context for RLS (the HTTP interceptor doesn't cover WebSocket frames).
      return await tenantContext.runWorkspace(workspaceId, async (): Promise<Ack> => {
        switch (msg.type) {
          case 'stop':
            await this.tasks.stop(workspaceId, msg.taskId, user.id);
            return { ok: true };
          case 'approve':
            await this.tasks.decideApproval(workspaceId, msg.taskId, msg.approvalId, 'approve', user.id);
            return { ok: true };
          case 'deny':
            await this.tasks.decideApproval(workspaceId, msg.taskId, msg.approvalId, 'deny', user.id);
            return { ok: true };
          case 'browser_input':
            // Manual take-over of the live browser (membership already verified at connect time).
            await this.tasks.injectBrowserInput(msg.taskId, {
              kind: msg.kind,
              ...(msg.x !== undefined ? { x: msg.x } : {}),
              ...(msg.y !== undefined ? { y: msg.y } : {}),
              ...(msg.text !== undefined ? { text: msg.text } : {}),
              ...(msg.key !== undefined ? { key: msg.key } : {}),
            });
            return { ok: true };
          default:
            // submit_task carries no workspace context on the wire — create tasks over REST.
            return { ok: false, error: 'unsupported over socket; use the REST task API' };
        }
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'error' };
    }
  }

  private reject(socket: AgentSocket, reason: string): void {
    socket.emit('agent_event', {
      type: 'error',
      taskId: 'connection',
      seq: 0,
      message: reason,
      recoverable: false,
    });
    socket.disconnect(true);
  }
}
