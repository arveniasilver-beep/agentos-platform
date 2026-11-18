import { isIP } from 'node:net';
import { fetch as undiciFetch, Agent } from 'undici';
import { z } from 'zod';
import { defineTool } from '@agentos/tool-abi';
import type { RuntimeTool } from './runtime';
import { assertAllowedUrl } from './net-guard';

const MAX_REDIRECTS = 5;

/**
 * An undici dispatcher pinned to a single pre-validated IP. The SSRF guard resolves + vets the
 * hostname, then we connect to THAT exact address rather than letting the HTTP client re-resolve —
 * which closes the DNS-rebinding window (a low-TTL hostname answering with a public IP for the
 * guard's lookup and an internal IP microseconds later for the connect). The Host header / TLS SNI
 * still carry the original hostname.
 */
function pinnedDispatcher(address: string): Agent {
  const family = isIP(address); // 4 | 6
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if ((options as { all?: boolean })?.all) {
          (callback as (e: Error | null, a: { address: string; family: number }[]) => void)(null, [
            { address, family },
          ]);
        } else {
          (callback as (e: Error | null, a: string, f: number) => void)(null, address, family);
        }
      },
    },
  });
}

/** Read-only HTTP GET, SSRF-guarded. The agent uses this to fetch web/page content.
 * `allowPrivateHosts` (default false) disables the SSRF guard for trusted/local use — never set it
 * for agent-facing tools. */
export function createHttpFetchTool(opts?: { maxBytes?: number; allowPrivateHosts?: boolean }): RuntimeTool {
  const maxBytes = opts?.maxBytes ?? 100_000;
  const allowPrivate = opts?.allowPrivateHosts ?? false;
  return {
    definition: defineTool({
      id: 'http_fetch',
      name: 'http_fetch',
      description: 'HTTP GET a URL and return the text body (read-only, public hosts only).',
      inputSchema: z.object({ url: z.string().url() }),
      outputSchema: z.object({
        status: z.number(),
        contentType: z.string().nullable(),
        body: z.string(),
        truncated: z.boolean(),
      }),
      riskLevel: 'low',
      permissions: ['web.read', 'net.request'],
      timeoutMs: 20_000,
    }),
    run: async (input) => {
      const { url } = input as { url: string };
      const controller = new AbortController();
      const agents: Agent[] = [];

      // Follow redirects manually so each hop is re-validated against the SSRF guard (a public URL
      // must not be allowed to 30x-redirect into an internal address / cloud metadata endpoint),
      // and pin each hop's connection to the exact vetted IP (no rebinding).
      let current = await assertAllowedUrl(url, { allowPrivate });
      let res: Awaited<ReturnType<typeof undiciFetch>> | undefined;
      try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          const pin = current.addresses[0];
          const dispatcher = pin ? pinnedDispatcher(pin) : undefined;
          if (dispatcher) agents.push(dispatcher);
          res = await undiciFetch(current.url, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            ...(dispatcher ? { dispatcher } : {}),
          });
          const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
          if (!location) break;
          if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
          current = await assertAllowedUrl(new URL(location, current.url).toString(), { allowPrivate });
        }
        if (!res) throw new Error('no response');

        // Stream the body and stop at maxBytes so a huge/endless response can't exhaust memory.
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        let truncated = false;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              received += value.length;
              if (received >= maxBytes) {
                truncated = true;
                controller.abort();
                break;
              }
            }
          }
        }
        const body = Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
        return {
          status: res.status,
          contentType: res.headers.get('content-type'),
          body,
          truncated,
        };
      } finally {
        for (const a of agents) void a.close().catch(() => undefined);
      }
    },
  };
}
