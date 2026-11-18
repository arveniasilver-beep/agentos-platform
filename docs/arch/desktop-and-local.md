# AgentOS — Desktop App & Local Operators (Sections 8–11)

> **Status:** Planning only. No code in this document — TypeScript appears solely as interface *sketches* to pin contracts; Rust appears solely to pin the sidecar surface.
> **Scope of this doc:** Sections **8 (Desktop App Architecture)**, **9 (Local Computer Operator)**, **10 (Local Browser Operator)**, **11 (Preferred Browser)** of the AgentOS planning set.
> **Owner:** Desktop & Local-Operator Architect.
> **Conforms to (do not contradict):** `docs/00-scope-and-phases.md` (scope, phase split, MVP cut), `docs/01-stack-and-system-architecture.md` (stack §6, topology §7, layout §34). **Companion research:** `_research/MANUS_TEARDOWN.md`, `_research/BUILD_BLUEPRINT.md`.
> **Brand handling:** every literal "AgentOS", `agentos://`, `com.agentos.desktop` below is `BRAND.appName` / `BRAND.protocol` / `BRAND.appId` from `packages/brand` (per §34.6). Treat them as substituted constants, never hard-coded.

---

## Table of Contents

- [0. Conformance map & cross-cutting principles](#0-conformance-map--cross-cutting-principles)
- [8. Desktop App Architecture](#8-desktop-app-architecture)
  - [8.1 Window & process model](#81-window--process-model)
  - [8.2 Secure preload & IPC bridge surface](#82-secure-preload--ipc-bridge-surface)
  - [8.3 PKCE deep-link login](#83-pkce-deep-link-login)
  - [8.4 Core desktop user flows](#84-core-desktop-user-flows)
  - [8.5 Sidecar supervisor (desktop ⇆ sidecar)](#85-sidecar-supervisor-desktop--sidecar)
  - [8.6 Instant STOP across the desktop](#86-instant-stop-across-the-desktop)
  - [8.7 Logs, task history & local store](#87-logs-task-history--local-store)
  - [8.8 Auto-update, packaging & build](#88-auto-update-packaging--build)
  - [8.9 Desktop folder layout](#89-desktop-folder-layout)
  - [8.10 Test scenarios & acceptance criteria — Desktop](#810-test-scenarios--acceptance-criteria--desktop)
- [9. Local Computer Operator](#9-local-computer-operator)
  - [9.1 Approved-folder model & OS-level enforcement](#91-approved-folder-model--os-level-enforcement)
  - [9.2 File operations surface](#92-file-operations-surface)
  - [9.3 Terminal execution & risk classification](#93-terminal-execution--risk-classification)
  - [9.4 Opening local apps & codebase edit](#94-opening-local-apps--codebase-edit)
  - [9.5 Secret masking & dangerous-command blocklist](#95-secret-masking--dangerous-command-blocklist)
  - [9.6 Operation log](#96-operation-log)
  - [9.7 Sidecar Rust crate layout](#97-sidecar-rust-crate-layout)
  - [9.8 Test scenarios & acceptance criteria — Local Computer](#98-test-scenarios--acceptance-criteria--local-computer)
- [10. Local Browser Operator](#10-local-browser-operator)
  - [10.1 Modes: read-only / assisted / autonomous](#101-modes-read-only--assisted--autonomous)
  - [10.2 Capabilities & permission gating](#102-capabilities--permission-gating)
  - [10.3 Logged-in session use & no-exfiltration](#103-logged-in-session-use--no-exfiltration)
  - [10.4 CAPTCHA/2FA hand-off (hard rule)](#104-captcha2fa-hand-off-hard-rule)
  - [10.5 Browser-operator state machine](#105-browser-operator-state-machine)
  - [10.6 Test scenarios & acceptance criteria — Local Browser](#106-test-scenarios--acceptance-criteria--local-browser)
- [11. Preferred Browser](#11-preferred-browser)
  - [11.1 Selection & profile preservation](#111-selection--profile-preservation)
  - [11.2 Remote task requesting preferred-browser execution](#112-remote-task-requesting-preferred-browser-execution)
  - [11.3 Offline fallback](#113-offline-fallback)
  - [11.4 Device registry UI](#114-device-registry-ui)
  - [11.5 Dedicated-workstation scenario](#115-dedicated-workstation-scenario)
  - [11.6 Test scenarios & acceptance criteria — Preferred Browser](#116-test-scenarios--acceptance-criteria--preferred-browser)
- [12. Permission / approval model (cross-cutting surface)](#12-permission--approval-model-cross-cutting-surface)
- [13. Local Operator protocol — desktop ⇆ backend ⇆ sidecar](#13-local-operator-protocol--desktop--backend--sidecar)
- [14. Phase & MVP tag rollup](#14-phase--mvp-tag-rollup)

---

## 0. Conformance map & cross-cutting principles

This document owns the **desktop shell** (`apps/desktop`) and the three **local operators** (computer, browser, preferred-browser) that the shell supervises. It consumes — and never re-decides — the following pinned decisions:

| Pinned decision (source) | Used here as |
|---|---|
| **Electron** hardened shell (§6.13) | `apps/desktop` runtime; window/process model in §8.1 |
| **Rust** static-binary sidecar, codesigned + hash-pinned (§6.14) | Local Computer Operator binary (§9); supervised by §8.5 |
| **Next.js static export over `app://` + per-request CSP nonce** (§6.3, §6.13 #5) | the renderer the desktop hosts (§8.1) |
| **Named, typed, Zod-validated IPC allowlist; no generic `invoke` passthrough** (§6.13 #2) | preload/IPC surface (§8.2), contract in `packages/desktop-ipc` |
| **PKCE deep-link auth** `agentos://?code=` exchanged over HTTPS (§6.18) | desktop login (§8.3) |
| **Socket.IO `/device` namespace, token in `auth` handshake, typed contracts** (§6.11, §7.6) | sidecar control plane (§8.5, §13) |
| **`device_config` (desired) / `device_status` (actual) declarative reconcile** (§7.6) | supervisor reconciler (§8.5), extended in §13 |
| **Risk levels `low|medium|high|critical`; high/critical gate to approval; instant stop** (§1.4) | classifier & approval surface (§9.3, §12) |
| **Envelope encryption; no secrets in renderer; redaction at logging boundary** (§6.20, §7.7) | secret masking (§9.5), local store (§8.7) |
| **`SQLite` desktop store in `userData`** (§6.16) | local index/audit ledger (§8.7) |
| **Playwright/Chromium lives server-side, NOT in the desktop bundle** (§6.12) | the desktop never bundles Playwright; the **Preferred Browser** drives the user's *own* Chrome/Edge via CDP, see §11 |
| **StepTimerHelper backoff `[1,2,5,10,20,30,60,120,180,240,300]s`; epoch-guarded serialized op queue** (§7.8) | reconnect/reconcile robustness (§8.5, §13) |
| **MVP ends at Phase 4** (read-only local files); full local power + preferred browser = Phase 5 (§4–§6) | every feature carries the same MVP/Later tag |

### 0.1 Five cross-cutting principles for this layer

1. **The desktop is a thin renderer + a local supervisor — never the data path.** Mirroring the teardown: the Electron app spawns/verifies/reconciles the sidecar but does **not** sit in the byte path of file or shell operations. The sidecar dials the cloud session WS directly (cloud-tool mode) or operates the disk directly (local-first mode). This keeps the high-frequency I/O off the UI process and shrinks what a compromised renderer can reach.
2. **Cloud supervision is a live kill switch.** The agent has local power *only while cloud `/device` supervision is live*. Losing `/device` resets every sidecar (epoch-bumped), per §7.8. This is a deliberate safety property, not a bug.
3. **Default-deny, scope-explicit.** No folder is reachable unless the user added it to the approved set; no write occurs in a read-only scope; no shell runs without per-action approval at MVP-completion+1 (Phase 5). Every grant is revocable and audited.
4. **Two enforcement layers, never one.** A path/command is checked *both* by the backend risk-gate (server trust zone) *and* by the sidecar itself (OS-level, canonicalized). Neither trusts the other to be the only guard.
5. **Renameable & portable.** Scheme, app-id, product name come from `packages/brand`. Window types, IPC channels, and the sidecar reconciler are OS-portable (Win first, macOS/Linux architected-for per §1.3).

---

## 8. Desktop App Architecture

**One-liner:** an Electron shell that hosts the *same* Next.js static-export SPA the web uses, adds PKCE deep-link login, a small multi-window model, a named/typed IPC allowlist, and a hardened **sidecar supervisor** — and ships signed with dual NSIS/MSIX auto-update.

### 8.1 Window & process model

**Processes (MVP, Phase 4 unless noted):**

| Process | Role | Trust | Notes |
|---|---|---|---|
| **Main** (`apps/desktop`, Node) | App lifecycle, protocol registration, window mgmt, **sidecar supervisor**, native dialogs, deep-link handling, auto-update | Privileged (Node, but holds **no LLM/OAuth secret** — those stay in backend) | Single-instance lock keyed `BRAND.appId`; funnels deep links via `second-instance` |
| **Renderer(s)** (the Next static SPA) | All UI; identical to web | Untrusted for secrets; `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` | Talks to backend over REST (cookie/bearer) + Socket.IO `/chat`; talks to main only via named IPC |
| **Preload** (per window) | Thin bridge that exposes a **frozen, typed API object** built from `packages/desktop-ipc` | Bridge only — no business logic | Runs in isolated world; `contextBridge.exposeInMainWorld` |
| **Sidecar** (`apps/sidecar`, Rust) | Local file/shell operator (§9) | High-risk, OS-jailed | Child of Main; PID-lockfile lifecycle; **not** in renderer's process tree of trust |

**Window types** (`WindowManager` singleton, keyed by type; original implementation, mirrors only the *shape* of the Manus `WindowManager`):

| Window type | Phase | Purpose |
|---|---|---|
| `main` | **MVP (P4)** | The workspace: launcher, two-pane Task view (plan + Live Activity), history, approvals, device panel |
| `child` | **MVP (P4)** | Externalized panels (e.g. a popped-out Live Activity or a doc preview) — same renderer, different route |
| `oauth` (transient) | **MVP (P4)** | Not an in-app window for the *primary* PKCE flow (that uses the system browser); reserved for connector OAuth in a sandboxed child window (Later, §6 C17) |
| `quickAsk` | **Later (P-Quick Launcher)** | Global-hotkey pill (C20) — deferred |
| `presenter` | **Later (P9)** | Multi-monitor deliverable presentation (C21) — deferred |

**Window-state & lifecycle rules (acceptance-bearing):**
- Single-instance: a second launch (incl. deep-link) routes to the existing instance via `second-instance`; never spawns a duplicate.
- Window bounds/maximized state persisted to the SQLite desktop store (§8.7); restored on next launch, clamped to a visible display.
- `before-quit` sets `isQuitting=true`; `will-quit` tears down tray/shortcuts and calls `supervisor.shutdown()` (which bumps the epoch and stops every sidecar). `window-all-closed` quits on non-darwin (Win MVP).
- `setWindowOpenHandler` **denies all** `window.open`; untrusted `will-navigate` is cancelled and the URL opened in the external browser; only `TRUSTED_ORIGINS` (our app origin + backend origin) may load (§6.13 #8).

```typescript
// apps/desktop/src/windows/window-manager.ts — interface SKETCH (not implementation)
type WindowType = 'main' | 'child' | 'oauth' | 'quickAsk' | 'presenter';

interface WindowManager {
  open(type: WindowType, opts?: { route?: string; singleton?: boolean }): WindowHandle;
  get(type: WindowType): WindowHandle | undefined;
  broadcast<E extends keyof MainToRendererEvents>(event: E, payload: MainToRendererEvents[E]): void;
  closeAll(): void;
}
// Every BrowserWindow is created with the hardened webPreferences (sandbox/contextIsolation/
// nodeIntegration/webSecurity) from a single factory — no window may opt out (asserted in test D-? below).
```

### 8.2 Secure preload & IPC bridge surface

**Rule (from §6.13 #2):** there is **no** `invoke(channel, …)` passthrough. The renderer sees a **frozen object of named methods**, each backed by a Zod-validated request/response pair declared once in `packages/desktop-ipc`. Anything not on the allowlist does not exist.

```typescript
// packages/desktop-ipc/src/contract.ts — the SINGLE source of the IPC surface (Zod-backed) — SKETCH
// Each entry: a channel name, an input schema, an output schema. Generated handlers + typed client.
export const IpcContract = {
  // --- auth / app ---
  'app.getInfo':            { in: z.void(),                       out: AppInfoSchema },          // version, deviceId, deviceName, platform
  'auth.beginLogin':        { in: z.void(),                       out: z.object({ launched: z.boolean() }) }, // opens system browser w/ PKCE
  'auth.getSessionState':   { in: z.void(),                       out: SessionStateSchema },     // logged-in? (no token ever returned)
  'auth.logout':            { in: z.void(),                       out: z.object({ ok: z.boolean() }) },

  // --- windows ---
  'window.minimize':        { in: z.void(),                       out: z.void() },
  'window.toggleMaximize':  { in: z.void(),                       out: z.object({ maximized: z.boolean() }) },
  'window.close':           { in: z.void(),                       out: z.void() },

  // --- approved folders (user-driven, native dialog) ---
  'folders.pickAndApprove': { in: z.object({ mode: z.enum(['ro','rw']) }), out: ApprovedFolderSchema }, // opens OS dir picker
  'folders.list':           { in: z.void(),                       out: z.array(ApprovedFolderSchema) },
  'folders.revoke':         { in: z.object({ folderId: z.string() }), out: z.object({ ok: z.boolean() }) },

  // --- uploads (drag-drop) ---
  'upload.stageFiles':      { in: z.object({ paths: z.array(z.string()) }), out: z.array(StagedFileSchema) },

  // --- device / sidecar status (read-only mirror for UI) ---
  'device.getStatus':       { in: z.void(),                       out: DeviceStatusSchema },

  // --- instant stop (local fast-path; also sent over /chat) ---
  'control.stopAll':        { in: z.void(),                       out: z.object({ stopped: z.boolean() }) },
  'control.stopSession':    { in: z.object({ sessionId: z.string() }), out: z.object({ stopped: z.boolean() }) },

  // --- approvals (mirrors /chat approval surface for native prompts) ---
  'approval.respond':       { in: ApprovalDecisionSchema,         out: z.object({ ok: z.boolean() }) },
} as const;

// main → renderer push events (also typed, also allowlisted)
export interface MainToRendererEvents {
  'deeplink.loginResult':  { ok: boolean; reason?: string };
  'device.statusChanged':  DeviceStatus;
  'approval.requested':    ApprovalRequest;          // native toast / in-window prompt
  'sidecar.activity':      LocalActivityEntry;       // "what it touched" live log line
  'update.available':      { version: string };
  'update.downloaded':     { version: string };
}
```

**Preload (sketch):** builds `window.agentos` by iterating `IpcContract` keys; each method wraps `ipcRenderer.invoke('<name>', payload)` *after* validating `payload` against the contract's input schema, and validates the reply against the output schema. The object is `Object.freeze`d. There is no way to reach an unlisted channel. Main registers exactly one handler per contract key, each guarded by an **auth check + per-call Zod parse**; an unknown channel has no handler and rejects.

**Secret boundary:** `auth.getSessionState` returns *whether* a session exists and basic profile, **never a token**. The renderer authenticates to the backend with an HTTP-only cookie (web parity) or a bearer obtained via the cookie/session bridge; the LLM/OAuth secrets live only in the backend trust zone (§7.7). The desktop's localStorage shim (if used for device-id/locale) is a **read-mostly** main-process JSON/SQLite, and **never** stores the LLM key (closing the teardown's "sync disk I/O + token in localStorage" smell).

### 8.3 PKCE deep-link login

Flow (MVP, P4; conforms to §6.18 and hardening #6):

1. Renderer calls `auth.beginLogin`. Main generates `code_verifier` (high-entropy, kept **in main memory only**), derives `code_challenge = S256(code_verifier)`, a `state` nonce, and opens the **system browser** at `https://<backend>/oauth/authorize?...&code_challenge=...&code_challenge_method=S256&state=...&redirect_uri=agentos://auth`.
2. User authenticates in their real browser (SSO/MFA happen there — we never see credentials).
3. Backend redirects to `agentos://auth?code=<one-time-code>&state=<state>`. The OS routes the deep link to the single instance (`second-instance`).
4. Main validates `state` against the stored nonce (CSRF guard), then **exchanges the one-time `code` over HTTPS** with the `code_verifier` → receives a session (cookie set for the `app://`/backend origin) / short-lived access + refresh. **A plaintext token never appears in the deep link** (fixes the teardown's interception risk).
5. Main emits `deeplink.loginResult{ok:true}`; the renderer transitions to the workspace. On `state` mismatch → `{ok:false, reason:'state_mismatch'}`; on exchange failure → `{ok:false, reason:'exchange_failed'}`.

**Token storage:** refresh material is stored via OS secure storage (Windows Credential Manager via Electron `safeStorage`); access tokens are short-lived and held in main memory; nothing token-bearing is exposed to the renderer or written to plain disk. On `auth.logout`, tokens are wiped and `supervisor.reinit(null)` stops all sidecars.

### 8.4 Core desktop user flows

All flows render in the **same SPA** as web; the desktop adds only the native bits (dialogs, deep-link, sidecar). Tag: **MVP (P4)** unless noted.

| Flow | Surface | Native add-on |
|---|---|---|
| **Login** | SPA auth screen → system browser | PKCE deep-link (§8.3) |
| **Create task** | Launcher / two-pane Task view (same component as web) | none (REST to backend) |
| **Task progress** | Live Activity panel streams `plan`/`tool_call`/`tool_result`/`message` over `/chat` | none |
| **Drag-drop upload** | Drop zone in Task view | `upload.stageFiles` → main reads file paths from the OS drop, presigned-uploads to BlobStore (cloud) **or** registers them as approved-scope inputs (local-first); never silently reads arbitrary disk — only the dropped paths |
| **Approved-folder selection** | Settings → "Approved folders" | `folders.pickAndApprove` opens OS dir picker; user explicitly chooses RO/RW; canonicalized + recorded |
| **Local browser operator mode** | Per-task toggle (read-only/assisted/autonomous) | §10 / §11 |
| **Local file ops** | Shown as tool calls in Live Activity | executed by sidecar under scope (§9) |
| **Terminal execution** | Shown as a risk-classified approval prompt | sidecar runs only after approval (§9.3) — **Later (P5)** for actual exec; **MVP** is the approval *scaffolding* + read-only files |
| **Instant STOP** | Always-visible Stop button + global hotkey | `control.stopAll` fast-path (§8.6) |
| **Logs & task history** | History route (server truth) + local device activity ledger | `device.getStatus`, `sidecar.activity` (§8.7) |

**MVP boundary (per §4):** at Phase 4 the desktop supports login, task create/progress, drag-drop upload, approved-folder selection, **read-only** local file read via sidecar, the approval/stop UI fully wired, logs/history, and packaging. **Local shell exec, read-write file ops, and the browser operators are Phase 5+** — but their **UI, protocol fields, and approval scaffolding ship at MVP** so the later phases are additive, not structural.

### 8.5 Sidecar supervisor (desktop ⇆ sidecar)

The supervisor is the desktop's most security-critical native module. It is an **original** reimplementation of the Manus `myComputer` reconciler shape, with the teardown's six "where it could be better" items designed in from the start.

**Responsibilities:**
1. **Integrity gate before spawn** — codesign-verify (Authenticode on Windows) **and** hash-pin the sidecar binary against a value baked into the signed app bundle. An unverified/tampered binary is **refused** (no spawn). (Closes teardown gap #3.)
2. **Spawn & supervise** — launch `sidecar` with minimal args, `PARENT_PID=<mainPid>` env (sidecar self-terminates if the app dies), `stdio` piped for the audit stream, `windowsHide:true`. Track the **exact PID in a lockfile** under `userData/sidecars/<deviceFolderId>.lock` (no kill-by-name sweeps — closes gap #4).
3. **Reconcile** — apply declarative `device_config` (desired) → emit `device_status` (actual), debounced, monotonic `configVersion`, stale versions dropped (§13).
4. **Heartbeat & health** — per-session heartbeat + health metrics surfaced in `device_status` (closes gap #5: status is no longer fire-and-forget).
5. **Lifecycle** — graceful stop `SIGTERM → SIGKILL` (Windows: `taskkill /PID <pid> /T /F` *by tracked PID*, never by name); orphan reaping via PID lockfile + `PARENT_PID`.
6. **Kill switch** — disconnect of `/device` stops all sidecars (epoch bump). `reinit(token)` on account switch; `reinit(null)` on logout.

**Concurrency (from §7.8):** an **epoch counter** + **serialized op queue** (`enqueueOperation`) make every apply/reconnect single-threaded; bumping the epoch on disconnect/shutdown cancels in-flight work so a stale timer can't resurrect a killed sidecar. Reconnect uses the staged backoff `[1,2,5,10,20,30,60,120,180,240,300]s`. `getBaseWsUrl` strips token/query so a token-only change doesn't restart a healthy sidecar.

```typescript
// apps/desktop/src/sidecar/supervisor.ts — interface SKETCH
interface SidecarSupervisor {
  reinit(token: string | null): Promise<void>;       // login/account-switch/logout
  applyConfig(cfg: DeviceConfig): Promise<void>;       // declarative desired state (debounced, version-guarded)
  status(): DeviceStatus;                              // actual state for UI + /device emit
  stopAll(reason: StopReason): Promise<void>;          // kill switch (bumps epoch)
  shutdown(): Promise<void>;                           // on will-quit
  on(event: 'activity', cb: (e: LocalActivityEntry) => void): void; // streams "what it touched"
}
interface SidecarHandle {
  deviceFolderId: string; pid: number; lockfilePath: string;
  folderPath: string; mode: 'ro' | 'rw'; allowShell: boolean;
  state: 'spawning' | 'running' | 'stopping' | 'exited';
  epoch: number;
}
```

**Verification:** the supervisor verifies the binary, then reconciles against `device_config`; an unverified binary is refused; killing the app terminates every sidecar (lockfile + PARENT_PID); dropping `/device` stops all sidecars within the epoch boundary. (Acceptance: §8.10 D-series and §9.8 E-series.)

### 8.6 Instant STOP across the desktop

The hard rule (§1.4 #5) is "stop any action instantly." Three layers, any of which halts:

1. **Renderer fast-path:** a persistent Stop button + a global hotkey call `control.stopAll` (or `control.stopSession`) over IPC. Main immediately (a) bumps the supervisor epoch and signals every sidecar to abort in-flight ops, and (b) sends `stop` over `/chat` to the backend engine.
2. **Backend kill flag:** the engine checks a kill flag between steps and aborts in-flight tool calls (§7.4 step 12). This is the authoritative stop for cloud tools.
3. **Supervision loss = implicit stop:** if `/device` drops, all sidecars reset (kill switch, §8.5).

**Bounded latency target:** local sidecar ops abort at the next syscall checkpoint (≤ ~250 ms); cloud tool aborts within one step boundary (≤ 2 s per §6 acceptance). The Stop control is **always reachable** (sticky, never behind a modal). A stop is **audited** with actor, scope, and timestamp.

### 8.7 Logs, task history & local store

**Server truth (history):** tasks, steps, events, and the audit log live in Postgres (§7.1) and are rendered identically on web and desktop via REST/`/chat` replay. The desktop adds **no** divergent history store.

**Local desktop store (SQLite in `userData`, per §6.16):** holds only device-local, non-secret state:

| Table | Purpose |
|---|---|
| `device` | `deviceId` (persisted UUID), `deviceName` (`os.hostname()`), platform, app version |
| `approved_folders` | `folderId`, canonical `path`, `mode (ro|rw)`, `allowShell`, `grantedAt`, `grantedBy`, `revokedAt?` |
| `window_state` | per-window bounds/maximized |
| `local_activity` | append-only "what it touched" ledger: `ts`, `sessionId`, `op` (read/write/list/exec/open), `path|command (masked)`, `result`, `riskLevel`, `approvalId?` — mirrors what is also sent to the server audit log; kept locally so the device can show its own activity even offline |
| `prefs` | locale, theme, telemetry opt-in |

The local ledger is the on-device half of the **dual audit** (server + device). Secrets are **never** stored here; the LLM key is never on the desktop at all. Sensitive values in `local_activity` (paths containing tokens, command args) are masked before write (§9.5).

### 8.8 Auto-update, packaging & build

Conforms to §6.13 (Electron) and C30 / Phase 12. Tag: shell scaffold **MVP (P0/P4)**; signed dual-target packaging **Later (P12)**.

- **electron-builder** dual targets: **NSIS/exe** with an `electron-updater` self-update feed (staged rollout) **and** **MSIX** for the Store (auto-update disabled, Store-managed).
- **Code-signing** pipeline for the app and the **sidecar** binary; the sidecar is **hash-pinned** in the signed bundle (§8.5 #1).
- All packaging metadata (`appId`, `productName`, protocol registration, MSIX identity) is **generated from `packages/brand`** via `tooling/scripts/apply-brand` (§34.6) — renaming never touches builder config by hand.
- **Buildable now:** `apps/desktop` builds the hardened shell that renders `apps/web`'s static export over `app://` from Phase 0; the full signing/MSIX pipeline lands in Phase 12. macOS/Linux parity build-out begins Phase 12 (§6, Phase 12).

### 8.9 Desktop folder layout

Slots into the pinned monorepo (§34.1–§34.2). **No new top-level decisions — only the internal structure of `apps/desktop` and `apps/sidecar`.**

```
apps/desktop/
├─ src/
│  ├─ main.ts                      # app lifecycle, single-instance lock, protocol registration
│  ├─ protocol/
│  │  ├─ app-protocol.ts           # app:// privileged scheme handler + per-request CSP nonce
│  │  └─ deeplink.ts               # agentos:// PKCE callback handling
│  ├─ windows/
│  │  ├─ window-manager.ts         # WindowManager singleton (main/child/quickAsk*/presenter*)
│  │  ├─ window-factory.ts         # the ONLY hardened webPreferences factory (sandbox:true etc.)
│  │  └─ window-state.ts           # persisted bounds (SQLite)
│  ├─ ipc/
│  │  ├─ register.ts               # registers exactly one handler per IpcContract key
│  │  └─ guards.ts                 # auth + Zod-parse per call
│  ├─ auth/
│  │  └─ pkce.ts                   # verifier/challenge/state, HTTPS code exchange, safeStorage
│  ├─ sidecar/
│  │  ├─ supervisor.ts             # reconcile loop, epoch guard, op queue, kill switch
│  │  ├─ integrity.ts              # codesign-verify + hash-pin before spawn
│  │  └─ lockfile.ts               # PID lockfile lifecycle
│  ├─ device/
│  │  └─ device-socket.ts          # Socket.IO /device client (auth handshake, StepTimer backoff)
│  ├─ store/
│  │  └─ sqlite.ts                 # userData SQLite (device, approved_folders, local_activity, ...)
│  ├─ update/
│  │  └─ updater.ts                # electron-updater feed wiring
│  └─ preload.ts                   # builds frozen window.agentos from packages/desktop-ipc
├─ resources/
│  └─ bin/                         # hash-pinned, signed sidecar binary per platform/arch
├─ electron-builder.config.ts      # generated from packages/brand via apply-brand
└─ package.json

apps/sidecar/                       # Rust crate — see §9.7
```

### 8.10 Test scenarios & acceptance criteria — Desktop

> Inherits the global gate (§7 of scope doc): passing unit+integration tests, no placeholders in core paths, no secret in the renderer bundle.

- **D1 — IPC allowlist (MVP/P4).** Renderer attempts an unlisted channel and an out-of-shape payload on a listed channel.
  **Accept:** unlisted channel has no handler → rejected; bad payload fails the per-call Zod parse → rejected; only named, validated methods succeed; **no `invoke(channel,…)` passthrough exists** (asserted by a test that greps the preload surface).
- **D2 — PKCE deep-link (MVP/P4).** Complete `agentos://auth?code=…&state=…`; then replay with a wrong `state`; then attempt to read a token from the deep-link URL.
  **Accept:** the one-time `code` is exchanged over HTTPS with the `code_verifier`; **no plaintext token appears in the deep link**; `state` mismatch is rejected; the renderer never receives a token (asserted on `auth.getSessionState`).
- **D3 — single instance & deep-link routing (MVP/P4).** Launch a second instance and fire a deep link while one is running.
  **Accept:** no duplicate instance; the deep link is delivered to the running instance via `second-instance`.
- **D4 — hardened windows (MVP/P4).** Inspect every created `BrowserWindow`.
  **Accept:** all have `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, `webSecurity:true`; `window.open` denied; untrusted `will-navigate` cancelled & externalized; no window can bypass the factory (asserted).
- **D5 — CSP/CORS posture (MVP/P4).** Inspect served `app://` headers.
  **Accept:** full CSP (`default-src`/`connect-src`/`object-src 'none'`/nonce'd `script-src`); CORS scoped to our origins only (no `<all_urls>` strip).
- **D6 — no secret in bundle (MVP/P1+).** Build web+desktop; scan artifacts.
  **Accept:** the LLM/OAuth keys appear in **no** client/desktop artifact; the renderer can never obtain a token via IPC.
- **D7 — instant STOP (MVP/P4).** Trigger `control.stopAll` mid-run on desktop.
  **Accept:** sidecar ops abort at next checkpoint (≤ ~250 ms), `stop` reaches the engine, task → `STOPPED`, the stop is audited; the Stop control is reachable at all times.
- **D8 — sidecar lifecycle on quit (MVP/P4).** Kill the desktop app while a sidecar runs.
  **Accept:** sidecar terminates (PID lockfile + `PARENT_PID`); no orphan remains.
- **D9 — window-state restore (MVP/P4).** Resize/maximize, quit, relaunch.
  **Accept:** bounds restored and clamped to a visible display.
- **D10 — engine uniformity (MVP/P4).** Run the shared UI E2E on web (Chromium) and on the Electron renderer.
  **Accept:** identical results (validates the single-engine rationale).
- **D11 — auto-update feed (Later/P12).** Publish a newer signed build.
  **Accept:** NSIS build self-updates from the feed; MSIX build installs from Store path with auto-update disabled; tampered sidecar hash blocks launch.

---

## 9. Local Computer Operator

**One-liner:** a hardened **Rust sidecar** (§6.14) that performs file and (Later) shell operations **only** inside explicitly approved folders, under per-action approval for risky ops, with OS-level path jailing, secret masking, a dangerous-command blocklist, and a live operation log — supervised by the desktop (§8.5) and never sending private credentials to the model.

> **MVP cut (Phase 4):** **read-only** file search/read/list + project-folder analysis, with the approval/stop scaffolding wired. **Phase 5 (full local power):** read-write file ops, gated shell execution with risk classification, opening local apps, codebase edit. Each capability below is tagged.

### 9.1 Approved-folder model & OS-level enforcement

**The folder is the sandbox primitive.** A user explicitly adds a folder via the OS directory picker (`folders.pickAndApprove`) and picks a **mode (`ro`/`rw`)** and (Later) whether shell is allowed. Nothing outside the approved set is reachable.

**How unapproved access is blocked (defense in depth):**

1. **Backend risk-gate (server trust zone).** Every tool call carries a target path; the gate rejects any path not within an approved scope for the session, *before* dispatch. (First guard.)
2. **Sidecar canonicalization jail (OS level — authoritative).** On every op the sidecar:
   - canonicalizes the request path with `std::fs::canonicalize` (resolves symlinks, `..`, `.`),
   - asserts the canonical path is a **prefix-match descendant** of the canonical approved-folder root (string-boundary-safe, e.g. `/a/bc` is NOT inside `/a/b`),
   - rejects any path that escapes (`../`, symlink-to-outside, junction/reparse points on Windows, UNC redirection) → `PathEscape` error, audited.
3. **OS jail (Later/P5).** Where available, confine the sidecar process itself: **Windows AppContainer** / restricted token + an explicit FS allowlist; (macOS sandbox profile, Linux seccomp/landlock) — so even a sidecar bug cannot touch disk outside the approved roots. (MVP relies on canonicalization; the process jail hardens it in P5.)
4. **Mode enforcement.** In `ro` mode, any write/rename/move/create/delete is refused at the sidecar regardless of what the backend asked.

**Symlink & reparse safety:** the approved root is canonicalized at grant time and re-validated per op; a symlink inside the folder pointing outside is treated as outside (canonical target checked). Windows reparse points/junctions are resolved and checked the same way.

```rust
// apps/sidecar/src/jail.rs — SKETCH (Rust)
// Returns Ok(canonical) only if `requested` canonicalizes to a descendant of an approved RW/RO root.
fn resolve_within_scope(requested: &Path, scope: &ApprovedScope) -> Result<PathBuf, OpError> {
    let canon = fs::canonicalize(requested).map_err(|_| OpError::NotFound)?;
    let root  = &scope.canonical_root; // canonicalized at grant time
    if !is_descendant(&canon, root) { return Err(OpError::PathEscape); }
    Ok(canon)
}
// is_descendant uses path-component comparison (not raw string startsWith) to avoid /a/b vs /a/bc bugs.
```

### 9.2 File operations surface

All ops are tools in `packages/tool-abi` (typed, risk-tagged, `surface:'local'`), executed by the sidecar under scope. Risk defaults shown; the engine may elevate.

| Tool | Default risk | Mode req. | Phase | Notes |
|---|---|---|---|---|
| `local.list` (dir listing) | low | ro | **MVP (P4)** | scoped, masked |
| `local.read` (read file) | low | ro | **MVP (P4)** | size-capped; chunked for the model |
| `local.search` (name/content grep) | low | ro | **MVP (P4)** | bounded depth/results; respects ignore globs |
| `local.analyzeProject` (folder analysis) | low | ro | **MVP (P4)** | language/deps/structure summary; no secret values sent to model (§9.5) |
| `local.write` (create/overwrite) | **high** | rw | **Later (P5)** | approval-gated; outside-scope target = `high`/`critical` |
| `local.create` (new file/dir) | medium | rw | **Later (P5)** | approval-gated |
| `local.rename` / `local.move` | **high** | rw | **Later (P5)** | both source+dest in scope; approval-gated |
| `local.delete` | **critical** | rw | **Later (P5)** | **always** approval-gated; recoverable-to-trash where possible; no recursive-root deletes |
| `local.editCode` (in-place codebase edit) | **high** | rw | **Later (P5)** | diff-preview before apply; §9.4 |

**Project-folder analysis (`local.analyzeProject`, MVP):** reads structure (tree, file types, sizes), detects language/build/deps (e.g. `package.json`, `pyproject.toml`, `Cargo.toml`, `.git`), and produces a summary for the planner. It **reads metadata and code structure, not secret values** — `.env`, key files, and high-entropy strings are masked before anything reaches the model (§9.5).

### 9.3 Terminal execution & risk classification

**Tag: Later (Phase 5)** for actual execution; **MVP (Phase 4)** ships the **risk-classification + approval scaffolding** (the prompt UI, the protocol fields, the audit path) so P5 is additive.

**Privilege separation (from teardown gap #2):** file access and shell access are separate grants. A folder may be `rw` for files yet have `allowShell:false`. Shell is **never** implied by file access.

**Risk classification pipeline** (every command, before any execution):

1. **Normalize** the command (resolve aliases, split pipelines, expand to the actual binaries invoked).
2. **Blocklist check (§9.5)** — dangerous patterns are **refused outright** (not merely escalated): e.g. `rm -rf /`, `format`, disk/partition tools, `mkfs`, fork bombs, `curl … | sh`, mass-`chmod`/`chown` on roots, registry-wipe, `shutdown`/`reboot`. A blocklisted command **cannot be approved into running** — it is denied.
3. **Classify** the remainder into a `RiskLevel`:

| Risk | Examples | Gate |
|---|---|---|
| `low` | read-only inspection (`ls`, `cat` in scope, `git status`, `node -v`) | runs (still logged) — but note even these go through approval scaffolding in P5 |
| `medium` | builds/installs that write inside scope (`npm ci`, `cargo build`), `git commit` | **approval required** |
| `high` | network-fetching installs, writing many files, `git push`, moving files | **approval required**, scope-confirmed |
| `critical` | anything that *could* delete/destroy or affect outside scope, privilege ops | **approval required**, explicit confirm, default-deny |
| (blocked) | dangerous-command blocklist | **denied — never approvable** |

4. **Approval** — `medium`+ emits an `approval_request` with the **exact normalized command, the working dir, the classified risk, and a plain-language explanation**; execution **pauses** until the user approves (or denies). Deletes and `critical` ops require explicit confirm.
5. **Execute** (P5) — only inside the approved folder as CWD, with the OS jail (§9.1 #3), output streamed to the operation log (masked), abortable instantly by STOP (§8.6).

```typescript
// packages/tool-abi — local shell tool risk surface — SKETCH
interface ShellRiskReport {
  normalized: string;          // the exact command we would run
  cwd: string;                 // must be inside an approved rw+shell scope
  binaries: string[];          // resolved executables
  risk: 'low'|'medium'|'high'|'critical';
  blocked: boolean;            // true → refused, not approvable
  reasons: string[];           // why this risk / why blocked (shown to user)
  touchesOutsideScope: boolean;
  networkAccess: boolean;
}
```

### 9.4 Opening local apps & codebase edit

- **Open local app (`local.openApp`)** — **Later (P5)**, risk `medium`/`high`. Opens an allowlisted application with user permission (e.g. open the project in the user's editor). The app to open is presented for approval; arbitrary executable launch outside an allowlist is refused.
- **Codebase read/edit within approved folders (`local.editCode`)** — read is **MVP (P4, ro)**; **edit is Later (P5, rw, `high`)**. Edits are produced as a **diff/patch previewed to the user before apply**; applying writes only inside scope; the pre/post diff is recorded in the operation log. No edit is applied without approval.

### 9.5 Secret masking & dangerous-command blocklist

**Secret masking (hard rule §1.4 #6; "never send private credentials to the model"):**

- A **centralized masking layer** (shared with `packages/logger`, §6.23) runs at three boundaries: (a) before any content reaches the **model**, (b) before any line is written to the **operation log / audit**, (c) before any value is shown in the **UI**.
- Detectors: known key formats (API keys, bearer tokens, AWS/GCP creds, private-key PEM blocks), `.env`/secret-file contents, high-entropy strings, and path components that look like secrets. Matches are replaced with a typed redaction token (e.g. `‹secret:api_key›`) — the model sees that a secret *exists* but never its value.
- **`.env`, credential files, key material are never sent to the model** even in `read`/`analyzeProject`; the tool returns masked content. (Acceptance E-? below seeds a secret and asserts redaction everywhere.)

**Dangerous-command blocklist:** a maintained denylist of irrecoverable/destructive patterns (see §9.3 step 2). It is **enforced at the sidecar** (authoritative) *and* mirrored at the backend gate. Blocklisted commands are **denied, not escalated** — there is no approval path that runs them. Deletes that *are* allowed (within scope, recoverable) still require `critical` approval.

### 9.6 Operation log

Every local op produces a **`LocalActivityEntry`** ("what it touched"): `ts`, `sessionId`, `op`, masked `path`/`command`, `result` (ok/error/denied), `riskLevel`, `approvalId?`, `bytes?`, `durationMs`. This stream is:
- emitted to the desktop via `sidecar.activity` (live "what it touched" panel),
- written to the **local SQLite ledger** (§8.7) for offline visibility,
- forwarded to the **server audit log** (Postgres, §7.1) as the authoritative record.

This closes teardown gap #1 (the app was previously blind to individual tool calls): every file/shell action is locally auditable and per-action approvable.

### 9.7 Sidecar Rust crate layout

```
apps/sidecar/                       # Rust crate (single static binary; codesigned + hash-pinned)
├─ Cargo.toml
└─ src/
   ├─ main.rs                       # arg parse (--device-folder-id, --ws, modes via control plane), PARENT_PID watch
   ├─ ws/
   │  ├─ client.rs                  # Socket.IO client to /device or to sandbox session WS (auth handshake)
   │  └─ backoff.rs                 # staged backoff curve (mirrors StepTimerHelper)
   ├─ reconcile.rs                  # applies desired scopes/sessions; epoch-aware; serialized op queue
   ├─ jail.rs                       # canonicalization + descendant check (§9.1); RO/RW mode enforce
   ├─ fs_ops.rs                     # list/read/search/analyze (MVP); write/create/rename/move/delete (P5)
   ├─ shell.rs                      # (P5) normalize, classify risk, blocklist, approval-gated exec, abort
   ├─ mask.rs                       # secret detection/redaction before model/log/UI
   ├─ audit.rs                      # LocalActivityEntry emission (stdout stream → supervisor)
   └─ heartbeat.rs                  # health/heartbeat for device_status
```

### 9.8 Test scenarios & acceptance criteria — Local Computer

- **E1 — integrity gate (MVP/P4).** Tamper with the sidecar binary.
  **Accept:** codesign-verify + hash-pin fails; the shell refuses to spawn; refusal audited.
- **E2 — scope & traversal enforcement (MVP/P4).** Agent attempts (a) a read outside any approved folder, (b) a `../` traversal, (c) a symlink-to-outside, (d) on Windows a junction/reparse to outside, (e) a write to a `ro` folder.
  **Accept:** all refused by the sidecar (canonicalized descendant check + mode enforce); each refusal audited; `/a/bc` is correctly treated as *not* inside `/a/b`.
- **E3 — read-only MVP loop (MVP/P4).** Approve a folder `ro`; run `analyzeProject` + `read`.
  **Accept:** structure/summary returned; **no write succeeds**; a write attempt is denied+audited (matches scope-doc Phase-4 criterion).
- **E4 — local-first privacy (MVP/P4).** Run a local file task with cloud execution disabled.
  **Accept:** file **bytes never leave the machine** (only model-necessary, masked content is sent); object storage untouched.
- **E5 — secret masking (MVP/P4).** Seed a folder with `.env` + an API-key string; run `read`/`analyzeProject`.
  **Accept:** secret values are masked before reaching the model, the operation log, and the UI; the model sees only the redaction token.
- **E6 — kill switch (MVP/P4).** Drop `/device` mid-op.
  **Accept:** all sidecars stop; epoch guard prevents a stale timer from resurrecting them; `device_status` reflects the reset on reconnect.
- **E7 — dangerous-command blocklist (Later/P5).** Agent proposes `rm -rf /` and a `curl … | sh`.
  **Accept:** both **denied, not approvable** (no approval path runs them); audited; an in-scope recoverable delete instead requires `critical` approval.
- **E8 — shell risk gating (Later/P5).** Agent proposes `npm ci` (in scope) and `git push`.
  **Accept:** each emits an `approval_request` with the exact normalized command + CWD + risk + explanation; nothing runs until approved; CWD confined to the approved `rw`+shell scope; OS-jail escape attempt fails.
- **E9 — codebase edit preview (Later/P5).** Agent edits a file via `local.editCode`.
  **Accept:** a diff is previewed; nothing is written until approved; pre/post diff recorded in the operation log; write confined to scope.

---

## 10. Local Browser Operator

**One-liner:** drive the **user's approved local browser** (their real Chrome/Edge profile, with their logins/extensions) under one of three escalating modes, with per-action permission, sensitive-data masking, no exfiltration, an instant stop, and a **hard CAPTCHA/2FA hand-off** — never a bypass.

> **Tag: Later (Phase 5)** in full (drive/takeover). The **mode toggle UI, permission scaffolding, and protocol fields** are introduced at MVP so P5 is additive. The desktop **does not bundle Playwright** (§6.12); the local browser operator drives the user's *own* browser via the Chrome DevTools Protocol (CDP), distinct from the cloud sandbox's headless Playwright.

### 10.1 Modes: read-only / assisted / autonomous

| Mode | What the agent may do | Approval cadence | Phase |
|---|---|---|---|
| **read-only** | Read page text, take a screenshot, detect forms/links. **No** interaction. | Single consent to read the current page/domain. | **Later (P5)** (read), scaffolding **MVP** |
| **assisted** | Propose a click/type; the **user approves each action** (or batches per domain). | Per-action (or per-step) approval. | **Later (P5)** |
| **autonomous** | Agent clicks/types within a **pre-approved domain allowlist** and a step budget, with instant takeover available. | Up-front per-domain consent + risk-gated approvals for sensitive actions (form submit, payment, irreversible). | **Later (P5)** |

Mode is **per task**, defaults to **read-only**, and can be downgraded at any time. Escalating to assisted/autonomous is an explicit user action with a clear, plain-language consent.

### 10.2 Capabilities & permission gating

| Capability | Risk | Permission |
|---|---|---|
| `browser.readText` | low | read consent (mode ≥ read-only) |
| `browser.screenshot` | low | read consent; sensitive regions masked (§10.3) |
| `browser.detectForms` | low | read consent |
| `browser.click` | medium / high | mode ≥ assisted; per-action approval (assisted) or domain allowlist (autonomous) |
| `browser.type` | medium / high | as above; typing into password/payment fields = `high`, explicit approval, masked |
| `browser.navigate` | medium | domain allowlist; off-allowlist navigation pauses for approval |
| `browser.submitForm` | **high** | always approval-gated; payment/irreversible = `critical` |

All actions are logged (masked) to the operation log (§9.6) and streamed to the Live Activity panel. The **Stop button** halts the operator instantly (§8.6) and returns control to the user.

### 10.3 Logged-in session use & no-exfiltration

- **Existing logged-in sessions are used only with explicit approval.** Driving the user's authenticated profile (their cookies/sessions) requires a distinct, clearly-worded consent ("Allow the agent to act in your logged-in `<domain>` session?"). Without it, the operator uses a fresh/isolated context.
- **Sensitive-data masking:** before any page content reaches the model or the log, the masking layer (§9.5) redacts values in password/payment/token fields, and the screenshot tool **blurs/blocks** detected sensitive regions (password inputs, card fields). The model is told a field *exists*, never its value.
- **No exfiltration:** the operator has **no general outbound channel of its own** — it acts on the page and reports masked observations back through the audited tool path. It cannot POST user data to arbitrary endpoints; navigation off the approved domain allowlist pauses for approval. Network interception (CDP) can enforce an egress policy and redact request/response bodies before logging.

### 10.4 CAPTCHA/2FA hand-off (hard rule)

Non-negotiable (§1.4 #7, §6.12 hard-rule note): on detecting a **CAPTCHA** or a **2FA/OTP** challenge, the operator **pauses and hands control to the user** (takeover), emits an `approval_request`/notification, and **never attempts to solve or bypass** it. No CAPTCHA-solving service, no OTP autofill, no 2FA circumvention ships. The user completes the challenge in their own browser; the agent resumes only after the user hands control back.

### 10.5 Browser-operator state machine

```
            ┌─────────────┐  user picks mode (default read-only)
            │   IDLE      │──────────────────────────────────────────┐
            └─────────────┘                                          ▼
                                                        ┌────────────────────────┐
        takeover / stop  ◄───────────────────────────── │  READING (read-only)   │
                ▲                                        └───────────┬────────────┘
                │                              escalate (explicit consent)
                │                                            ▼
        ┌───────┴────────┐   propose action   ┌──────────────────────────────┐
        │  USER CONTROL  │◄───────────────────│  ACTING (assisted/autonomous) │
        │  (takeover)    │  approve/deny      └──────────┬───────────┬────────┘
        └───────┬────────┘                               │           │
                │ hand back                  CAPTCHA/2FA │           │ sensitive action
                ▼                            detected ───┘           ▼ (submit/payment)
        (resume in prior mode)                  │             ┌────────────────┐
                                                ▼             │ APPROVAL GATE  │
                                        ┌────────────────┐    │ (high/critical)│
                                        │ HANDOFF (pause)│    └───────┬────────┘
                                        │ user solves    │            │ approve → act
                                        └────────────────┘            │ deny → skip/stop
```

Any state → **STOP** (instant) → IDLE; any sensitive action → APPROVAL GATE; any CAPTCHA/2FA → HANDOFF; the user may **takeover** from any acting state.

### 10.6 Test scenarios & acceptance criteria — Local Browser

- **B-LO1 — mode default & escalation (Later/P5).** Start a browser task.
  **Accept:** defaults to read-only; escalation to assisted/autonomous requires explicit consent; downgrade always available.
- **B-LO2 — per-action approval in assisted (Later/P5).** Agent proposes a click/type.
  **Accept:** each action awaits approval (or a per-domain batch grant); deny skips cleanly; all actions logged (masked).
- **B-LO3 — logged-in session consent (Later/P5).** Agent attempts to act in the user's authenticated profile without consent.
  **Accept:** blocked until explicit logged-in-session consent; without it an isolated context is used.
- **B-LO4 — sensitive masking (Later/P5).** Page has a password + card field; agent reads/screenshots.
  **Accept:** values masked before model/log; screenshot blurs sensitive regions; model never receives the value.
- **B-LO5 — no exfiltration (Later/P5).** Agent attempts to navigate off the allowlist / POST data to an arbitrary endpoint.
  **Accept:** off-allowlist navigation pauses for approval; the operator has no independent outbound channel; egress policy enforced + logged.
- **B-LO6 — CAPTCHA/2FA hand-off (Later/P5, hard rule).** A page presents a CAPTCHA, then a 2FA OTP.
  **Accept:** the operator pauses and hands off **every** time; **no** solving/bypass is attempted; resume only after the user completes it (asserted in a harness).
- **B-LO7 — instant takeover/stop (Later/P5).** Trigger takeover / STOP mid-action.
  **Accept:** control returns to the user instantly; the agent stops acting; state → USER CONTROL/IDLE; audited.

---

## 11. Preferred Browser

**One-liner:** let the user designate a specific local **Chrome/Edge** instance as *preferred* — preserving its logins, extensions, permissions, and network identity — so a (remote or local) task can request execution there, with offline fallback, a device/status UI, a dedicated-workstation mode, and approval still required for risky actions.

> **Tag: Later (Phase 5).** Builds directly on §10 and on the §13 device protocol. Scaffolding (preferred flag in the device registry, "request preferred-browser execution" field) is introduced at MVP.

### 11.1 Selection & profile preservation

- The user picks a preferred browser+profile in Settings → Devices → "Preferred browser." The choice (browser kind, profile path/id, device) is recorded in the device registry (§8.7, §13).
- **Profile preservation:** the operator attaches to the user's existing profile so **logins, extensions, site permissions, and network identity are preserved** (no clean throwaway profile unless the user wants isolation). Attachment uses CDP against a user-launched (or app-launched-with-consent) browser instance; the agent acts *within* that profile under the §10 permission model.
- Designating a preferred browser does **not** grant standing access — every task still goes through mode selection (default read-only) and risk-gated approvals.

### 11.2 Remote task requesting preferred-browser execution

A task created elsewhere (web, another device, an automation) may **request** preferred-browser execution. Flow:

1. The task carries `preferOnDevice: <deviceId>` and `useBrowser: 'preferred'`.
2. The backend issues a `device_config` to that device's desktop supervisor adding a browser-operator session bound to the preferred profile.
3. The desktop **prompts the user for consent** on that device (it is *their* browser/logins) before any action; risky actions still require approval (§10.2, §12).
4. The operator runs on the preferred device; status/activity stream back to the requesting surface over `/chat`.

The desktop is supervisor, not data path: the browser-operator session connects via CDP locally and reports masked observations through the audited tool channel.

### 11.3 Offline fallback

If the preferred device is **offline / last-seen stale / no active supervision**:
- The task does **not** silently run elsewhere with the user's logins. Instead it **falls back** to the **cloud sandbox headless browser** (§6.12) for non-authenticated work, **or** pauses and notifies the user that the preferred device is unavailable (their choice, set per task/policy).
- Authenticated/profile-bound steps cannot run without the preferred device; they wait or are skipped per the task's policy, never forced onto a different identity.

### 11.4 Device registry UI

Settings → **Devices** lists each registered device with:

| Field | Source |
|---|---|
| **Device name** | `deviceName` (`os.hostname()`) from `device_status` |
| **Status** | `online / offline / connecting / error` (from `/device` + heartbeat) |
| **Last seen** | last `device_status` timestamp |
| **Active task** | current `sessionId`/task running on the device (if any) |
| **Permissions** | approved folders (RO/RW, shell?), preferred-browser flag, logged-in-session consents |
| **Preferred browser** | which browser+profile is preferred on this device |

From here the user can revoke a folder, clear a logged-in-session consent, set/clear preferred browser, or **stop** the device's active task. All changes are audited.

### 11.5 Dedicated-workstation scenario

A **dedicated workstation** is a device the user designates to run agent browser/local tasks on their behalf (e.g. an always-on machine with their logged-in sessions and preferred browser). Properties:
- Marked `dedicated:true` in the registry; may auto-accept **preferred-browser execution requests** within a **pre-set policy** (allowed domains, max risk auto-approvable = `low/medium`, budget caps).
- **Approval is still required for risky actions** — `high`/`critical` (submit/payment/irreversible, off-allowlist) always gate to approval; the dedicated policy can only auto-approve what the user pre-authorized at `low`/`medium`.
- Losing supervision still triggers the kill switch (§8.5). A dedicated workstation is a convenience policy layer, **never** a bypass of the approval model.

### 11.6 Test scenarios & acceptance criteria — Preferred Browser

- **PB1 — selection & profile preservation (Later/P5).** Set a preferred Chrome/Edge profile; run a task.
  **Accept:** the operator attaches to that profile (logins/extensions/permissions preserved); no standing access granted (mode defaults to read-only; approvals still apply).
- **PB2 — remote request + consent (Later/P5).** A web-created task requests preferred-browser execution on device X.
  **Accept:** device X prompts the user for consent before acting; risky actions still require approval; status/activity stream back to the requester.
- **PB3 — offline fallback (Later/P5).** Mark the preferred device offline; run a task that requested it.
  **Accept:** authenticated/profile steps do **not** run on a different identity; the task falls back to the cloud headless browser for non-auth work **or** pauses+notifies per policy.
- **PB4 — device registry UI (Later/P5).** Open Settings → Devices.
  **Accept:** name, status, last-seen, active task, and permissions render accurately and update live; revoking a folder / clearing a consent / stopping the active task works and is audited.
- **PB5 — dedicated workstation policy (Later/P5).** Configure a dedicated workstation with an auto-approve policy capped at `medium`.
  **Accept:** `low`/`medium` pre-authorized actions auto-run within policy; **every** `high`/`critical` action still gates to approval; supervision loss triggers the kill switch.

---

## 12. Permission / approval model (cross-cutting surface)

A single approval surface serves §9–§11 (and matches the engine's risk-gate in §7.4/§7.6). Grants are **explicit, scoped, revocable, audited**.

**Grant types:**

| Grant | Scope | Lifetime | Revoke |
|---|---|---|---|
| **Folder grant** | one folder, `ro`/`rw`, `allowShell?` | until revoked | Settings → Devices, or `folders.revoke` |
| **Per-action approval** | one specific action (write `X`, run `cmd`, click `Y`) | one-shot | n/a (one-shot) |
| **Domain consent** (browser) | one domain | task or until revoked | Devices UI |
| **Logged-in-session consent** | one domain's authenticated profile | task or until revoked | Devices UI |
| **Preferred-browser** | a browser+profile on a device | until changed | Devices UI |
| **Dedicated-workstation policy** | a device, capped auto-approve (≤ user-set risk) | until changed | Devices UI |
| **Cost approval** | one task exceeding budget threshold | one-shot | n/a |

**Approval request contract (shared with §7.6):**

```typescript
interface ApprovalRequest {
  sessionId: string; approvalId: string;
  kind: 'folder' | 'file-write' | 'file-delete' | 'shell' | 'browser-action'
      | 'logged-in-session' | 'open-app' | 'cost' | 'preferred-browser';
  risk: 'low' | 'medium' | 'high' | 'critical';
  summary: string;            // plain-language, e.g. "Write report.md to ~/Desktop"
  detail: ApprovalDetail;     // normalized command / target path / domain / est cost (masked)
  defaultDecision: 'deny';    // default-deny for high/critical
  expiresAt?: string;         // auto-deny on timeout
}
interface ApprovalDecision {
  sessionId: string; approvalId: string;
  decision: 'approve' | 'deny';
  scope?: ScopeGrant;         // optional: widen to a folder/domain rather than one-shot
}
```

**Rules:** `high`/`critical` **default-deny** and **pause** the run; deletes/`critical` require explicit confirm; blocklisted commands are **never** presented as approvable (denied outright, §9.5); every decision (approve/deny/auto via policy/timeout) is **audited** with actor, scope, risk, and timestamp; the user can **stop** instead of deciding (§8.6).

---

## 13. Local Operator protocol — desktop ⇆ backend ⇆ sidecar

Extends the pinned `/device` contract (§7.6) with the fields this layer needs. Authored in `packages/protocol` (the `/device` namespace) and mirrored by the Rust sidecar.

**Topology (per §7.2):** Backend `/device` (desired) → Desktop **supervisor** (reconciles) → Rust **sidecar** (executes). Cloud is source of truth; the desktop is a reconciler (a tiny controller, like the teardown's k8s-style loop); the sidecar dials the cloud session WS directly for tool execution (desktop not in the data path).

```typescript
// packages/protocol — /device namespace (declarative reconcile) — SKETCH, extends §7.6
type DeviceFolderMode = 'ro' | 'rw';

interface DeviceConfig {                 // cloud → desktop (DESIRED state, monotonic version)
  deviceId: string;
  configVersion: number;                 // monotonic; stale versions dropped
  sessions: {
    sessionId: string;
    folderPath: string;                  // approved scope this session may touch
    sandboxWsUrl: string;                // sidecar dials this directly (cloud tool path)
    capabilities: ('file' | 'shell' | 'browser')[]; // capability negotiation (closes teardown gap #6)
  }[];
  folders: {
    folderId: string; path: string; name: string;
    mode: DeviceFolderMode;              // RO vs RW (closes teardown gap #2 — not one bool)
    allowShell: boolean;                 // shell is a SEPARATE grant from file access
  }[];
  preferredBrowser?: { kind: 'chrome' | 'edge'; profileId: string };
}

interface DeviceStatus {                 // desktop → cloud (ACTUAL state; heartbeated + on-change)
  deviceId: string; deviceName: string; platform: 'win' | 'mac' | 'linux';
  appliedConfigVersion: number;
  online: boolean; lastHeartbeatAt: string;       // closes teardown gap #5 (not fire-and-forget)
  sessions: {
    sessionId: string;
    status: 'idle' | 'connecting' | 'connected' | 'error';
    folderPath: string;
    activeOp?: string;                   // for "active task" in the device UI
    health: { reconnects: number; lastError?: string };
  }[];
  folders: { folderId: string; path: string; mode: DeviceFolderMode; allowShell: boolean }[];
  capabilities: { file: boolean; shell: boolean; browser: boolean }; // advertised support
  preferredBrowser?: { kind: 'chrome' | 'edge'; profileId: string; available: boolean };
  dedicated: boolean;
}
```

**Reconcile semantics (from §7.8 + teardown state machine, original implementation):**
- **Desired vs actual diff** (debounced ~200 ms): missing session → spawn sidecar; running-but-unlisted → stop; folder/mode/wsUrl/PID changed → restart that sidecar only.
- **`getBaseWsUrl`** strips token/query so a token-only change does **not** restart a healthy sidecar.
- **Epoch guard + serialized op queue:** every apply/reconnect is single-threaded; disconnect/shutdown bumps the epoch and cancels in-flight work (no stale-timer resurrection).
- **Reconnect backoff:** staged curve `[1,2,5,10,20,30,60,120,180,240,300]s`; per-session capped exponential for the sidecar↔sandbox link.
- **Disconnect = kill switch:** losing `/device` resets every sidecar; the agent has local power only while supervised.
- **Auth:** token in the Socket.IO `auth` handshake (`{ token, deviceId, deviceName }`), never the query string; redacted in logs (§6.11, §6.23).

---

## 14. Phase & MVP tag rollup

Consistent with `00-scope-and-phases.md` (MVP ends at Phase 4; full local power + preferred browser = Phase 5).

| Feature | Section | Phase | MVP? |
|---|---|---|---|
| Electron shell: window/process model, hardened webPreferences | 8.1 | P0 scaffold / P4 | ✅ |
| Secure preload + named/typed IPC allowlist (no passthrough) | 8.2 | P0/P4 | ✅ |
| PKCE deep-link login | 8.3 | P4 | ✅ |
| Create task / progress / drag-drop upload / approved-folder pick | 8.4 | P4 | ✅ |
| Sidecar supervisor (integrity gate, reconcile, epoch, lockfile, kill switch) | 8.5 | P4 | ✅ |
| Instant STOP (local fast-path + engine flag + supervision-loss) | 8.6 | P4 | ✅ |
| Logs, task history, local SQLite ledger | 8.7 | P4 | ✅ |
| Auto-update / dual NSIS+MSIX / signed sidecar / macOS-Linux parity | 8.8 | P12 | ⬜ Later |
| Approved-folder model + OS-level path jail | 9.1 | P4 (canon) / P5 (process jail) | ✅ (canon) |
| File read/list/search/analyzeProject (**read-only**) | 9.2 | P4 | ✅ |
| File write/create/rename/move/delete (**read-write**) | 9.2 | P5 | ⬜ Later |
| Terminal exec + risk classification (scaffolding) | 9.3 | P4 scaffold | ✅ (scaffold) |
| Terminal exec (actual, gated) | 9.3 | P5 | ⬜ Later |
| Open local app / codebase edit (read) | 9.4 | P4 (read) / P5 (edit/open) | ✅ (read) |
| Secret masking + dangerous-command blocklist | 9.5 | P4 (mask) / P5 (shell blocklist active) | ✅ (mask) |
| Operation log ("what it touched", dual audit) | 9.6 | P4 | ✅ |
| Local browser operator: read-only / assisted / autonomous | 10 | P5 (scaffolding P4) | ⬜ Later |
| CAPTCHA/2FA hand-off (hard rule) | 10.4 | P5 | ⬜ Later (rule enforced wherever browser acts) |
| Preferred browser: selection, remote request, fallback, registry UI, dedicated workstation | 11 | P5 (scaffolding P4) | ⬜ Later |
| Permission/approval surface | 12 | P1–P2 wiring, P4 desktop | ✅ |
| `/device` protocol (extended `device_config`/`device_status`) | 13 | P4 | ✅ |

> **Cross-cutting (embedded from earliest phase, not a single module):** risk levels, approval gating, instant stop, secret masking, dual (server+device) audit, cost-tracking — per the hard rules (§1.4).

---

## §13. TICKET-7 — Desktop Runner Foundation (implemented)

This section records what TICKET-7 actually landed (a *foundation*, flag-gated by `DESKTOP_RUNNER_ENABLED`, default false) versus what remains future work.

### Decisions
- **Electron (kept), not Tauri.** The repo already ships a hardened Electron scaffold (`apps/desktop`: `app://` privileged scheme, `sandbox:true` + `contextIsolation:true` + `nodeIntegration:false`, a Zod-validated IPC allowlist with no generic `invoke` passthrough, CSP, app-protocol). Switching to Tauri would discard that hardening for no gain at this stage; we build on Electron and revisit only if a concrete need appears.
- **No host command execution in this ticket.** The agent's `shell_exec`/`run_command` run inside the **Docker sandbox**, never on the host. Host command execution requires a **signed Rust sidecar + OS jail** (Windows AppContainer / Linux landlock-seccomp) and stays **Phase-5 future**. `DesktopRunner.capabilities.shellExec` is reported `false`. No unauthorized local command is ever possible.

### What was built
- **`DesktopRunner` model + migration + RLS** (workspace-isolated; `@@unique([workspaceId, deviceId])`). Tied to a TICKET-5 **Device** (identity + Bearer + the revoke kill-switch).
- **Backend** (`services/api/src/desktop/`): `register`, `heartbeat`, `list`/`get`, `setStatus` endpoints (register/heartbeat authenticate as a device, flag-gated). A revoked device **fails closed** at `AuthGuard` and again in the service.
- **Per-runner local-action audit** (flag-gated, from the task-runner local-fs sink): records `deviceId, desktopRunnerId, workspaceId, localFolderId, relativePath, pathHash, action, risk, approvalId?` — and **never** file content, secrets, or the **full absolute host path** (only a relative path + a `sha256(root|rel)` hash; a Windows username / absolute path can never reach the audit/log/UI).
- **Minimal desktop client** (`apps/desktop/src/runner/runner-client.ts`): a typed register/heartbeat HTTP client using the device Bearer token from secure storage — the token is **never persisted by this module** (read per request). Verified by `apps/desktop` typecheck + unit tests + esbuild build.

### Local file permission model (unchanged + reaffirmed)
- Access is confined to **user-approved `LocalFolder`s** only. `ENABLE_LOCAL_FS` gates the tools; `DESKTOP_RUNNER_ENABLED` gates the runner/audit foundation — both default false and independent.
- `safeResolve` (lexical containment + realpath/symlink canonicalization) rejects `../`, absolute-path, symlink, and Windows drive-form escapes (test-covered).
- Read requires folder-level approval; **write/delete are per-action approval-gated** (`local_write` → `require_approval`, host-folder `delete` → `require_elevated_approval`); sensitive paths/content raise the policy risk.

### Desktop ↔ Android continuation (future contract)
Cross-device state is already consistent (TICKET-5 device Bearer + TICKET-6 `/sync/snapshot`). "Continue on desktop" is a **deep-link** future step carrying `{ taskId, workspaceId, deviceId }` → the desktop shell opens the task (the web app renders over `app://`, reusing the same APIs). No new backend is required; only the deep-link handler + UI affordance remain (future).

### Security boundaries (summary)
Device revoke is the **primary** kill-switch (fail-closed). DesktopRunner `status`/`revokedAt` is supporting metadata. Audit is structural-only (no content/secret/absolute-path). Local access is folder-scoped + path-jailed. Host command execution, OS automation, and the Rust sidecar are **out of scope** and documented as Phase-5.
