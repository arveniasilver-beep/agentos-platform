import { z } from 'zod';

/**
 * The COMPLETE allowlist of IPC channels the renderer may invoke.
 *
 * There is deliberately NO generic `invoke(channel, …)` passthrough (the single most dangerous
 * thing the Manus teardown flagged). Anything not listed here has no handler and is rejected.
 * Each channel declares Zod request/response schemas, validated in the main process.
 */
export const ipcContracts = {
  'app:getInfo': {
    request: z.void(),
    response: z.object({
      name: z.string(),
      appId: z.string(),
      protocolVersion: z.string(),
    }),
  },
  'app:ping': {
    request: z.object({ at: z.number() }),
    response: z.object({ pong: z.literal(true), at: z.number() }),
  },
  // Reachability of the AgentOS API the renderer talks to (checked from the main process, so it is
  // not constrained by the renderer CSP). Lets the UI show a clear "API offline" state.
  'app:apiStatus': {
    request: z.void(),
    response: z.object({ ok: z.boolean(), origin: z.string() }),
  },
} as const;

export type IpcContracts = typeof ipcContracts;
export type IpcChannel = keyof IpcContracts;

/** All allowlisted channel names (used by the preload bridge and the allowlist test). */
export const IPC_CHANNELS = Object.keys(ipcContracts) as IpcChannel[];

export function isAllowedChannel(channel: string): channel is IpcChannel {
  return Object.prototype.hasOwnProperty.call(ipcContracts, channel);
}

export function validateRequest<C extends IpcChannel>(channel: C, payload: unknown): unknown {
  return ipcContracts[channel].request.parse(payload);
}

export function validateResponse<C extends IpcChannel>(channel: C, payload: unknown): unknown {
  return ipcContracts[channel].response.parse(payload);
}
