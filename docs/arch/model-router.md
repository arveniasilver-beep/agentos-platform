# Model Router / Provider Abstraction (TICKET-10)

Flag-gated by `MODEL_ROUTER_ENABLED` (default false). Builds a capability/effort-based ROUTER on top of the
existing provider abstraction (`packages/llm`: `LlmProvider` + `AnthropicProvider` + `OpenAiCompatProvider`
for DeepSeek / local vLLM / MiMo / Qwen / Together, + `MockProvider`). Flag-off, the LLM factory builds the
single per-workspace brain exactly as before (byte-identical).

## What this ticket adds
- **Route config** (`model_route_config` secret, encrypted): named provider **profiles** (e.g. `fast`,
  `smart`, `vision`) — each a full `ChatProviderConfig` (its API key encrypted in the ciphertext) — plus a
  **route table** and a **fallback** chain. Authored by an admin via `PUT /workspaces/:id/settings/route`
  (`RouteProviderController`), which Zod-validates the body AND cross-checks every routed profile exists
  (a broken table is rejected at save time, not just at run time). A dedicated web settings form is a
  follow-on; the API client methods (`api.setModelRoute` / `getModelRoute` / `deleteModelRoute`) exist.
- **Deterministic selection** (`packages/llm/router.ts`, pure, no zod/network/DB): `selectProfile(cfg, {effort,
  capability})` — the first matching route rule wins (capability equality + `effortAtLeast`), else `default`,
  else the first profile. `validateRouteConfig` rejects malformed configs and any rule that references an
  unknown profile (an invalid route table never routes — it's a hard 400 at the pre-run gate).
- **RoutingProvider** (`packages/llm/routing-provider.ts`) implements `LlmProvider`, so the agent engine
  consumes it unchanged. Per request it selects a profile by `req.effort` and tries the **fallback chain** in
  order — if the chosen provider throws, the next profile answers; if all fail, it throws. The actual model
  that answered is captured in the response (and thus in `UsageRecord.model`), so routing is observable.
- **Factory wiring** (`LlmProviderFactory`): when the flag is on AND a route config is stored, `forWorkspace`
  builds every profile via the SAME `buildFromConfig` (so the OpenAI-compat **SSRF guard** + key resolution
  apply to each profile, failing fast at build time) and returns a `RoutingProvider`. Otherwise unchanged.

## Why on top of, not instead of
The provider abstraction, per-workspace config, cost/token accounting (`UsageRecord`/`CostRecord`,
`cost_estimate` events), budget enforcement, and a peer/second-brain already existed. TICKET-10 is the
selection/fallback layer they were missing — one workspace can now use a cheap model for low-effort turns,
a reasoning model for high-effort turns, and survive a provider outage via fallback.

## Security boundaries (unchanged + reaffirmed)
Profile API keys live only inside the encrypted `model_route_config` ciphertext (envelope AES-256-GCM); the
route secret has no top-level apiKey so `lastFour` is null (nothing masked leaks). Keys never cross an HTTP
boundary (server-only decrypt in the factory). Each profile's baseUrl passes the same SSRF guard as the
primary brain (`ALLOW_LOCAL_BRAIN_URL` opt-in for local model servers). The secret is RLS workspace-isolated.

## `effort` and `capability` are live signals
`task.effort` → engine `input.effort` → `req.effort` and `task.capability` (slides|document|image|chart|
chat|…) → `input.capability` → `req.capability` on every model turn — so BOTH effort- and capability-based
routing are live (not inert). Fallback is exercised independently of either.

## Out of scope (future)
A dedicated web form to author route tables (today via the `settings/route` API + client methods),
automatic effort inference from task content, per-provider rate-limit/circuit-breaker state, MoE-style
per-token routing, and provider-side cost caps beyond the existing per-task budget.
