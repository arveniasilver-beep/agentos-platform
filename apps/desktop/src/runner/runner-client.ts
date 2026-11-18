import { z } from 'zod';

// Desktop Runner client (TICKET-7). Registers this machine's local runner with the AgentOS API and
// heartbeats it, authenticating with the device Bearer token (TICKET-5). SECURITY: this module NEVER
// persists the token — it reads it per request from a caller-provided getter backed by secure storage
// (Windows Credential Manager via Electron safeStorage). No host paths/secrets are sent on register.

export const runnerRegistrationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  deviceId: z.string(),
  status: z.string(),
});
export type RunnerRegistration = z.infer<typeof runnerRegistrationSchema>;

/** Minimal fetch shape — injected so this stays testable + free of any DOM lib dependency. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface RunnerClientOptions {
  apiBase: string;
  workspaceId: string;
  /** Device Bearer token from secure storage (never persisted by this module). null => not registered. */
  getToken: () => string | null;
  fetch: FetchLike;
}

export class DesktopRunnerClient {
  constructor(private readonly opts: RunnerClientOptions) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const token = this.opts.getToken();
    if (!token) throw new Error('No device token available — register the device (TICKET-5) first.');
    const res = await this.opts.fetch(`${this.opts.apiBase}/workspaces/${this.opts.workspaceId}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`desktop runner ${path} failed: ${res.status}`);
    return res.json();
  }

  /** Register/refresh this machine's runner. capabilities advertise what the runner can do; shellExec
   * stays false until the Phase-5 signed sidecar ships (no host command execution in this foundation). */
  async register(version: string, capabilities: Record<string, unknown>): Promise<RunnerRegistration> {
    return runnerRegistrationSchema.parse(await this.post('/desktop/runner/register', { version, capabilities }));
  }

  async heartbeat(): Promise<void> {
    await this.post('/desktop/runner/heartbeat', {});
  }
}
