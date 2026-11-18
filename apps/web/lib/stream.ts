import { io, type Socket } from 'socket.io-client';
import type { AgentEvent, ClientMessage } from '@agentos/protocol';
import { API_BASE } from './config';

export interface TaskStream {
  socket: Socket;
  /** Send a control message (stop/approve/deny); resolves with the server ack. */
  send: (message: ClientMessage) => Promise<{ ok: boolean; error?: string }>;
  close: () => void;
}

/**
 * Open a live event stream for one task. The session cookie rides the handshake (withCredentials);
 * the server replays the backlog then pushes live events. `onEvent` receives every agent event.
 */
export function openTaskStream(taskId: string, onEvent: (event: AgentEvent) => void): TaskStream {
  const socket: Socket = io(API_BASE, {
    query: { taskId },
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnection: true,
  });

  socket.on('agent_event', (event: AgentEvent) => onEvent(event));

  const send = (message: ClientMessage): Promise<{ ok: boolean; error?: string }> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
      socket.emit('client_message', message, (ack: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        resolve(ack ?? { ok: false, error: 'no ack' });
      });
    });

  return { socket, send, close: () => socket.close() };
}
