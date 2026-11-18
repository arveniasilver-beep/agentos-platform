# AgentOS — Dünya Sınıfı Master Denetim Raporu
*Tarih: 2026-06-21 · Yöntem: 40 ajanlık çok-ajanlı, salt-okunur denetim (2 harita + 19 boyut + 19 çekişmeli doğrulama), tüm bulgular `dosya:satır` kanıtlı · Kod DEĞİŞTİRİLMEDİ.*

---

## 0. Yönetici Özeti

**Genel olgunluk: ~4.5 / 10.** AgentOS, **tek-düğüm / tek-cihaz (web + Windows-desktop)** bir bulut agent platformu olarak gerçekten güçlü: güvenlik primitifleri sınıfının üstünde (Postgres RLS, zarf şifreleme, SSRF guard, sertleştirilmiş Docker sandbox, hash-zincirli audit), ve özellik genişliği iyi (konnektörler, hosting, marketplace, otomasyonlar, wide-research). **Ancak senin vizyonunun talep ettiği dünya-sınıfı TEMELLER büyük ölçüde yok.**

### Stratejik tez doğrulandı
Senin "asıl darboğaz daha akıllı model değil; **durable runtime + event-sourced state + safe tool exec + sync + trace/eval/rollback**" tezin **kod tarafından birebir doğrulandı.** En kritik tek bulgu:

> **Yürütme yeniden-başlatılabilir (resumable) DEĞİL.** Olay günlüğü (`TaskLog`) güçlü ve append-only, ama motor durumu yalnızca süreç belleğinde yaşıyor; bir **deploy/çökme sırasında çalışan HER görev "failed" işaretleniyor** (boot reaper), lease/heartbeat yok, `attempts:1`, ve varsayılan `inline` mod ateşle-unut. Yani her sürümde aktif işler kaybolur. → **En yüksek kaldıraçlı P0.**

### Zihin modelini netleştiren bulgular — "yok sandığın ama KISMEN VAR" vs "gerçekten YOK"

**Aslında VAR (ve iyi):**
- Append-only, seq-sıralı **olay günlüğü** (`TaskLog`) + deterministik UI replay reducer — event-sourcing'in temeli atılmış.
- **Idempotent görev claim'i** (atomik pending→running), DB-tabanlı **stop/approval kontrol düzlemi** (replica-güvenli reconcile).
- **Onay kapısı çalışıyor**: `shell_exec` ve dosya yazımları **varsayılan olarak onay-kapılı** (yüksek-risk araçlarda `approvalRequired` varsayılan `true`). *(Bir önceki sezgi "shell varsayılan onaysız" YANLIŞ — doğrulamada çürütüldü.)*
- **Sertleştirilmiş sandbox** (cap-drop ALL, ağ kapalı, no-new-privileges, mem/pid/cpu limit), **SSRF guard**, **zarf şifreleme**, **hash-zincirli audit**.
- Deliverable'lar dispose'da **silinmiyor**; host'ta dosya olarak kalıp `ArtifactsService` ile sunuluyor.

**Gerçekten YOK (vizyonun çekirdek boşlukları):**
- **Resumable execution / snapshot / reducer-restore** — çökme = sıfırdan + tekrar faturalama.
- **Android uygulaması (0.5/10)** ve **cihaz-sync katmanı (2/10)** — tamamen greenfield.
- **Durable Artifact varlığı**: deliverable'lar için DB kaydı / blob store / versiyon yok; `final_output.artifactIds` her zaman `[]`.
- **Gerçek policy engine** ve **capability-scope uygulaması**: yetki kapsamları her araçta tanımlı ama **hiçbir yerde uygulanmıyor** (dekoratif).
- **Prompt caching** yok → sistem ön-eki her turda yeniden faturalanıyor (sessiz maliyet).
- **Eval / regression harness** yok → agent kalitesi sessizce geriler.
- **Browser yazma eylemleri** (form gönder/yükle/indir) varsayılan tavanda **onaysız** çalışır (medium-risk, tavan 'high').
- Coding workspace: agent **yazdığı kodu çalıştıramaz** (edit-FS ile exec-FS ayrı dosya sistemleri), patch-edit/yerel arama/git/test-runner yok.

### En yüksek kaldıraçlı 5 hamle (sıra önemli)
1. **Durable resume** (reducer + snapshot + lease/heartbeat + retry/DLQ) — çökmede kaldığı yerden devam.
2. **Durable Artifact persistence** — deliverable = birinci-sınıf, versiyonlu, indirilebilir kalıcı varlık.
3. **Policy engine + capability uygulaması + browser/ödeme onay kapısı** — "güvenli tool exec".
4. **Prompt caching + model-doğru fiyatlama + varsayılan bütçe** — maliyet şeffaflığı/kontrolü.
5. **Eval/regression harness + per-step trace** — kaliteyi ölçülebilir/regresyona karşı korumalı yap.
→ Çekirdek durable olduktan **sonra** sync/Android (senin P0-önce sıralamana uygun).

---

## 1. Repo Envanteri

**Monorepo:** pnpm workspaces + Turborepo, TypeScript strict (`exactOptionalPropertyTypes`).

- **apps/** — `web` (Next.js statik-export SPA; 27 panel/komponent, `lib/{api,stream,task-view,config,theme}.ts`, çıktı `apps/web/out`), `desktop` (Electron: `main.ts`, `preload.ts`, `ipc/contracts.ts`, `protocol/app-protocol.ts`, `security/csp.ts`, electron-builder; `release/AgentOS Setup 0.0.0.exe`). **`android` YOK** (doğrulandı: hiç `*.kt/*.gradle/AndroidManifest.xml/capacitor/expo/react-native` yok).
- **services/** — `api` (NestJS-on-Fastify, ~25 feature modülü: auth, tasks, queue, events, secrets, rbac, connectors, hosting, inbound, knowledge, automations, artifacts, projects, workspaces, skills, playbooks, personalization, media, usage, audit, notifications, api-keys, local-folders, peer…), `hosting-server` (self-hosted publish servisi).
- **packages/** (10) — `agent-engine` (engine/plan/controller/tool-runtime), `tools` (browser/fs/local-fs/sandbox/http/net-guard/deliverable/knowledge/peer/wide-research/konnektörler), `llm` (anthropic/openai-compat/mock provider + cost + embeddings + media), `db` (Prisma + tenant-context/RLS), `protocol` (events/risk/capability ABI), `crypto` (envelope), `config` (env), `auth` (password/pkce/tokens), `tool-abi` (tool/registry), `brand`.
- **DB** — Postgres 16 + pgvector (HNSW). **24 model**, 4 enum, **28 migration** (`20260617083051_init` → `20260620140000_local_folders`). Modeller: User, Session, Workspace, WorkspaceMember, Project, Playbook, LocalFolder, Secret, ApiKey, AuditLog, Notification, VectorDocument, Connection, InboundAddress, Personalization, Task, TaskLog, ToolCall, Approval, UsageRecord, CostRecord, Automation, Skill.
- **Altyapı/CI** — `infra/compose.yaml` (postgres/redis/minio), tek `.github/workflows/ci.yml` (migrate+typecheck+lint+test[canlı PG/Redis/Chromium]+build+secret-scan+9 E2E), `turbo.json`, `tooling/scripts` (apply-brand, scan-secrets), `scripts/` (yeni: run-local.ps1, smoke-test.ps1).
- **Testler** — Vitest: ~69 unit `*.test.ts`, ~21 `*.integration.test.ts` (canlı DB/Redis), 9 `*.e2e.mjs`. Coverage ölçümü YOK.

---

## 2. Mevcut Mimari Özeti

**Görev akışı:** `POST /workspaces/:id/tasks` → `TasksService.createAndStart` (Task'ı `pending` yazar, audit, dispatch) → `EXECUTION_MODE=queue` ise BullMQ `task.worker`, değilse **inline ateşle-unut** → `TaskRunner.run` (atomik `pending→running` claim = idempotency) → `AgentEngine.run` (tek-metot ReAct döngüsü). Her olay bir `TaskLog` satırı + yan-etki (ToolCall/Approval/Usage/Cost).

**Durum nerede:** Kalıcı Postgres'te (`Task`, `TaskLog` olay-zaman çizelgesi, `ToolCall`, `Approval`, `Usage/CostRecord`). **Süreç-belleğinde (kaynak değil):** `Map<taskId,RunController>`, aktif browser oturumları, ve tek bir `AgentEngine.run` içindeki `messages[]` sohbet geçmişi (kalıcı değil; >40 mesajda model-özetlemesiyle sıkıştırılır). Boot'ta çalışan-durumdaki görevler `failed` yapılır.

**Tool call:** Her tur tüm araç kataloğu modele gönderilir → Zod `safeParse` (sadece **input**) → per-tool timeout → onay kapısı (`approvalRequired || risk>ceiling`) → çalıştır → `tool_call/tool_result` olayları + ToolCall satırı. Geçmişe giren çıktı 8000 karakterde kesilir.

**Browser/terminal nerede çalışır:** `shell_exec` yalnızca **sertleştirilmiş Docker container**'da (host'ta değil; `ENABLE_SANDBOX=false` ise araç hiç kayıtlı değil — host fallback YOK). Browser = API-host'un Playwright/Chromium **çocuk süreci** (CDP screencast + take-over). fs/http araçları API sürecinde (per-task temp klasör, symlink-güvenli; http SSRF-korumalı).

**Desktop↔web:** Aynı statik bundle; Electron `localhost:4000`'e bağlanır (REST `credentials:include` cookie + Socket.IO canlı olaylar; reconnect'te backlog replay-sonra-canlı). **Cihaz-sync YOK** (apps yalnız desktop+web; çapraz-istemci "sync" tek API + tek Postgres + WS backlog-replay üzerinden dolaylı).

**Memory:** İki katman — daima-açık `Personalization` ön-eki (workspace-global) + opsiyonel pgvector RAG (yalnız model çağırırsa). Görevler arası epizodik bellek yok; agent öğrendiğini geri yazmıyor.

---

## 3. Hedef Mimariye Göre Gap Analizi

| Alan | Mevcut Durum | Hedef | Kritik Eksik | Şiddet | Önc. | Önerilen Çözüm |
|---|---|---|---|---|---|---|
| **Project Core** | Project boş etiket; gerçek sınır = Workspace (RLS yalnız workspaceId) | Project = aggregate + iç güvenlik sınırı | Project hiçbir şeyi sahiplenmiyor; budgetCapUsd/permissionProfile okunmuyor; lifecycle API yok | Orta | P1 | Gerçek ilişki + projectId RLS GUC + per-project bütçe/lifecycle |
| **Agent Runtime** | Tek-metot ReAct; plan üretiliyor ama döngüye beslenmiyor | Planner+Executor+Critic+Router ayrık, kendini-düzelten | Plan→Executor bağı yok; **critic/verifier yok**; self-correction/retry yok; tool selector yok | Yüksek | P0/P1 | Tamamlama-öncesi verifier + sınırlı retry; planı döngüye bağla; tool shortlist |
| **Tool Use** | Zod input + ToolCall kaydı | Versiyonlu kayıt, scope-uygulamalı, idempotent | **outputSchema doğrulanmıyor**; **permissions uygulanmıyor**; versiyon/idempotency yok | Yüksek | P1 | output doğrula; scope uygula; idempotency key; tool version |
| **Durable Execution** | Append-only log + idempotent claim + DB kontrol | Crash'te kaldığı adımdan resume | **Resume yok**; boot reaper in-flight'ı fail eder; lease/heartbeat/retry/DLQ yok; varsayılan inline | **Kritik** | **P0** | Reducer+snapshot resume; lease/heartbeat/fencing; retry+DLQ |
| **State / Data Model** | 1 güçlü olay-store + relational projeksiyonlar | Tek olay-kaynağından türeyen + durable Artifact | **Artifact/Snapshot/RollbackPoint/MemoryEntry yok**; çift kaynak (best-effort updateMany) | Yüksek | P0/P1 | Artifact+blob store; transactional projektör; Snapshot |
| **Sync** | 1 per-task olay-log primitifi | Local-first + outbox + conflict + per-alan strateji | İstemci store/outbox yok; afterSeq delta **kullanılmıyor**; conflict/version yok | Yüksek | P2/P3 | Delta cursor; optimistic-concurrency; local-first spike |
| **Android** | YOK | Güvenli continuation client (push onay) | Hiç yok; cookie-only auth; push/device registry yok | (kapsam) | P0* | Bearer mobile-session + push (device registry+FCM) + mobil projeksiyon |
| **Security & Policy** | Güçlü primitifler + çalışan onay kapısı | Gerçek policy engine + scope uygulaması | **Policy engine yok**; capability dekoratif; audit tool-exec'i kapsamıyor; dev-key fallback; self-approval | Yüksek | P0/P1 | Policy engine + scope uygula; audit'e tool-exec; KMS/rotation; admin-onay |
| **Sandbox (computer use)** | Sertleştirilmiş Docker, host fallback yok | Always-on, read-only rootfs, egress allowlist | Varsayılan KAPALI; yazılabilir rootfs; ya hep-ya hiç ağ; snapshot/rollback yok; volume per-workspace | Orta | P2 | read-only rootfs+mount; egress proxy; per-task volume+quota |
| **Browser** | Gerçek izole oturum + take-over + SSRF | Gözetimli, onaylı, replay'li operatör | **Yazma eylemleri varsayılan onaysız**; hassas-form onayı yok; injection savunması yok; action-log/replay yok | Yüksek | P0/P1 | Yazma eylemlerini onay-kapıla; sayfa içeriğini untrusted işle; action-log+replay |
| **Coding Workspace** | Güvenli fs araçları + LCS diff UI | Tek çalışma-ağacı, patch, arama, git, test-runner | **Edit-FS ≠ exec-FS** (yazdığını çalıştıramaz); patch yok; yerel arama/git/test-runner yok; rollback yok | Yüksek | P0/P1 | Sandbox'ı mount-birleştir; apply_patch + unified diff; ripgrep + per-task git checkpoint; run_checks |
| **Memory & Context** | Personalization ön-eki + manuel RAG; dikkatli compaction | Katmanlı/provenanslı bellek + cache-anchor + oto-retrieval | **Prompt caching yok**; agent write-back yok; provenance/expiry yok; project memory yok; oto-retrieval yok | Yüksek | P1 | cache_control ön-ek; yapısal MemoryEntry; data-fence + oto-retrieval; token-bazlı compaction |
| **Observability/Eval** | Durable log + mükemmel tek-run replay UI | Per-step trace + eval/regression | **Eval/regression yok**; per-run-only maliyet; retry görünmez; rollback/model-switch izi yok | Yüksek | P1 | Eval case + regression harness; per-step token/cost/model/retry |
| **QA / Test** | Canlı-altyapı integration; kritik güvenlik yolları | Ölçülü + adversarial + continuation E2E | Coverage gate yok; **injection korpusu yok**; runtime secret-leak testi dar; continuation E2E yok | Yüksek | P0/P1 | Injection+secret-leak bataryası; coverage gate; 15 continuation E2E; eval |
| **UX (web/desktop)** | Güçlü agent timeline/approval/share | Erişilebilir, markdown, native desktop | Onay kartı **tam komutu göstermiyor**; a11y yok; markdown yok; "Loading…"; desktop sadece web sarmalı | Orta | P1/P2 | Payload-aware approval; ortak erişilebilir Modal; markdown render; native menü/tray |
| **Performance** | İndeksli hot-path, sınırlı boyutlar, idempotent | Tek-düğümde sağlam | (tek-düğüm iyi) — unbounded list (audit/tasks); RLS çift round-trip | Orta | P1 | Cursor-pagination; taskLog batch; PgBouncer |
| **Scalability** | — | Stateless API + N worker | **In-process event bus** (multi-replica'da olay geçmez); **boot-only reaper**; worker concurrency sabit | Yüksek | P0/P1 | Redis pub/sub fan-out; lease-tabanlı reaper |
| **Cost Control** | Çalışan per-task limiter + canlı sayaç | Pre-flight estimate + eşik onayı + model-doğru | **Prompt cache yok**; **Opus'a sabit fiyatlama**; bütçe varsayılan null; eşik-onayı yok; peer harcaması bütçe-dışı | Yüksek | P1 | Model-aware pricing; pre-flight+eşik onayı; varsayılan+workspace tavanı |
| **Automation** | Sağlam BullMQ cron + peer/debate + wide-research | Retry/overlap/jitter/run-history + router | Run-history/retry/overlap-skip yok; Playbook/Skill çift; model router/agent registry yok | Orta | P1/P2 | AutomationRun + retry+overlap+jitter; template birleştir; model router |
| **CI/CD & DevX** | Güçlü tek CI + fail-fast env | Sertleştirilmiş + imzalı release | İmzalı desktop release yok; GHA hardening/SHA-pin yok; dep/code scan yok; migration-drift gate yok | Orta | P1/P2 | İmzalı release.yml; permissions/concurrency/timeout+SHA pin; Dependabot/CodeQL; migrate drift gate |

---

## 4. Risk Register (en kritik 16)

| # | Risk | Olasılık | Etki | Şiddet | Kanıt | Çözüm | Önc. |
|---|---|---|---|---|---|---|---|
| R1 | Her deploy/çökme **tüm aktif görevleri fail eder** (insan-onayı bekleyenler + 24s işler dahil); harcanan token yanar | Yüksek | Yüksek | **Kritik** | tasks.service.ts:181-188 (boot reaper); engine.ts:194,308 (resume yok) | Reducer-resume + lease; boot'ta resume için re-enqueue | P0 |
| R2 | Uzun/ücretli görev tamamlanır ama **deliverable DB'de kayıtlı değil** (artifactIds=[]); versiyon/blob yok, yeniden indirme garantisiz | Orta | Yüksek | **Kritik** | deliverable-tools.ts; engine.ts:405; `model Artifact` yok | Artifact+ArtifactVersion+blob store; final_output'a bağla | P0 |
| R3 | **Browser yazma eylemleri varsayılan onaysız** çalışır (medium-risk, tavan 'high'); form/ödeme/yükleme insan-checkpoint'siz | Yüksek | Yüksek | Yüksek | browser-tools.ts:341/378/402/442/468; dto.ts:13; engine.ts:466-467 | Yazma araçlarına approvalRequired; hassas-form onayı | P0 |
| R4 | **Capability scope'ları uygulanmıyor** + policy engine yok → bir araç sağlandıysa kapsam dışı da kullanılabilir; shell ham model string'ini alır | Orta | Yüksek | Yüksek | tool.ts:6-19,70 (okunmuyor); sandbox.ts:126 | Policy engine + scope uygulaması; komut risk-skorlama | P0 |
| R5 | Multi-replica'da **canlı olaylar replica'lar arası geçmez** (in-process EventEmitter) → kullanıcı donmuş/boş run görür | Yüksek | Yüksek | Yüksek | task-event-bus.ts:16; agent.gateway.ts:115-148 | Redis pub/sub fan-out (veya socket.io-redis) | P0 |
| R6 | Worker crash/redeploy görevi sonsuza dek "running"da bırakır (multi-replica'da boot-reaper kapalı, lease yok) | Yüksek | Yüksek | Yüksek | tasks.service.ts:180-191; env.ts:64-68 | lease/heartbeat + tek-replica süpürücü | P0 |
| R7 | Dolaylı prompt injection (web/email/tool çıktısı) agent'ı kaçırır; savunma tek İngilizce cümle, yapısal değil | Yüksek | Yüksek | Yüksek | engine.ts:502-507; inbound.service.ts:138-143 | Untrusted içeriği data-fence + tarama; ayrıcalık yükseltme yasağı | P0/P1 |
| R8 | **Agent yazdığı kodu çalıştıramaz** (edit-FS ≠ exec-FS) → sessiz yanlış sonuç; ayrıca whole-file overwrite veri kaybı | Yüksek | Yüksek | Yüksek | tools.factory.ts:94; sandbox.ts:110 (Binds:[]) | Sandbox'ı mount-birleştir; patch-first edit | P0/P1 |
| R9 | **Kalite regresyona karşı korumasız**: model/prompt değişimi (örn. opus-4-8 bump) sessizce sonucu bozabilir; eval/regression yok | Yüksek | Yüksek | Yüksek | eval/dataset/regression kodu yok; rating eval'e beslenmiyor | EvalCase/EvalRun + rerun harness; CI gate | P1 |
| R10 | **Prompt caching yok** → sistem ön-eki + tüm tool şemaları HER turda taze faturalanır (12 adımlık görev ön-eki 13× öder) | Yüksek | Yüksek | Yüksek | anthropic-provider.ts:113-122 (cache_control yok); engine.ts:351-354 | cache_control breakpoint + byte-stable ön-ek | P1 |
| R11 | **Maliyet yanlış**: tüm Anthropic çağrıları Opus fiyatından; non-Opus mis-billed; bütçe varsayılan null (kapsız) | Orta/Yüksek | Yüksek | Yüksek | anthropic-provider.ts:108,150; schema:400 | Model-aware pricing registry; varsayılan+workspace bütçe | P1 |
| R12 | Tamper-evident audit **tool execution'ı kapsamıyor** + zincir concurrency-güvensiz + metadata hash-dışı | Orta | Yüksek | Yüksek | task-runner.ts:207-233; audit.service.ts:38-67 | Tool-call/approval'ı hash-zincire; serialize; metadata-hash | P1 |
| R13 | Non-prod (staging/VPS) deploy'da **secret'lar geri-çözülebilir** (deterministik all-7s dev key) | Orta | Yüksek | Yüksek | crypto.service.ts:18-21 | Dev-key'i kapat (explicit local-dev flag); KMS | P1/P2 |
| R14 | Çakışan cron fire'ları aynı otomasyon için **mükerrer eşzamanlı görev** (çift harcama/çelişkili yan-etki) | Orta | Yüksek | Yüksek | automation.worker.ts:25-37 (overlap guard yok) | overlap-skip + AutomationRun + retry/jitter | P1 |
| R15 | İki cihaz/sekme aynı varlığı düzenlerse **sessiz son-yazan-kazanır** (version/etag yok) | Orta | Orta | Orta | schema (yalnız updatedAt); api.ts (If-Match yok) | Optimistic-concurrency (expectedVersion → 409 + conflict UI) | P2 |
| R16 | İmzasız desktop installer (SmartScreen, kurcalanabilir) + reproducible release pipeline yok | Yüksek | Orta | Yüksek | electron-builder.config.cjs:24 (forceCodeSigning:false); release workflow yok | Tag-tetiklemeli imzalı release.yml | P1 |

*Düşürülen/düzeltilen iddialar (doğrulamadan): "shell_exec varsayılan onaysız" → ÇÜRÜTÜLDÜ (high-risk araçlar `approvalRequired` ile kapılı). "Deliverable dispose'da silinir" → KISMİ (host'ta kalır; eksik olan DB-Artifact/blob/versiyon). "Cross-project leak = kırık erişim kontrolü" → KISMİ (workspace izolasyonu sağlam; proje düz etiket, eksik-özellik). "rating tüketilmiyor" → ÇÜRÜTÜLDÜ (gösterilir/persist; sadece eval'e beslenmez).*

---

## 5. Olgunluk Karnesi (0–10)

| Boyut | Puan | Gerekçe |
|---|---|---|
| Agent architecture | **5.5** | Sağlam ReAct döngüsü; plan→executor bağı, critic, self-correction, tool-selector yok |
| Tool use | **5.5** | Zod input + ToolCall kaydı; output doğrulama/scope/versiyon/idempotency yok |
| Browser automation | **5.5** | Gerçek izole oturum+take-over+SSRF; yazma onaysız, injection/replay yok |
| Computer use (sandbox) | **6** | Sertleştirilmiş Docker, host fallback yok; ama varsayılan KAPALI, yazılabilir rootfs |
| Memory | **3** | Tek workspace blob + manuel RAG; write-back/provenance/expiry/project-memory yok |
| Context management | **4** | Dikkatli compaction; prompt-cache/oto-retrieval/handover yok |
| File system (coding) | **2.5** | Güvenli fs ama edit≠exec FS, patch/arama/git/test-runner/rollback yok |
| Sync architecture | **2** | Bir iyi olay-log primitifi; client store/outbox/conflict/device yok |
| Desktop experience | **4** | Sertleştirilmiş Electron ama yalnız web-sarmalı (menü/tray/shortcut yok) |
| Android experience | **0.5** | Yok |
| UX quality | **6** | Güçlü timeline/approval/share; a11y/markdown/skeleton/responsive yok |
| Security | **5.5** | Mükemmel primitifler; policy engine/scope uygulaması/audit-tool-exec yok, dev-key |
| QA / test maturity | **5.5** | Canlı-altyapı integration + güvenlik yolları; coverage/injection-korpus/continuation-E2E/eval yok |
| Performance | **6** | İndeksli, sınırlı, idempotent (tek-düğüm) |
| Scalability | **3.5** | In-process event bus + boot-only reaper multi-replica'yı bloke eder |
| Observability | **4.5** | Durable log + harika replay UI; eval/regression/per-step yok |
| Developer experience (CI/CD) | **6** | Güçlü tek CI + fail-fast env; imzalı release/hardening/scan/drift-gate yok |
| Automation | **5.5** | Sağlam cron + peer/debate + wide-research; run-history/retry/router yok |
| Reliability (durable exec) | **3** | Durable log + idempotent claim; resume/lease/retry/DLQ yok |
| Product completeness | **5** | Özellik-geniş ama uçtan-uca gerçek görev hiç koşturulmadı + temel boşluklar |
| *Project core* | *2.5* | *Workspace gerçek sınır; Project düz etiket* |
| *Data model* | *5* | *Güçlü olay-store; Artifact/Snapshot/Memory yok* |
| *Cost control* | *5.5* | *Çalışan limiter; cache/model-pricing/varsayılan-bütçe yok* |

**Ağırlıksız ortalama (20 ana boyut): ~4.5 / 10.**

---

## 6. Önceliklendirilmiş Ticket Listesi

> Senin TICKET-001…012 listen audit gerçeğiyle uzlaştırıldı (bazıları kısmen mevcut → öncelik düzeltildi), ardından audit'in ek kritik ticket'ları eklendi. Format: Öncelik · Modüller · Amaç · Adımlar · Kabul · Test · Risk · Rollback.

### — P0 FOUNDATION (ertelenemez) —

**TICKET-002 · Event-Sourced Resume (reducer + snapshot)** — *P0 · agent-engine, tasks, db*
Amaç: Çökme/restart sonrası görev kaldığı adımdan devam etsin (sıfırdan değil).
Adımlar: (1) `TaskLog`'u motor durumuna (messages[], seq, plan, tamamlanan callId'ler, runningSummary) katlayan saf reducer. (2) Adım sınırlarında `Snapshot` yaz. (3) Engine `resumeFrom` kabul etsin. (4) Boot'ta in-flight'ı fail yerine resume için re-enqueue.
Kabul: Worker kill → görev son adımdan devam; restart → graph yeniden kurulur; mükerrer olay idempotent.
Test: integration "kill-mid-run → resume"; reducer determinizm testi; snapshot+replay = canlı state.
Risk: Reducer ile canlı yol drift → tek yazım yolu + property testleri. Rollback: feature-flag (`RESUME_ENABLED`), kapalıyken bugünkü davranış.

**TICKET-004 · Durable Job Runtime (lease/heartbeat/fencing + retry/DLQ)** — *P0 · queue, tasks, db*
Amaç: Worker crash/uzun-LLM-turu/transient hata görev kaybetmesin.
Adımlar: `leaseExpiresAt`+`fencingToken` kolonları; çalışırken job.progress/extendLock ping; `attempts>1`+backoff; tükenince DLQ + admin redrive; tek-replica lease süpürücü.
Kabul: Uzun adım stalled sayılmaz; re-claim'de tek worker çalışır (fencing); transient hata resume'la retry; kalıcı hata DLQ'ya düşer.
Test: lock-extension; çift-delivery fencing reddi; DLQ redrive E2E.
Risk: Yanlış lease süresi → çift çalışma; muhafazakâr süre + fencing. Rollback: lease kolonları nullable, süpürücü flag'li.

**TICKET-003 · Snapshots / RollbackPoints** — *P0 · db, tasks, tools*
Amaç: Resume hızlandırma + riskli adımdan geri-alma.
Adımlar: `Snapshot`(taskId,seq,serialized state) + `RollbackPoint`; per-task git checkpoint (workspace dosyaları). 
Kabul: En yakın snapshot+replay = deterministik state; bir adım geri alınabilir.
Test: snapshot-restore eşitlik; rollback sonrası dosya durumu. Risk: snapshot şişmesi → periyodik + budama. Rollback: yazma kapatılınca yalnız log-replay.

**TICKET-ART · Durable Artifact Persistence (Artifact + ArtifactVersion + blob)** — *P0 · db, artifacts, tools, agent-engine* (audit-ek, T'lerde yoktu)
Amaç: Deliverable = birinci-sınıf, versiyonlu, kalıcı, indirilebilir varlık.
Adımlar: `Artifact`/`ArtifactVersion`(storageKey,sha256) modelleri + object storage (MinIO mevcut); dispose ÖNCESİ her deliverable'ı Artifact yaz; `final_output.artifactIds`'i doldur; authed `/artifacts/:id` + replay'e ekle.
Kabul: Tamamlanan görevin çıktısı DB-kayıtlı, versiyonlu, sahip tarafından yeniden indirilebilir.
Test: üret→dispose→indir; versiyon zinciri; tenancy. Risk: storage maliyeti → boyut/TTL politikası. Rollback: yeni tablolar additive; flag.

**TICKET-008 · Policy Engine + Capability Scope Uygulaması** — *P0 · tool-abi, agent-engine, tasks, rbac*
Amaç: Tool çalıştırma scalar risk değil, **policy kararı + verilmiş yetki** ile yetkilensin.
Adımlar: Per-task granted-scope seti; `ToolRegistryExecutor.execute` önce scope kontrolü; komut/dosya/ağ allow-deny + risk-skorlama; fail-safe (eşleşmezse reddet).
Kabul: Bir araç gerekli scope yoksa çalışmaz; shell komutu policy'den geçer.
Test: scope-yok→red; deny-list komut→red; izinli→geçer. Risk: aşırı-kısıt mevcut akışları kırar → gözlem modu+log, sonra enforce. Rollback: enforce flag.

**TICKET-007 · Approval Gate Tamamlama (browser/ödeme + payload-aware)** — *P0 · agent-engine, protocol, tools, web*
Amaç: Riskli web yazımları ve tüm yıkıcı eylemler **tam operasyonu göstererek** onay beklesin.
Adımlar: browser yazma araçlarına `approvalRequired`/hassas-form algılama; `approval_request` event'ine yapısal `detail`(komut/diff/url/args); onay kartında collapsible önizleme (FileDiff/komut bloğu); high/critical onayını admin'e ve creator≠decider'a bağla.
Kabul: Varsayılan tavanda form-submit/upload/download onay ister; kullanıcı tam komutu/diff'i görür.
Test: form-submit→approval_request E2E; payload render; self-approval reddi. Risk: aşırı onay sürtünmesi → kategori bazlı eşik. Rollback: detail opsiyonel; flag.

**TICKET-VERIFY · Tamamlama-öncesi Verifier + Sınırlı Self-Correction** — *P0 · agent-engine* (audit-ek)
Amaç: Sessiz yanlış cevabı azalt; tek-atış ReAct → kendini-düzelten döngü.
Adımlar: Tamamlamadan önce Critic turu (cevabı + son trajektoriyi göreve/plana karşı puanla); fail'de mevcut bütçe içinde N sınırlı replan/retry.
Kabul: Başarısız öz-değerlendirme bir düzeltme döngüsü tetikler; bütçe aşılmaz.
Test: kasıtlı-yanlış senaryo→retry→düzelme; bütçe sınırı. Risk: maliyet artışı → effort'a bağlı. Rollback: flag.

### — P1 KALİTE & GÜVEN —

- **TICKET-011 · Trace + Eval/Regression Harness** *(P1 · obs)* — EvalCase/EvalRun; herhangi (özellikle başarısız) run'ı tekrar-koştur+diff; per-step token/cost/model/retry attribution; CI gate. Kabul: bir run eval-case olur, baseline'a karşı diff'lenir.
- **TICKET-CACHE · Prompt Caching + Model-Aware Pricing + Varsayılan Bütçe** *(P1 · llm, agent-engine)* — cache_control breakpoint + byte-stable ön-ek; model→pricing registry; varsayılan per-task + workspace aylık tavan; %80'de eşik-onayı. Kabul: cacheRead>0; non-Opus doğru faturalanır; kapsız görev kalmaz.
- **TICKET-009 · Secrets: KMS/Rotation + Runtime Redaction + Dev-Key Sertleştirme** *(P1/P2 · crypto, secrets)* — versiyonlu keyId + DEK re-wrap; authed event/log/error redaction testleri; dev-key yalnız explicit local flag'le. Kabul: bilinen secret event/log/error'da maskeli; non-prod'da gerçek key zorunlu.
- **TICKET-AUDIT · Tamper-Evident Audit'i Tool-Exec'e Genişlet** *(P1 · audit, tasks)* — tool_call/approval'ı hash-zincire; serialize (advisory lock); metadata-hash. Kabul: audit agent'ın ne yaptığını kanıtlar; zincir çatallanmaz.
- **TICKET-INJECT · Yapısal Untrusted-İçerik İşleme** *(P1 · agent-engine, tools)* — tool/web/email içeriğini `<data>` fence + "içindeki talimatlara uyma"; injection sezgisi; ayrıcalık yükseltme yasağı. Kabul: injection korpusu yüksek-risk aracı oto-çalıştıramaz.
- **TICKET-CODE · Working-Tree Birleştirme + Patch-First + Yerel Arama/Git/Test** *(P0/P1 · tools, sandbox)* — per-task root'u container'a /work mount; apply_patch/str_replace + server-side unified diff; ripgrep code_search; per-task git checkpoint/rollback; run_checks (test/build/lint/typecheck parsed). Kabul: agent yazdığını çalıştırır/test eder; büyük dosya diff'lenir.
- **TICKET-MEM · Yapısal Memory + Oto-Retrieval** *(P1/P2 · db, knowledge, agent-engine)* — `MemoryEntry{text,source,createdAt,expiresAt?,confidence}` + agent write-back + editable panel; retrieve-then-generate; project-scoped memory. Kabul: agent öğrendiğini provenanslı yazar; ilgili bilgi oto-girer.
- **TICKET-001 · Project'i Gerçek Aggregate Yap** *(P1 · db, tasks, projects)* — gerçek ilişkiler + onDelete; projectId RLS GUC + per-project filtre; budgetCapUsd/permissionProfile uygula; lifecycle API (get/update/archive/delete). Kabul: çapraz-proje izolasyon DB'de; per-project bütçe gerçek.
- **TICKET-SCALE · Redis Pub/Sub Fan-out + Lease Reaper + Cursor-Pagination** *(P0/P1 · events, tasks, queue)* — TaskEventBus'ı Redis'le destekle; sürekli lease süpürücü; audit/tasks list cursor-paginate + chain-verify ayır. Kabul: herhangi replica herhangi görevi stream'ler; orphan sürekli toplanır.
- **TICKET-UX · Erişilebilir Modal + Markdown + Native Desktop** *(P1/P2 · web, desktop)* — ortak `role=dialog` Modal (Esc/focus-trap); sanitized markdown render; skeleton; native menü/tray/shortcut/OS-notification.
- **TICKET-CI · CI Hardening + İmzalı Release + Drift Gate** *(P1/P2 · .github, desktop)* — permissions/concurrency/timeout + SHA-pin; tag-tetiklemeli imzalı release.yml; Dependabot/CodeQL + `pnpm audit`; `prisma migrate status` drift gate; format:check.
- **TICKET-AUTO · Durable Automation Runs** *(P1 · automations, db)* — AutomationRun (history) + retry/backoff + overlap-skip + jitter; Skill/Playbook birleştir (typed params).

### — P2 (Manus'a yaklaşma) —
- **TICKET-010 · Sandbox Sertleştirme** — read-only rootfs + tek yazılabilir mount; default-deny egress allowlist proxy; per-task volume + quota; shell/fs-write koşulsuz onay.
- **TICKET-TOOL · Output Doğrulama + Idempotency + Tool Versioning** — outputSchema safeParse; idempotency key (hash(taskId+tool+ver+args)); ToolCall.toolVersion.
- **Model Router** (capability/maliyet/modalite bazlı) · **Multi-agent Supervisor** (plan→delegate→reconcile DAG) · **Per-step cost/trace attribution** · **Optimistic-concurrency (R15)**.

### — P3 (Manus'u aşma / local-first) —
- **TICKET-005 · Local-First Sync + Outbox** (spike önce: tek varlık için client outbox + desktop cache + delta cursor) · **TICKET-006 · Desktop/Android State Protocol** · **Authoritative approval-state events** · **Token-driven compaction + persistent handover** · **pgvector per-workspace partial index**.

### — P4 (gelecekte enterprise) —
- RBAC genişletme · gerçek tenant/project isolation · SSO · audit export · org policies/quotas · marketplace/plugin governance · team collaboration · admin console.

### — Android (vizyonun yarısı, çekirdek-sonrası) —
- **TICKET-012 · Android Continuation** — önkoşullar: **bearer mobile-session** (cookie değil) + **push (device registry + FCM)** + **mobil event projeksiyonu** (raw tool I/O strip, boyut-cap) + genişletilmiş kontrol (retry/cancel/snooze/open-on-desktop) + diff/artifact preview API. Sonra native client (timeline/approvals/preview).

---

## 7. Önerilen Yol Haritası (faz sırası)

1. **Faz P0 — Durable Çekirdek:** TICKET-002/003/004 (resume+snapshot+lease/retry) → TICKET-ART (Artifact) → TICKET-008/007/VERIFY (policy+approval+verifier) → TICKET-SCALE (Redis fan-out+reaper) → TICKET-CODE (working-tree birleştirme). *Bunlar olmadan yeni özellik = teknik borç.*
2. **Faz P1 — Kalite & Güven:** Eval/regression, prompt-cache+pricing+bütçe, audit-tool-exec, injection-fence, memory, project-aggregate, UX(a11y/markdown), CI-hardening+imzalı release, automation-durability.
3. **Faz P2 — Manus seviyesi:** sandbox-hardening, tool output/idempotency/versioning, model router, multi-agent supervisor.
4. **Faz P3 — Manus'u aşma:** local-first sync + Desktop/Android continuation (bearer+push+projeksiyon → native Android).
5. **Faz P4 — Enterprise:** RBAC/tenant/SSO/governance.

**Nihai karar (senin tezinle aynı):** Bu ürünü güçlü yapan özellik sayısı değil — *asla görev kaybetmemesi, her adımın görünür/denetlenebilir olması, deliverable'ların kalıcı olması, tool risklerinin gerçek policy ile sınırlanması, maliyetin şeffaf/kontrollü olması, ve kaliteyi eval ile ölçebilmesi.* Önce **P0 durable çekirdek.**

---
*Kod değişikliği yapılmadı. Hangi P0 ticket('lar)ından başlayacağıma dair onayını bekliyorum.*
