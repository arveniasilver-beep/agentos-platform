import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getPrisma, disconnectPrisma } from '@agentos/db';
import { OpenAiCompatProvider, AnthropicProvider } from '@agentos/llm';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { SecretsService } from './secrets.service';
import { LlmProviderFactory } from '../tasks/llm-provider.factory';

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

suite('Chat brain provider selection (live Postgres)', () => {
  const prisma = getPrisma();
  const suffix = Date.now().toString(36);
  const secrets = new SecretsService(prisma as never, new CryptoService(), new AuditService(prisma as never));
  const factory = new LlmProviderFactory(secrets);
  const prevMode = process.env.LLM_MODE;
  const prevLocal = process.env.ALLOW_LOCAL_BRAIN_URL;
  // Allow any brain baseUrl in the test (no DNS lookup) — the SSRF guard is covered elsewhere.
  process.env.ALLOW_LOCAL_BRAIN_URL = 'true';
  let userId = '';
  let workspaceId = '';

  afterAll(async () => {
    if (prevMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = prevMode;
    if (prevLocal === undefined) delete process.env.ALLOW_LOCAL_BRAIN_URL;
    else process.env.ALLOW_LOCAL_BRAIN_URL = prevLocal;
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it('builds an OpenAI-compatible brain when configured, else falls back to Anthropic', async () => {
    process.env.LLM_MODE = 'live';
    const user = await prisma.user.create({ data: { email: `cp-${suffix}@t.local`, displayName: 'C' } });
    userId = user.id;
    const ws = await prisma.workspace.create({ data: { name: 'CP', slug: `cp-${suffix}`, ownerUserId: user.id } });
    workspaceId = ws.id;

    // No brain + no Anthropic key -> ensureConfigured fails.
    await expect(factory.ensureConfigured(ws.id)).rejects.toThrow(/No model provider/);

    // Configure an OpenAI-compatible brain (DeepSeek-shaped).
    const info = await secrets.setChatProviderConfig(ws.id, user.id, {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      inputPerMTok: 0.14,
      outputPerMTok: 0.28,
    });
    expect(info.configured).toBe(true);
    expect(info.provider).toBe('openai');

    await expect(factory.ensureConfigured(ws.id)).resolves.toBeUndefined();
    const provider = await factory.forWorkspace(ws.id);
    expect(provider).toBeInstanceOf(OpenAiCompatProvider);
    expect(provider.model).toBe('deepseek-chat');

    // The stored config decrypts server-side (key present), info never exposes the key.
    const cfg = await secrets.getChatProviderConfig(ws.id);
    expect(cfg?.apiKey).toBe('sk-test');
    expect(Object.keys(info)).not.toContain('apiKey');

    // Switch to an Anthropic brain config -> Anthropic provider.
    await secrets.setChatProviderConfig(ws.id, user.id, { provider: 'anthropic', apiKey: 'sk-ant' });
    expect(await factory.forWorkspace(ws.id)).toBeInstanceOf(AnthropicProvider);

    // Removing the brain config falls back to the legacy llm_api_key path (none here -> fails).
    await secrets.deleteChatProviderConfig(ws.id, user.id);
    await expect(factory.forWorkspace(ws.id)).rejects.toThrow(/No model provider/);

    // buildConsultable yields a one-shot-capable (ask) provider for the peer model.
    const peer = await factory.buildConsultable(ws.id, {
      provider: 'openai',
      apiKey: 'sk-peer',
      baseUrl: 'http://localhost:8000/v1',
      model: 'mimo-vl',
    });
    expect(peer.model).toBe('mimo-vl');
    expect(typeof peer.ask).toBe('function');
  });
});
