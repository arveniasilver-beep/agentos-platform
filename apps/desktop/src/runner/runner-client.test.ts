import { describe, it, expect, vi } from 'vitest';
import { DesktopRunnerClient, type FetchLike } from './runner-client';

function mockFetch(ok = true, status = 200, payload: unknown = { id: 'r1', workspaceId: 'w1', deviceId: 'd1', status: 'active' }) {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => payload };
  };
  return { fetch, calls };
}

describe('DesktopRunnerClient (TICKET-7)', () => {
  it('register posts to the correct URL with the device Bearer token + capabilities', async () => {
    const { fetch, calls } = mockFetch();
    const getToken = vi.fn(() => 'aosd_TOKEN');
    const client = new DesktopRunnerClient({ apiBase: 'http://api', workspaceId: 'w1', getToken, fetch });
    const reg = await client.register('1.0.0', { localFs: true, shellExec: false });
    expect(reg).toEqual({ id: 'r1', workspaceId: 'w1', deviceId: 'd1', status: 'active' });
    expect(calls[0]!.url).toBe('http://api/workspaces/w1/desktop/runner/register');
    expect(calls[0]!.init?.headers?.authorization).toBe('Bearer aosd_TOKEN');
    expect(calls[0]!.init?.body).toContain('shellExec');
    expect(getToken).toHaveBeenCalled(); // token read per request, never persisted
  });

  it('heartbeat posts to the heartbeat endpoint', async () => {
    const { fetch, calls } = mockFetch(true, 200, {});
    const client = new DesktopRunnerClient({ apiBase: 'http://api', workspaceId: 'w1', getToken: () => 't', fetch });
    await client.heartbeat();
    expect(calls[0]!.url).toBe('http://api/workspaces/w1/desktop/runner/heartbeat');
  });

  it('throws without a token (no token => no request, fail-closed)', async () => {
    const { fetch, calls } = mockFetch();
    const client = new DesktopRunnerClient({ apiBase: 'http://api', workspaceId: 'w1', getToken: () => null, fetch });
    await expect(client.register('1', {})).rejects.toThrow(/No device token/i);
    expect(calls.length).toBe(0);
  });

  it('throws on a non-ok response', async () => {
    const { fetch } = mockFetch(false, 401);
    const client = new DesktopRunnerClient({ apiBase: 'http://api', workspaceId: 'w1', getToken: () => 't', fetch });
    await expect(client.heartbeat()).rejects.toThrow(/401/);
  });
});
