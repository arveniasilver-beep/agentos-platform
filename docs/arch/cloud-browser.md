# AgentOS — Cloud Browser & Browser-Automation Service

> **Status:** Planning only. No code. TypeScript appears solely as interface *sketches* to pin contracts.
> **Scope of this doc:** Planning §12 (Cloud Browser) + the browser tooling that the Tool Registry exposes. Owns: isolated Chromium sessions, session/cookie lifecycle, the browser action set, multi-step workflows, the **live browser view**, **user takeover**, logging/recording, and the **safety/approval** rules for risky browser actions.
> **Conforms to:** `docs/00-scope-and-phases.md` (scope, phase split, naming) and `docs/01-stack-and-system-architecture.md` (stack, topology, wire contracts). This document does **not** restate those decisions; it *uses* them.
> **Pinned upstream decisions reused verbatim:**
> - **Playwright (Chromium) runs *inside the session sandbox*, never in the desktop/web bundle** (§6.12, §7.1 svc 8).
> - **One Playwright `BrowserContext` per session** = isolation + cookies + a trace artifact (§6.12).
> - **Realtime is Socket.IO `/chat`** (token in `auth` handshake); typed events live in `packages/protocol` (§6.11, §7.6).
> - **Tools are `ToolDef`** (Zod in/out, `risk`, `surface`) in `packages/tool-abi`; high/critical gate to approval (§7.6).
> - **Sandbox = container-per-session (Docker + gVisor), behind `SandboxProvider`**; Firecracker later (§6.15, §7.1 svc 9).
> - **Hard rule: NO CAPTCHA/2FA bypass** — pause and hand off to the user (§1.4, §6.12 hard-rule note).
> - **Brand:** every literal product/scheme name comes from `packages/brand` (`BRAND.appName`, `BRAND.protocol`). Treat "AgentOS" / `agentos://` below as `BRAND.*`.
> **Codename:** AgentOS (renameable via `packages/brand`).

---

## Table of contents

1. [Where this fits & MVP-vs-Later map](#1-where-this-fits--mvp-vs-later-map)
2. [Service topology — the browser worker pool](#2-service-topology--the-browser-worker-pool)
3. [Session lifecycle & state machine](#3-session-lifecycle--state-machine)
4. [Cookie / storage-state management (save / delete)](#4-cookie--storage-state-management-save--delete)
5. [The browser action set (navigate/click/fill/extract/DOM/forms/screenshot)](#5-the-browser-action-set)
6. [Multi-step workflows](#6-multi-step-workflows)
7. [Live browser view — transport decision & justification](#7-live-browser-view--transport-decision--justification)
8. [Takeover mode](#8-takeover-mode)
9. [Safety: CAPTCHA/2FA pause, risky-action approval, fill-but-stop-before-submit](#9-safety)
10. [TypeScript interface sketches](#10-typescript-interface-sketches)
11. [Data model / tables & fields](#11-data-model--tables--fields)
12. [Folder layout](#12-folder-layout)
13. [Logging, screenshots & video recording](#13-logging-screenshots--video-recording)
14. [Failure, backpressure & resource limits](#14-failure-backpressure--resource-limits)
15. [Per-area test scenarios & acceptance criteria](#15-per-area-test-scenarios--acceptance-criteria)
16. [MVP cut summary](#16-mvp-cut-summary)

---

## 1. Where this fits & MVP-vs-Later map

The browser service is the in-sandbox engine behind the `browser.*` tools in the Tool Registry. The **Agent Engine** (in `services/worker`) never touches Playwright directly — it emits typed `tool_call`s, which the **sandbox-orchestrator** routes to a **browser worker** inside the session container. Results stream back as `tool_result` + browser-specific events over `/chat`.

Per Appendix A of the scope doc, **module 10 (Browser, cloud/headless) is Phase 2 / MVP**, and **module 12 (Cloud browser UI / Live Activity) is Phase 3 / MVP**. Takeover, VNC, and Preferred-Browser are **Phase 5 / Later** (C6, C4-VNC). This doc tags every feature accordingly.

| # | Feature | Phase | Tag |
|---|---|---|---|
| F-01 | Isolated Chromium session, one `BrowserContext` per task | P2 | **MVP** |
| F-02 | Core actions: `goto`, `click`, `fill`, `extract_text`, `read_dom`, `detect_forms`, `screenshot`, `wait_for` | P2 | **MVP** |
| F-03 | Cookie/storage-state save & delete (encrypted at rest) | P2 | **MVP** |
| F-04 | Multi-step workflow execution (engine-driven, step-by-step) | P2 | **MVP** |
| F-05 | Browser logs (console + network, redacted) persisted to event/audit log | P2 | **MVP** |
| F-06 | Per-action screenshot artifacts to `BlobStore` | P2 | **MVP** |
| F-07 | Risk classification of browser actions + approval gate | P2 | **MVP** |
| F-08 | **Fill-but-stop-before-submit** (form staged, submit gated) | P2 | **MVP** |
| F-09 | CAPTCHA/2FA/SMS **detection → pause → request takeover** (no bypass) | P2 (detect+pause) / P5 (interactive takeover) | **MVP** (pause) |
| F-10 | **Live browser view** via streamed screenshots/CDP screencast (read-only) | P3 | **MVP** |
| F-11 | Playwright **trace** artifact per session (zip, replayable) | P3 | **MVP** |
| F-12 | Browser-worker **pool** with warm browsers + idle reaping | P2 (basic) / P4 (pool tuning) | **MVP-lite** |
| F-13 | **Interactive takeover** (user drives the live browser) via VNC | P5 | Later |
| F-14 | **Video recording** (WebM) of session | P5 | Later |
| F-15 | Saved multi-step **Skills** (parameterized browser workflows) | P7 | Later |
| F-16 | **Preferred Browser** operator (drive user's local browser) | P5 | Later |
| F-17 | Per-domain egress allow/deny policy + consent | P5 | Later |
| F-18 | File upload / download via browser | P3 | MVP-lite |

---

## 2. Service topology — the browser worker pool

### 2.1 Where the browser lives

```
services/worker (Agent Engine)
        │  emits browser.* tool_call  (typed, risk-tagged)
        ▼
services/sandbox-orchestrator
        │  routes call to the session's sandbox over WS/orchestrator API
        ▼
┌──────────────────────────────────────────────────────────────────┐
│ SESSION SANDBOX  (Docker + gVisor, one per session)                │
│                                                                    │
│   ┌────────────────────────────────────────────────────────────┐  │
│   │ Browser Worker  (Node + Playwright, "browser-runner")        │  │
│   │  • owns ONE Chromium BrowserContext for this session          │  │
│   │  • executes BrowserAction → returns BrowserActionResult        │  │
│   │  • CDP screencast → frame stream (live view)                  │  │
│   │  • console + network capture (redacted)                       │  │
│   │  • trace recorder, screenshot grabber                         │  │
│   │  • Xvfb display (headful, required for VNC takeover later)     │  │
│   └───────────────┬───────────────────────────────┬──────────────┘  │
│                   │ frames + logs                  │ VNC (Phase 5)   │
└───────────────────┼───────────────────────────────┼─────────────────┘
                    │ (in-sandbox WS to orchestrator)│ (OTP-gated)
                    ▼                                ▼
        services/gateway  ──►  /chat room(sessionId)  ──►  web + desktop renderers
```

### 2.2 Pool model

- **Container-per-session is the isolation unit** (pinned, §6.15). Inside each container runs **one browser worker** that holds **one `BrowserContext`**. We do **not** multiplex tenants into one browser process — that is the isolation guarantee.
- **Warm pool (F-12, MVP-lite):** the sandbox-orchestrator keeps a small number of **pre-warmed sandboxes** with a launched-but-idle Chromium (`browser.launch()` done, no context yet) so first-action latency is low. On session assignment, the worker creates the session's `BrowserContext` from the warm browser. Cold-start fallback if the pool is empty.
- **Density knob:** pool size, max concurrent sandboxes, and per-sandbox RAM/CPU caps are orchestrator config. Idle browsers are reaped on the same idle-reap loop that reaps sandboxes (§7.8).
- **Scaling:** browser workers scale with the sandbox pool (by node). No browser-specific stateful service to scale — Postgres holds session metadata, `BlobStore` holds artifacts, Redis fans out frames/logs.

### 2.3 How a tool call reaches the browser (control flow)

1. Engine selects `browser.goto` (or any `browser.*`) → builds Zod-validated input from `tool-abi`.
2. Engine calls the orchestrator's `runTool(sessionId, call)`; orchestrator finds the session's sandbox and forwards to the browser worker over the in-sandbox WS.
3. Worker runs the Playwright action, captures a post-action screenshot + console/network deltas, returns a `BrowserActionResult`.
4. Orchestrator relays `tool_result` to the engine; the engine emits `tool_call`/`tool_result` (protocol events) → gateway → `/chat` room.
5. Live-view frames (CDP screencast) flow on a **separate, coalesced channel** (browser_frame event) so high-FPS frames never block the semantic event stream.

---

## 3. Session lifecycle & state machine

A **BrowserSession** is created lazily on the first `browser.*` tool call of a task and is **bound 1:1 to the agent Session** (same `sessionId`). It can outlive individual actions but is torn down when the task ends, on stop, or on idle.

### 3.1 States

```
            createBrowserSession()
                    │
                    ▼
   ┌─────────┐  context ready   ┌────────┐
   │ CREATING├─────────────────►│  IDLE  │◄──────────────┐
   └────┬────┘                  └───┬────┘               │ action done
        │ launch/context error      │ runAction()        │
        ▼                           ▼                     │
   ┌─────────┐                 ┌─────────┐  result        │
   │  ERROR  │◄────────────────┤  ACTING ├────────────────┘
   └─────────┘   action error  └────┬────┘
        ▲                           │ CAPTCHA/2FA detected
        │                           │ OR risky action needs approval
        │                           ▼
        │                     ┌───────────────┐  approve / takeover-grant
        │                     │  AWAITING_*    │──────────────────┐
        │                     │ (USER/APPROVAL)│                  │
        │                     └───────┬────────┘  deny / timeout  ▼
        │                             │                     back to IDLE/ACTING
        │           takeover granted  ▼
        │                     ┌───────────────┐  release()
        │                     │  TAKEOVER      │──────────► IDLE
        │                     │ (user drives)  │
        │                     └───────────────┘
        │
        └──────── stop() / idle-reap / task end ──────► ┌──────────┐
                                                        │ CLOSING  │──► CLOSED
                                                        └──────────┘
```

States: `CREATING → IDLE → ACTING → (AWAITING_APPROVAL | AWAITING_USER | TAKEOVER) → IDLE … → CLOSING → CLOSED`, with `ERROR` reachable from launch/action failures.

- **`AWAITING_APPROVAL`** — a high/critical action (e.g. form submit, payment) is staged; engine emitted an `approval_request`; the worker holds the action.
- **`AWAITING_USER`** — CAPTCHA/2FA/SMS detected; the run is paused and a takeover is *requested* from the user. In MVP this surfaces as a blocking approval-style prompt ("Human verification required — take over and continue, or abort"). Interactive control (TAKEOVER) is Phase 5.
- **`TAKEOVER`** — user is driving the live browser (Phase 5, VNC). The agent issues no actions while here.

### 3.2 Transitions & guards

| From | Event | Guard | To |
|---|---|---|---|
| CREATING | context created | — | IDLE |
| CREATING | launch error | — | ERROR |
| IDLE | `runAction(a)` | `risk(a) ∈ {low,medium}` | ACTING |
| IDLE | `runAction(a)` | `risk(a) ∈ {high,critical}` | AWAITING_APPROVAL |
| ACTING | result ok | — | IDLE |
| ACTING | CAPTCHA/2FA detected | — | AWAITING_USER |
| ACTING | error | retryable & under budget | ACTING (retry) |
| ACTING | error | not retryable | ERROR |
| AWAITING_APPROVAL | `approve` | scope valid | ACTING |
| AWAITING_APPROVAL | `deny` / timeout | — | IDLE (step abandoned) |
| AWAITING_USER | `takeover` granted | Phase 5 | TAKEOVER |
| AWAITING_USER | `approve`(continued) / `deny` | MVP | IDLE / aborted |
| TAKEOVER | `release` | — | IDLE |
| any | `stop` / idle-timeout / task-end | — | CLOSING → CLOSED |

**Instant stop (hard rule):** `stop` is checked at every step boundary *and* aborts the in-flight Playwright action via an `AbortSignal`/`page.close()`; the context is closed, the trace flushed, the session → `CLOSED`. Target: in-flight action aborts within one step boundary (≤2s), matching the platform stop budget (scope §7 / Scenario B3).

---

## 4. Cookie / storage-state management (save / delete)

**Goal:** let a task reuse a logged-in session ("stay signed in to my dashboard") without ever bypassing auth, and let the user **save** and **delete** these states explicitly. **MVP (F-03).**

- **Unit of persistence:** Playwright **`storageState`** (cookies + `localStorage`) for the context, captured via `context.storageState()`. This is the only browser credential surface we persist.
- **Classification:** a saved storage-state is **`sensitive`** data and frequently carries auth cookies → stored **envelope-encrypted** (reusing `packages/crypto`, the same path as LLM keys per §6.20). The plaintext exists only inside the sandbox at hydrate time; the cloud DB holds ciphertext + metadata.
- **Scope & ownership:** a `BrowserProfile` is owned by `(workspaceId, userId)` and optionally pinned to a domain allowlist. It is **never** auto-shared across workspaces (tenancy, §7.7).
- **Save flow:** explicit, user-initiated or agent-proposed-then-approved. Saving auth cookies is itself a **`medium`-risk** action with a "save my login for `<domain>`?" confirmation; saving over an existing profile shows a diff of domains.
- **Hydrate flow:** when a task opts into a profile, the worker creates the context with the decrypted `storageState`. The decrypt happens **in-sandbox**; the cloud passes a short-lived data key, not the plaintext.
- **Delete flow:** `deleteProfile` purges the encrypted row + any associated trace/screenshot artifacts (cascade) and emits an audit entry. **Hard-delete**, not soft — credentials must be destroyable on demand.
- **Masking:** cookie *values* are never rendered in the UI, never sent to the model, and redacted in all logs (`packages/logger`). The UI shows domains + counts only.

---

## 5. The browser action set

One Zod-typed `BrowserAction` discriminated union, authored in `packages/tool-abi`; each maps to a Playwright primitive and carries a **risk** tag. The engine sees them as discrete `ToolDef`s (`browser.goto`, `browser.click`, …) so the model picks from a typed catalog. **MVP (F-02)** unless tagged.

| Action | Playwright primitive | Risk (default) | Notes |
|---|---|---|---|
| `goto` | `page.goto(url)` | low (medium if non-allowlisted domain) | egress-policy checked first |
| `click` | `locator.click()` | low → **escalated** if target is a submit/pay/delete control (§9.3) | selector or accessible-name based |
| `fill` | `locator.fill(value)` | low; **medium** if field looks sensitive (password/card) | value masked in logs |
| `type` | `locator.pressSequentially()` | low | for inputs needing keystroke events |
| `select_option` | `locator.selectOption()` | low | |
| `extract_text` | `locator.innerText()` / `page.innerText()` | low | returns text only |
| `read_dom` | `page.content()` / structured a11y snapshot | low | size-capped, sanitized |
| `detect_forms` | a11y + DOM heuristic | low | returns form/field inventory + a `submitRisk` hint |
| `screenshot` | `page.screenshot()` | low | artifact → `BlobStore` |
| `wait_for` | `locator.waitFor()` / `waitForLoadState` | low | bounded timeout |
| `scroll` | `mouse.wheel` / `scrollIntoView` | low | |
| `press_key` | `keyboard.press()` | low; **escalated** if it triggers submit (Enter in a form) | |
| `submit_form` | explicit submit/click-submit | **high** (always) | **gated — see §9.2** |
| `download` | `page.waitForEvent('download')` | medium | artifact → `BlobStore` (F-18, MVP-lite) |
| `upload` | `setInputFiles()` | medium | only from approved sandbox/sidecar paths (F-18) |
| `eval_js` | `page.evaluate()` | **high** | off in MVP; behind a flag, gated, sanitized — arbitrary JS is high-risk |

**Selector strategy:** prefer **accessible-name / role / text** locators (`getByRole`, `getByLabel`, `getByText`) over brittle CSS/XPath, both for robustness and because they map cleanly to what the model "sees" in a `read_dom`/`detect_forms` snapshot. CSS/XPath allowed as fallback.

**`detect_forms` output** is the key safety primitive: it enumerates every form, its fields (name, type, `sensitive?`), and whether a candidate **submit control** exists — feeding the fill-but-stop-before-submit logic (§9.2).

---

## 6. Multi-step workflows

**MVP (F-04):** workflows are **engine-driven**, not a separate scripting engine. The Agent Engine's ReAct loop *is* the workflow runner: each browser step is one `tool_call`, observed, then the next is planned. This keeps one audit trail, one stop point, one risk gate per step — no hidden multi-action macro that could skip an approval.

- **Step record:** every browser action is persisted as a `BrowserActionLog` row (§11) linked to the `Step` and `Session`, with before/after screenshots, the resolved selector, console/network deltas, and the risk decision.
- **Checkpoints:** between steps the worker can snapshot `storageState` so a recoverable workflow can resume after a transient failure without redoing logins.
- **Bounded:** workflows inherit the engine's step + wall-clock + token budgets and the loop detector (§7.8). A browser workflow cannot run unbounded.
- **Saved Skills (F-15, Later/P7):** a successful browser workflow can be saved as a **parameterized Skill** (a task graph with typed inputs, e.g. `{searchTerm, maxPrice}`). Out of MVP; the per-step log format is designed so a Skill can be *derived* from a successful run later.

---

## 7. Live browser view — transport decision & justification

**Requirement:** the right-hand "Live Activity" panel must show what the agent's browser is doing, on **both web and desktop**, in near-real-time, and must support **read-only viewing in MVP** and **interactive takeover later**.

### 7.1 Options considered

| Option | How | Latency | Bandwidth | Interactive? | Complexity | Verdict |
|---|---|---|---|---|---|---|
| **A. Periodic `page.screenshot()`** | grab PNG every N ms, push as base64/URL | poor (1–4 fps) | high (full PNG each frame) | no | trivial | fallback only |
| **B. CDP `Page.startScreencast`** | Chrome DevTools Protocol streams JPEG frames on change, with ack-based backpressure | good (5–15 fps, change-driven) | moderate (delta-ish, quality-tunable) | no (view only) | low-medium | **MVP CHOICE** |
| **C. VNC (headful + Xvfb + VNC server)** | stream the whole X display; user can send input | good | higher (full-desktop pixels) | **yes** | medium-high (OTP, input plumbing, display server) | **Phase 5 (takeover)** |
| **D. WebRTC video** | encode screencast to a WebRTC track | best | lowest (real codec) | with data channel | high | Later optimization |

### 7.2 Decision

- **MVP live view (F-10): CDP `Page.startScreencast`** (Option B). It is the right tradeoff: it streams **only when the page changes** (event-driven, not a fixed-fps poller), supports **frame-ack backpressure** (the client acks each frame; we never outrun a slow client), is **quality/scale-tunable** (JPEG quality + maxWidth/maxHeight), and needs **no display server** for read-only view. Frames are emitted as a coalesced `browser_frame` event on `/chat`, on a separate logical channel from semantic events so a 10-fps frame stream never starves `tool_result`s. The orchestrator drops/merges frames under backpressure (latest-frame-wins).
- **Screenshot polling (Option A)** remains as a **degraded fallback** when screencast can't attach (e.g. a page in a state CDP won't screencast), and is what we persist as durable artifacts anyway (§13).
- **VNC (Option C) is deferred to Phase 5** because it is only needed for **interactive takeover** (the user sending mouse/keyboard into the real browser). It requires headful Chromium on Xvfb + a VNC server + OTP gating + input relay — all of which we *do* provision (the sandbox image already includes Xvfb per §6.12) but only light up when takeover ships. The teardown confirms the incumbent gates VNC behind an OTP; we mirror that (`requestVncOtp`-style, OTP-gated, short-lived).
- **WebRTC (Option D)** is a **Later** bandwidth optimization behind the same view abstraction; the renderer consumes a `LiveView` interface, so swapping screencast→WebRTC is contained.

### 7.3 Why this is correct for our architecture

The view is **read-only in MVP**, so we get the cheapest, simplest path (CDP screencast, no input plumbing, no extra display server dependency for the common case) while *reserving* the heavier VNC path for the genuinely interactive Phase-5 feature. The renderer never talks to the sandbox directly — frames traverse `gateway → /chat room`, so web and desktop are identical and the sandbox stays network-isolated (no inbound from clients).

---

## 8. Takeover mode

**Takeover (F-13) is Phase 5 / Later.** MVP ships the **pause-and-request** half (F-09): the agent stops and asks the human to take over; the *interactive control surface* lands in Phase 5.

### 8.1 MVP behavior (pause + request)

On CAPTCHA/2FA/SMS detection (§9.1) or an explicit model decision that human help is needed, the engine emits an `approval_request`-shaped **takeover request** and the session enters `AWAITING_USER`. The user sees: a clear reason, the live (read-only) frame, and two choices — **"I'll handle it"** (which, in MVP, means the user completes the step in a **separate, user-controlled** path — see note) or **Abort**. The agent does **not** proceed automatically.

> **MVP honesty note:** without VNC, the user cannot click *inside* the cloud browser yet. So in MVP, a CAPTCHA/2FA wall is a **hard stop**: the agent pauses, explains, and either (a) waits for the user to supply the needed artifact through an approved channel, or (b) aborts the task with a clear explanation. We do **not** pretend the user can drive the cloud browser before VNC exists. This is the correct, non-fake behavior.

### 8.2 Phase 5 behavior (interactive takeover)

- User clicks **Take over** → backend mints a short-lived **VNC OTP**, the renderer opens a VNC client to the session's headful Chromium (via gateway-brokered, OTP-gated tunnel). Session → `TAKEOVER`.
- **Agent is suspended** while in `TAKEOVER` (no actions issued; `TakeoverState.controller = 'user'`).
- User completes the human step (solves CAPTCHA, enters the SMS code on the real site), then clicks **Return control** → session → `IDLE`, `controller = 'agent'`, and the engine resumes from the next planned step. The storage-state now reflects the now-authenticated session.
- **Instant reclaim both ways:** the user can take over at any time (button), and can return control at any time; the agent can *request* but never *seize* control from the user.

---

## 9. Safety

This section encodes the **non-negotiable hard rules** (scope §1.4) for the browser surface.

### 9.1 CAPTCHA / SMS / 2FA → pause + request takeover (NEVER bypass) — **MVP**

- **Detection heuristics** (run after every `goto`/`click`/`submit_form` and on navigation): known CAPTCHA iframes/widgets (e.g. Turnstile/hCaptcha/reCAPTCHA containers, challenge `iframe` `src` patterns), OTP/2FA input patterns (`autocomplete="one-time-code"`, "enter the code we sent", `inputmode="numeric"` + SMS copy), and interstitial "verify you are human" text. `detect_forms` surfaces a `challengeKind` hint.
- **On detection:** session → `AWAITING_USER`; engine emits a takeover request; the run **pauses**. **No automated solving, no third-party solver integration, ever** — there is no code path that attempts it (acceptance-tested, Scenario S-09).
- **Resolution:** Phase 5 → interactive takeover; MVP → user supplies the artifact through an approved channel or the task aborts with an explanation.
- This directly satisfies scope Scenario (Phase 5) "CAPTCHA/2FA encountered → agent pauses and hands off (never bypasses)."

### 9.2 Fill-but-stop-before-submit — **MVP (F-08)**

This is the core "fill a form but STOP before submit" guarantee.

```
detect_forms ──► engine fills fields one-by-one (fill/select/type)   [risk low/medium, no submit]
        │
        ▼
form is FILLED but NOT submitted ──► engine emits approval_request
        │                            { action: "submit_form",
        │                              risk: "high",
        │                              detail: "<domain>: <field summary, values masked>",
        │                              screenshot: <pre-submit shot> }
        ▼
session → AWAITING_APPROVAL  (worker holds; the submit_form action is staged, not run)
        │
   approve ──► worker executes submit_form ──► tool_result + post-submit screenshot
   deny    ──► submit discarded; fields may be cleared; step abandoned; audited
```

- **The worker physically separates fill from submit.** `fill`/`type`/`select_option` are their own actions; **submitting is a *distinct* `submit_form` action that is always `high` risk and always gated.** There is no "fill and submit" compound action. Pressing Enter in a single-field form that would submit is detected and escalated to the same gate (§5, `press_key`).
- The approval card shows a **pre-submit screenshot** + a **field summary with sensitive values masked** (passwords/cards shown as `••••`), so the user approves with full context but no secret leakage.
- On `deny`, nothing is submitted; on `approve`, only then does the network POST happen.

### 9.3 Risky-action approval matrix — **MVP (F-07)**

Risk is assigned by a classifier in the engine (reusing the platform risk-gate, §7.2/§7.6) using the action type **and** target signals (URL, accessible name, surrounding text).

| Browser situation | Risk | Gate |
|---|---|---|
| Read/extract/screenshot/navigate (allowlisted domain) | low | auto |
| Navigate to non-allowlisted domain | medium | auto (logged) |
| Fill non-sensitive field | low | auto |
| Fill sensitive field (password/card/SSN-like) | medium | auto, value masked |
| **Any form submit / "Continue"/"Pay"/"Confirm" click** | **high** | **approval** |
| **Payment / checkout / banking** action | **critical** | **approval (explicit)** |
| **Account deletion / "delete my account"** | **critical** | **approval** |
| **Send email / post message / social post / publish** | **high** | **approval** |
| Logout / clear data on a site | medium | auto (logged) |
| `eval_js` (arbitrary JS) | high | approval (off by default in MVP) |
| File download | medium | auto (artifact audited) |
| File upload | medium | approval if from outside sandbox scope |

- **high/critical → blocked pending explicit user approval** over `/chat` (`approve`/`deny`) — same mechanism as the platform-wide risk-gate; no browser-specific approval channel.
- Target-keyword detection (pay/checkout/delete/confirm/send/publish) escalates an otherwise-`click` to high/critical even if the model labeled it low.
- **Every approval decision is audited** (who, when, what, screenshot ref).

### 9.4 Egress & ToS — **MVP baseline, P5 full**

- Network interception (Playwright route handlers, §6.12) enforces an **egress policy** and **redacts** sensitive request/response data before logging.
- **No CAPTCHA-solver, no 2FA-bypass tooling ships** — not as a flag, not as a dependency.
- Per-domain allow/deny consent (F-17) and `robots`/ToS-respecting crawling posture are **Phase 5** (with the Preferred-Browser per-domain consent model).

---

## 10. TypeScript interface sketches

> Sketches only — they pin contracts, not implementation. Backed by Zod in `packages/tool-abi` / `packages/protocol`. `RiskLevel`, `ScopeGrant`, `ArtifactRef`, `ToolDef`, the `/chat` event maps, and `TaskStatus` are **imported from the existing shared packages** (§7.6) — reused, not redefined.

```typescript
import type { RiskLevel, ScopeGrant, ArtifactRef } from '@agentos/protocol'; // brand-aliased pkg

// ── BrowserSession ────────────────────────────────────────────────────────────
type BrowserSessionState =
  | 'creating' | 'idle' | 'acting'
  | 'awaiting_approval' | 'awaiting_user' | 'takeover'
  | 'closing' | 'closed' | 'error';

interface BrowserSession {
  id: string;                       // == agent sessionId (1:1)
  workspaceId: string;
  userId: string;
  sandboxId: string;                // owning session sandbox
  state: BrowserSessionState;
  profileId: string | null;         // hydrated BrowserProfile (storageState), if any
  currentUrl: string | null;
  viewport: { width: number; height: number };
  headful: boolean;                 // true once VNC/takeover is needed (P5)
  liveView: {
    mode: 'screencast' | 'screenshot-poll' | 'vnc' | 'off';
    fps: number;                    // target; coalesced under backpressure
  };
  egressPolicy: { allow: string[]; deny: string[] }; // domain globs
  createdAt: string;
  lastActivityAt: string;           // drives idle reaping
  closedReason?: 'task_end' | 'stop' | 'idle' | 'error';
}

// ── BrowserAction (discriminated union; one per ToolDef in tool-abi) ────────────
type BrowserActionInput =
  | { kind: 'goto'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { kind: 'click'; target: Selector; intent?: ClickIntent }
  | { kind: 'fill'; target: Selector; value: string; sensitive?: boolean }
  | { kind: 'type'; target: Selector; text: string; sensitive?: boolean }
  | { kind: 'select_option'; target: Selector; value: string | string[] }
  | { kind: 'press_key'; key: string }
  | { kind: 'extract_text'; target?: Selector }
  | { kind: 'read_dom'; maxChars?: number; mode?: 'html' | 'a11y' }
  | { kind: 'detect_forms' }
  | { kind: 'screenshot'; fullPage?: boolean }
  | { kind: 'scroll'; target?: Selector; dy?: number }
  | { kind: 'wait_for'; target?: Selector; state?: 'visible' | 'attached' | 'hidden'; timeoutMs?: number }
  | { kind: 'submit_form'; formRef: string }          // ALWAYS high-risk, always gated (§9.2)
  | { kind: 'download'; target: Selector }
  | { kind: 'upload'; target: Selector; sourcePath: string } // sandbox/sidecar-scoped path only
  | { kind: 'eval_js'; expression: string };          // high-risk, off by default in MVP

type Selector =
  | { by: 'role'; role: string; name?: string }
  | { by: 'label'; text: string }
  | { by: 'text'; text: string }
  | { by: 'css'; value: string }
  | { by: 'xpath'; value: string };

type ClickIntent = 'navigate' | 'expand' | 'submit' | 'pay' | 'delete' | 'send' | 'unknown';

interface BrowserAction {
  sessionId: string;
  callId: string;                   // correlates to tool_call/tool_result (protocol)
  input: BrowserActionInput;
  risk: RiskLevel;                  // classifier output; submit/pay/delete/send escalated
  requiresApproval: boolean;        // true ⇒ staged, not executed, until approve
}

interface BrowserActionResult {
  callId: string;
  ok: boolean;
  state: BrowserSessionState;       // post-action state
  url: string | null;
  text?: string;                    // for extract_text/read_dom
  forms?: DetectedForm[];           // for detect_forms
  screenshotArtifact?: ArtifactRef; // post-action shot in BlobStore
  challenge?: { kind: 'captcha' | 'sms_2fa' | 'totp_2fa' | 'unknown' }; // → AWAITING_USER
  consoleDelta?: BrowserLogLine[];  // redacted
  networkDelta?: BrowserNetLine[];  // redacted
  error?: { code: string; message: string; retryable: boolean };
}

interface DetectedForm {
  formRef: string;
  action: string | null;            // form action URL (for risk context)
  fields: { name: string; type: string; sensitive: boolean; filled: boolean }[];
  submitControl: { present: boolean; selector?: Selector; submitRisk: RiskLevel };
  challengeKind?: 'captcha' | 'sms_2fa' | 'totp_2fa';
}

// ── TakeoverState ──────────────────────────────────────────────────────────────
interface TakeoverState {
  sessionId: string;
  controller: 'agent' | 'user';
  reason: 'captcha' | 'sms_2fa' | 'totp_2fa' | 'user_initiated' | 'agent_requested' | null;
  vnc?: {                           // Phase 5 only
    available: boolean;
    otpIssuedAt?: string;
    otpExpiresAt?: string;          // short-lived, single-use
    connected: boolean;
  };
  requestedAt?: string;
  grantedAt?: string;
  releasedAt?: string;
}

// ── Browser-specific protocol events (extend ServerToClientEvents, §7.6) ─────────
interface BrowserServerEvents {
  browser_frame:    (e: { sessionId: string; seq: number; jpegB64: string; w: number; h: number }) => void; // coalesced live view
  browser_state:    (e: { sessionId: string; state: BrowserSessionState; url: string | null }) => void;
  browser_log:      (e: { sessionId: string; line: BrowserLogLine }) => void;       // redacted console/network
  takeover_request: (e: { sessionId: string; reason: TakeoverState['reason']; screenshot: ArtifactRef }) => void;
  takeover_state:   (e: TakeoverState) => void;
}
interface BrowserClientEvents {
  frame_ack: (e: { sessionId: string; seq: number }) => void;   // backpressure for screencast
  takeover:  (e: { sessionId: string }) => void;                // request control (P5)
  release:   (e: { sessionId: string }) => void;                // return control (P5)
}

// ── ToolDef wiring (each browser action is a ToolDef in tool-abi, §7.6) ──────────
// browser.goto, browser.click, browser.fill, browser.extract_text, browser.read_dom,
// browser.detect_forms, browser.screenshot, browser.submit_form (risk:'high'), ...
// surface: 'cloud'; execute() forwards to the in-sandbox browser worker.

// ── BrowserProfile (saved cookie/storage state) ─────────────────────────────────
interface BrowserProfile {
  id: string;
  workspaceId: string;
  userId: string;
  label: string;                    // user-facing, e.g. "My dashboard login"
  domains: string[];                // domains the storageState covers (no values shown)
  storageStateEncrypted: Uint8Array;// envelope-encrypted Playwright storageState
  createdAt: string;
  lastUsedAt: string | null;
}
```

---

## 11. Data model / tables & fields

New/extended Postgres tables (Prisma, `packages/db`). All carry `workspace_id` for tenancy (RLS backstop, §7.7). Times are `timestamptz`.

### `browser_session`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | == agent `session_id` |
| `workspace_id` | uuid FK | tenancy |
| `user_id` | uuid FK | |
| `sandbox_id` | uuid FK | owning sandbox |
| `state` | enum | `creating|idle|acting|awaiting_approval|awaiting_user|takeover|closing|closed|error` |
| `profile_id` | uuid FK null | hydrated `browser_profile` |
| `current_url` | text null | |
| `live_view_mode` | enum | `screencast|screenshot-poll|vnc|off` |
| `headful` | bool | |
| `egress_allow` / `egress_deny` | text[] | domain globs |
| `created_at` / `last_activity_at` / `closed_at` | timestamptz | idle-reap uses `last_activity_at` |
| `closed_reason` | enum null | `task_end|stop|idle|error` |

### `browser_action_log` (append-only; one row per action)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `session_id` | uuid FK | |
| `step_id` | uuid FK | links to agent `step` |
| `call_id` | text | correlates tool_call/tool_result |
| `kind` | text | action kind |
| `risk` | enum | `low|medium|high|critical` |
| `required_approval` | bool | |
| `approval_id` | uuid FK null | links to platform `approval` row |
| `approval_decision` | enum null | `approved|denied|timeout` |
| `target_selector` | jsonb | resolved selector (redacted of values) |
| `url` | text null | |
| `ok` | bool | |
| `error_code` | text null | |
| `screenshot_before` / `screenshot_after` | text null | `BlobStore` keys |
| `console_redacted` / `network_redacted` | jsonb | redacted deltas |
| `created_at` | timestamptz | |

### `browser_profile` (saved storage-state)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` / `user_id` | uuid FK | owner |
| `label` | text | user-facing |
| `domains` | text[] | covered domains (no cookie values) |
| `storage_state_ciphertext` | bytea | envelope-encrypted (`crypto`) |
| `data_key_wrapped` | bytea | wrapped per-row key (KMS) |
| `created_at` / `last_used_at` | timestamptz | |

> Hard-delete on `deleteProfile` cascades any artifacts; emits audit. Trace/video artifacts live in `BlobStore`, referenced from `browser_session`/`browser_action_log`, not in Postgres.

---

## 12. Folder layout

Browser code lives where the pinned layout (§34) puts it: tools in `packages/tool-abi`, the in-sandbox runner in the sandbox image / a dedicated package consumed by the sandbox, orchestration in `services/sandbox-orchestrator`.

```
packages/
  tool-abi/
    src/tools/browser/
      index.ts             # registers browser.* ToolDefs (Zod in/out, risk tags)
      actions.ts           # BrowserActionInput union + per-action ToolDef
      risk.ts              # classifyBrowserRisk(action, target) → RiskLevel
      detect.ts            # captcha/2FA/sensitive-field heuristics (shared schema)
  browser-runner/          # the in-sandbox worker (bundled into the sandbox image)
    src/
      worker.ts            # WS server inside sandbox; runAction() dispatch
      context.ts           # per-session BrowserContext lifecycle, storageState hydrate
      screencast.ts        # CDP Page.startScreencast → coalesced frame stream
      logs.ts              # console + network capture + redaction
      trace.ts             # Playwright trace start/stop/flush
      profile.ts           # save/hydrate storageState (in-sandbox decrypt)
    test/                  # cargo-equivalent: vitest + Playwright fixtures
services/
  sandbox-orchestrator/
    src/browser/
      route.ts             # engine tool_call → session sandbox → browser-runner
      live-view.ts         # frame fan-out to gateway /chat (backpressure, latest-wins)
      vnc.ts               # Phase 5: OTP mint + VNC tunnel broker
infra/docker/
  sandbox-runner.Dockerfile # adds Chromium + Playwright + Xvfb (for P5 headful/VNC)
```

> The **desktop and web bundles contain none of this** — Playwright and the runner live only in the sandbox image (reinforces §6.12/§6.13).

---

## 13. Logging, screenshots & video recording

- **Per-action screenshots (F-06, MVP):** before/after PNG to `BlobStore` (presigned), keyed in `browser_action_log`. These are the durable audit artifacts and the fallback live-view source.
- **Console + network logs (F-05, MVP):** captured via Playwright listeners, **redacted** at the boundary (`packages/logger`) — auth headers, cookies, tokens, and sensitive field values masked — then persisted as `console_redacted`/`network_redacted` deltas per action. Surfaced in the Live Activity "logs" tab.
- **Playwright trace (F-11, P3):** `context.tracing.start({ screenshots, snapshots, sources })`; on session close, the trace zip is flushed to `BlobStore` and linked to the session. This powers deterministic **replay** (scope §Phase 3) of the browser portion and is the richest debugging artifact.
- **Video (F-14, Later/P5):** Playwright `recordVideo` (WebM) per context, off by default (cost/privacy), on when the workspace opts in. Stored in `BlobStore`, masked in shared replays.
- **Masking everywhere:** no cookie/token/sensitive value reaches the UI, the model, logs, traces, or shared replays (hard rule §1.4; tested S-12).

---

## 14. Failure, backpressure & resource limits

- **Live-view backpressure:** CDP screencast is **frame-acked**; the orchestrator keeps only the latest unacked frame per session (latest-wins), so a slow client degrades fps, never queues unboundedly. Semantic events (`tool_result`) are on a separate channel and are never dropped.
- **Action timeouts:** every action has a bounded Playwright timeout; a hung page → `error{retryable}`; the engine retries with backoff or replans (platform error-recovery, scope §3).
- **Idle reaping:** `last_activity_at` drives the same idle-reap loop as sandboxes; an idle browser session → `CLOSING` → context closed, trace flushed.
- **Stop:** client `stop` aborts the in-flight action (`AbortSignal`/`page.close()`), closes the context, flushes the trace, marks `CLOSED` — within one step boundary (≤2s).
- **Resource caps:** per-sandbox RAM/CPU caps (orchestrator); one context per session bounds memory; `read_dom`/`extract_text` size-capped to protect the model context and the DB.
- **Crash recovery:** a crashed browser worker → session `ERROR`; the engine can recreate the browser session (re-hydrating `storageState` from the last checkpoint) and resume, since Postgres holds the authoritative step log.

---

## 15. Per-area test scenarios & acceptance criteria

> All inherit the global gate (scope §7): passing unit + integration tests, no placeholders in core paths, no secrets in any client bundle. E2E via Playwright Test against a local site fixture in Testcontainers.

### Sessions & isolation (F-01, F-12)
- **S-01 — one context per session.** Two concurrent sessions set a cookie on the same fixture domain.
  **Accept:** neither sees the other's cookie (separate `BrowserContext`); separate sandboxes; no shared state.
- **S-02 — lifecycle.** Create → act → idle → reap.
  **Accept:** states transition per §3; idle session is closed by the reaper; trace is flushed on close.
- **S-03 — warm pool latency.** With a warm pool, measure first-`goto` latency vs cold.
  **Accept:** warm path is materially faster; cold fallback still succeeds when pool is empty.

### Action set (F-02)
- **S-04 — core actions.** `goto` a fixture, `detect_forms`, `fill`, `extract_text`, `screenshot`.
  **Accept:** each returns a typed `BrowserActionResult`; screenshot lands in `BlobStore`; `extract_text` returns expected text; selectors resolve by role/label first.
- **S-05 — read_dom cap.** `read_dom` on a huge page.
  **Accept:** output is size-capped and sanitized; no unbounded payload to the model/DB.

### Cookie/profile (F-03)
- **S-06 — save & hydrate.** Save a `storageState` profile (medium-risk confirm), start a new session with it.
  **Accept:** the new session is recognized as logged-in on the fixture; cookie *values* never appear in UI/logs; stored row is ciphertext (DB dump shows no plaintext).
- **S-07 — delete.** `deleteProfile`.
  **Accept:** row hard-deleted, artifacts cascaded, audit row written; subsequent hydrate fails cleanly.

### Multi-step (F-04)
- **S-08 — engine-driven workflow.** A 4-step browser task (search → open → read → screenshot).
  **Accept:** each step is one `tool_call` with its own log row + risk decision; `stop` mid-workflow halts within one step boundary.

### Safety — CAPTCHA/2FA (F-09) ← hard rule
- **S-09 — no bypass.** Fixture serves a CAPTCHA widget; agent navigates into it.
  **Accept:** session → `AWAITING_USER`; `takeover_request` emitted; run pauses; **grep proves no solver dependency or solving code path exists**; agent never submits the challenge.
- **S-10 — 2FA/SMS detection.** Fixture shows an `autocomplete="one-time-code"` field.
  **Accept:** detected as `sms_2fa`; pause + request; no auto-fill of the code.

### Safety — fill-but-stop-before-submit (F-08) ← core guarantee
- **S-11 — staged submit.** Agent fills a login/checkout form on a fixture.
  **Accept:** fields are filled; **no network POST occurs**; an `approval_request` (risk `high`) with a pre-submit screenshot + masked field summary is emitted; on `deny` nothing submits; on `approve` exactly one submit POST fires; both outcomes audited. Pressing Enter to submit is caught by the same gate.

### Safety — risk matrix & masking (F-07)
- **S-12 — risk escalation.** Agent attempts a "Pay" button click and an "delete my account" click.
  **Accept:** both classified `critical`, blocked pending explicit approval; keyword escalation overrides a model-supplied low label.
- **S-13 — masking.** Seed a password + card value into a fill.
  **Accept:** values masked in UI, logs, trace, and the approval card; only `••••` shown.

### Live view (F-10)
- **S-14 — screencast stream.** Subscribe to `/chat`; agent navigates.
  **Accept:** `browser_frame` events arrive; `frame_ack` backpressure caps unacked frames to one (latest-wins); semantic `tool_result`s are never starved by frames.
- **S-15 — fallback.** Force screencast attach failure.
  **Accept:** falls back to screenshot-poll; view still updates (lower fps); no crash.

### Takeover (F-13, Phase 5)
- **S-16 — interactive takeover.** User takes over a paused session, solves the human step, returns control.
  **Accept:** VNC OTP is short-lived/single-use; agent issues zero actions while `controller==='user'`; on release the agent resumes from the next step; user can reclaim/return instantly.

### Logging/recording (F-05, F-06, F-11)
- **S-17 — trace replay.** Finish a browser task; open the trace.
  **Accept:** trace zip in `BlobStore`; replay reproduces the browser steps deterministically; redacted logs contain no tokens/cookies.

### Stop & resilience (F, §14)
- **S-18 — instant stop.** `stop` during an in-flight `goto`.
  **Accept:** action aborts within one step boundary (≤2s); context closed; trace flushed; session `CLOSED`; audit records the stop; no orphaned browser process.
- **S-19 — crash recovery.** Kill the browser worker mid-task.
  **Accept:** session → `ERROR`; engine recreates the session, re-hydrates `storageState` from checkpoint, resumes from the step log; no duplicate side-effects.

---

## 16. MVP cut summary

**In (Phase 2–3):** isolated one-context-per-session Chromium; the core action set (`goto/click/fill/type/select/extract_text/read_dom/detect_forms/screenshot/wait_for/scroll/press_key/submit_form`); encrypted cookie/storage-state save & delete; engine-driven multi-step workflows; redacted console/network logs + per-action screenshots + Playwright trace; **read-only live view via CDP screencast** (screenshot-poll fallback); the **risk matrix + approval gate**; **fill-but-stop-before-submit**; **CAPTCHA/2FA/SMS detection → pause + request takeover (no bypass)**; instant stop; idle reaping; basic warm pool; download/upload (MVP-lite).

**Out (Phase 5+ / Later):** interactive VNC takeover (the user-drives-the-cloud-browser half); video recording; saved parameterized browser Skills; Preferred-Browser operator (driving the user's *local* browser); per-domain consent/egress policy depth; WebRTC view optimization; pool density tuning at scale.

**Hard rules honored throughout:** no CAPTCHA/2FA bypass (pause + hand off, no solver code path); every browser action risk-tagged with high/critical gated to explicit approval; user can stop instantly; sensitive values (cookies, passwords, cards, tokens) masked in UI, logs, traces, model prompts, and shared replays; secrets never reach the renderer; storage-state encrypted at rest. No fake endpoints, no placeholder actions — every action maps to a real Playwright primitive and a real log/audit row.
