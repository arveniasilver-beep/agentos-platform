import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma } from '@agentos/db';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { SecretsService } from '../secrets/secrets.service';
import { ConnectorsService } from './connectors.service';
import type { FetchLike, FetchResponseLike } from './github.client';

if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../../packages/db/.env']) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
      if (m?.[1]) {
        process.env.DATABASE_URL = m[1];
        break;
      }
    }
  }
}
const suite = process.env.DATABASE_URL ? describe : describe.skip;

function ok(json: unknown): FetchResponseLike {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

suite('Connectors: GitHub OAuth flow (live Postgres, stubbed GitHub)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  const secrets = new SecretsService(prisma as never, new CryptoService(), new AuditService(prisma as never));
  const service = new ConnectorsService(prisma as never, secrets, new AuditService(prisma as never));
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('/login/oauth/access_token')) return ok({ access_token: 'gho_test', scope: 'repo,read:user' });
    if (url.endsWith('/user')) return ok({ id: 1234, login: 'octocat' });
    if (url.includes('/user/repos')) return ok([{ full_name: 'octocat/hello', private: false, description: 'd' }]);
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'nf' };
  };
  service.githubOpts = { oauthBase: 'https://gh.test', apiBase: 'https://api.gh.test', fetchImpl };

  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('configures the app, runs the connect callback, exposes a GitHub API, and disconnects', async () => {
    const user = await prisma.user.create({ data: { email: `cn-${suffix}@t.local`, displayName: 'C' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'CN', slug: `cn-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;

    // Not connected yet; start requires a client config.
    expect((await service.list(ws.id))[0]).toMatchObject({ provider: 'github', connected: false, clientConfigured: false });
    await expect(service.startUrl(ws.id, user.id, 'github')).rejects.toThrow(/Configure the OAuth app/);

    // Admin sets the OAuth app credentials.
    await service.setClientConfig(ws.id, user.id, 'github', 'client-id-xyz', 'client-secret');
    const { url, nonce } = await service.startUrl(ws.id, user.id, 'github');
    expect(url).toContain('https://gh.test/login/oauth/authorize?');
    const state = new URL(url).searchParams.get('state')!;
    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();

    // A forged/invalid state is rejected (redirects to an error, no connection).
    expect(await service.handleCallback('github', 'code', 'forged.sig', nonce)).toContain('status=error');
    // A valid state with the WRONG cookie nonce is rejected (CSRF/replay binding).
    expect(await service.handleCallback('github', 'code', state, 'wrong-nonce')).toContain('status=error');
    expect(await service.githubApiFor(ws.id)).toBeNull();

    // The real signed state + matching cookie nonce completes the connection.
    const redirect = await service.handleCallback('github', 'code-123', state, nonce);
    expect(redirect).toContain('status=connected');

    const conns = await service.list(ws.id);
    expect(conns[0]).toMatchObject({ provider: 'github', connected: true, clientConfigured: true, accountLabel: 'octocat' });

    // The connected token yields a working GitHub API for the agent tools.
    const api = await service.githubApiFor(ws.id);
    expect(api).not.toBeNull();
    expect((await api!.listRepos()).repos[0]!.fullName).toBe('octocat/hello');

    // Disconnect removes the connection + secrets.
    await service.disconnect(ws.id, user.id, 'github');
    expect((await service.list(ws.id))[0]).toMatchObject({ connected: false, clientConfigured: false });
    expect(await service.githubApiFor(ws.id)).toBeNull();
  });
});
