# AgentOS — Documentation Index

> **Status:** Planning only (no code). `AgentOS` is a placeholder codename, trivially renameable via `packages/brand`.
> **Default model:** Claude Opus (`claude-opus-4-8`) via Anthropic, behind a clean `LlmProvider` abstraction; key encrypted at rest, never in the frontend.

**Start here:** [`PLAN.md`](./PLAN.md) — the authoritative master plan and the document to approve. Reply `start` to begin Phase 0.

---

## Foundation docs (pinned — read first)

| Doc | What it covers |
|---|---|
| [`PLAN.md`](./PLAN.md) | **Authoritative master plan** — all §38 items, executive summary, decisions-needed list, approval gate |
| [`00-scope-and-phases.md`](./00-scope-and-phases.md) | Final scope, capability mapping, definite features, MVP cut, later phases, 14-phase plan, per-phase acceptance, risks, first coding step |
| [`01-stack-and-system-architecture.md`](./01-stack-and-system-architecture.md) | Tech stack + reasoning, **Electron-vs-Tauri verdict**, system architecture/topology, folder structure, rename strategy |

## Architecture sub-docs (`arch/`)

| Doc | What it covers |
|---|---|
| [`arch/agent-engine.md`](./arch/agent-engine.md) | Agent loop state machine, `TaskStatus` lifecycle, 13 engine subcomponents, tool registry/ABI, queue/worker, memory/context, Wide Research |
| [`arch/desktop-and-local.md`](./arch/desktop-and-local.md) | Desktop app, local computer/browser operators, preferred browser, permission model, `device_config`/`device_status` protocol |
| [`arch/cloud-browser.md`](./arch/cloud-browser.md) | Browser worker pool, session state machine, action set, live-view transport, takeover, safety (no CAPTCHA/2FA bypass) |
| [`arch/files-and-media.md`](./arch/files-and-media.md) | File system, artifacts + provenance/versioning, multimedia, design view, slides, data analysis, data-provider registry |
| [`arch/platform-features.md`](./arch/platform-features.md) | Projects, Skills, Collaboration, Mail-to-Task, Meetings |
| [`arch/integrations.md`](./arch/integrations.md) | Integration Center/connectors, MCP registry, no-code automations/triggers, website builder, Public API |
| [`arch/security-cost-testing.md`](./arch/security-cost-testing.md) | Risk/permission model, approval flow, envelope encryption, cost/resource control, logging, testing strategy |

## Reference drafts

| Doc | What it covers |
|---|---|
| [`DATABASE.md`](./DATABASE.md) | PostgreSQL 16 / Prisma schema — 38 tables (+`approvals`), enums, pgvector(1536) HNSW, RLS, monthly partitioning, migration approach |
| [`API.md`](./API.md) | REST `/api/v1` + WebSocket (`/chat`, `/device`) endpoint draft; auth surfaces; per-endpoint risk/scope tags |
| [`FEATURE_MATRIX.md`](./FEATURE_MATRIX.md) | 131 capability rows × 8 columns (capability, AgentOS equivalent, phase, module, test scenario, risk, dependencies, acceptance) |

## Prior research (`../_research/`)

| Doc | What it covers |
|---|---|
| [`../_research/MANUS_TEARDOWN.md`](../_research/MANUS_TEARDOWN.md) | Manus desktop client teardown — used **only** for capability mapping and architecture lessons |
| [`../_research/BUILD_BLUEPRINT.md`](../_research/BUILD_BLUEPRINT.md) | Product build blueprint |

---

## Reading order

1. **[`PLAN.md`](./PLAN.md)** — the whole picture and the approval gate.
2. **[`00-scope-and-phases.md`](./00-scope-and-phases.md)** + **[`01-stack-and-system-architecture.md`](./01-stack-and-system-architecture.md)** — the pinned decisions every sub-doc conforms to.
3. The `arch/` sub-docs for module depth; `DATABASE.md` / `API.md` for data + endpoint contracts; `FEATURE_MATRIX.md` to trace any capability → phase/module/test.

**Conventions across all docs:** MVP = Phases 0–4 (gate at end of Phase 4); Later = Phases 5–13. Every action carries a risk level (`low|medium|high|critical`); `high`/`critical` require approval; the user can stop instantly; secrets are encrypted at rest and never reach the frontend.
