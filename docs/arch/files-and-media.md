# AgentOS — Files, Artifacts, Multimedia, Design View, Slides, Data Analysis & Data Providers

> **Status:** Planning only. No production code. TypeScript appears solely as interface *sketches* to pin contracts.
> **Scope of this doc:** Planning sections **16 (File System), 22 (Multimedia), 23 (Design View), 24 (Slides), 25 (Data Analysis & Visualization)** + the **Artifact System** and the **Data Provider Registry**.
> **Conforms to:** `docs/00-scope-and-phases.md` (scope/phases/naming) and `docs/01-stack-and-system-architecture.md` (stack/topology/contracts). This doc does **not** restate or contradict those decisions — it builds on them.
> **Companion docs:** `_research/MANUS_TEARDOWN.md`, `_research/BUILD_BLUEPRINT.md`.
> **Brand handling:** every literal product name is `BRAND.appName` from `packages/brand` (§34.6 of the stack doc). No raw brand literals here.

---

## 0. How this doc plugs into the committed architecture

These features are **not new services**. They are tools, schemas, viewers, and engine capabilities layered onto the existing spine:

| Existing component (from stack doc §7.1) | What this doc adds |
|---|---|
| `services/api` (NestJS/Fastify) | `files`, `artifacts`, `data-providers` REST modules; presigned URL brokering; risk-gate on delete/share |
| `services/worker` + `packages/agent-engine` | extract/chunk/OCR/transcribe/profile/render jobs (BullMQ); generators (report/slides/chart/design edits) |
| `packages/tool-abi` | new **typed, risk-tagged tools** (`file.*`, `artifact.*`, `media.*`, `slides.*`, `data.*`, `provider.*`) |
| `packages/db` (Prisma/Postgres 16 + pgvector) | new tables: `FileRecord`, `FileChunk`, `Artifact`, `ArtifactVersion`, `Provenance`, `DataProvider`, `ProviderCache`, etc. |
| `packages/blob-store` (S3/R2/MinIO + local-FS) | stores raw uploads, extracted text, rendered artifacts, thumbnails, traces |
| `packages/memory` (`MemoryStore` + pgvector) | file-to-memory ingestion (chunk embeddings); user-controlled deletion from memory |
| `services/sandbox-orchestrator` (Docker+gVisor) | runs heavy/untrusted extraction & rendering (LibreOffice, ffmpeg, headless Chromium, Python data stack) |
| `apps/sidecar` (Rust) | local-first file read (RO MVP) / write (RW Later); folder scan; never round-trips bytes to cloud unless opted in |
| `packages/protocol` (Socket.IO `/chat`) | progress events for long media/data jobs; artifact-ready + final_output already defined |

**Cross-cutting rules inherited (non-negotiable, applied everywhere below):** risk level on every mutating tool; `high`/`critical` gate to approval; instant stop honored between/within jobs; sensitive data masked in UI/logs/prompts; secrets never in frontend; no module "done" without passing tests; no placeholders in core paths.

**Phase tags used:** **MVP** = Phases 0–4 (per scope doc; MVP completes at end of Phase 4). **LATER** = Phase 5+. Each feature is tagged consistent with Appendix A of the scope doc: File/Artifact core land in **Phase 2** (MVP); Multimedia/Design/Slides/Data-analysis land in **Phase 9** (LATER); Data Provider Registry rides with connectors/generators (**LATER**), with a tiny **MVP-lite** seam called out where it genuinely helps the MVP report deliverable.

---

## Table of contents

1. [File System (§16)](#1-file-system-16)
2. [Artifact System](#2-artifact-system)
3. [Multimedia (§22)](#3-multimedia-22)
4. [Design View (§23)](#4-design-view-23)
5. [Slides (§24)](#5-slides-24)
6. [Data Analysis & Visualization (§25)](#6-data-analysis--visualization-25)
7. [Data Provider Registry](#7-data-provider-registry)
8. [Core TypeScript interface sketches](#8-core-typescript-interface-sketches)
9. [Library matrix (per format)](#9-library-matrix-per-format)
10. [Data model (tables & fields)](#10-data-model-tables--fields)
11. [Folder layout additions](#11-folder-layout-additions)
12. [Consolidated MVP-vs-LATER feature table](#12-consolidated-mvp-vs-later-feature-table)
13. [Test scenarios & acceptance criteria](#13-test-scenarios--acceptance-criteria)

---

# 1. File System (§16)

The file subsystem turns user-supplied bytes into **retrievable, citeable, model-efficient context**. It is the front of the RAG and the source of `source-references` that every downstream artifact carries.

## 1.1 Supported types & per-format handling

| Class | Extensions / MIME | Primary handling | MVP? |
|---|---|---|---|
| PDF | `.pdf` | text + per-page layout extract; page images; table extract; OCR fallback for scans | **MVP** |
| Word | `.docx` | text + styles + embedded images; headings → outline | **MVP** |
| Spreadsheet | `.xlsx`, `.xls`, `.csv`, `.tsv` | sheet/range parse → typed table; profile; analysis | **MVP** (csv/xlsx read) |
| Text/markup | `.txt`, `.md`, `.json`, `.html`, `.xml`, `.yaml` | direct read; structure-aware chunk; HTML→clean text | **MVP** |
| Code | `.ts/.js/.py/.go/.rs/.java/.c/.cpp/.sql/...` | language-aware chunk (symbol boundaries); syntax highlight in preview | **MVP** |
| Archive | `.zip`, `.tar`, `.gz`, `.7z` | safe extract (zip-bomb guarded) → recurse into members | **MVP** (`.zip`) / others LATER |
| Image | `.jpg/.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, `.tiff`, `.svg`, `.heic` | thumbnail; EXIF strip; OCR; image-understanding (multimodal) | **MVP** (preview+OCR) / understanding LATER |
| Audio | `.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg` | transcription + diarization | **LATER** |
| Video | `.mp4`, `.mov`, `.webm`, `.mkv` | audio extract → transcript; keyframe sampling; timestamped summary | **LATER** |
| Folder | (desktop folder upload) | recursive scan → many `FileRecord`s with relative paths | **MVP** (RO via sidecar) |

> Unknown/over-size/over-depth inputs are **rejected with a typed error**, never silently dropped (hard rule: no fake success). Max size, max archive expansion ratio, max recursion depth are config (`packages/config`, Zod-validated).

## 1.2 Capabilities (each mapped to a tool + phase)

| Capability | Tool (in `packages/tool-abi`) | Risk | MVP? |
|---|---|---|---|
| Upload (web presigned / desktop local) | `file.ingest` | low | **MVP** |
| Preview (page/sheet/region) | `file.preview` (read) | low | **MVP** |
| Extract text | `file.extractText` | low | **MVP** |
| Chunk (semantic/structural) | `file.chunk` | low | **MVP** |
| Search within file/workspace | `file.search` | low | **MVP** |
| Page-by-page PDF | `file.pdfPage` | low | **MVP** |
| Table extraction | `file.extractTables` | low | **MVP** |
| OCR (scanned PDF/image) | `file.ocr` | low | **MVP** |
| Excel/CSV analysis hand-off | → `data.load` (§6) | low | **MVP** |
| Zip extract | `file.unzip` | medium (writes derived files) | **MVP** |
| Folder scan | `file.scanFolder` | low (RO) | **MVP** |
| Report from files | → `artifact.generateReport` (§2) | medium | **MVP-lite** |
| Generate files | → `artifact.*` generators | medium/high | **MVP** (md/csv) |
| Source references | `FileChunk.sourceRef` threaded into artifacts | — | **MVP** |
| Deletion (file) | `file.delete` | **high** (destructive) | **MVP** |
| Version history (file) | `FileRecord` revisions | low | **MVP-lite** |
| File→memory ingestion | `file.ingestToMemory` | medium (privacy) | **MVP-lite** |
| Delete from memory | `memory.forgetFile` | medium | **MVP-lite** |

## 1.3 Ingestion pipeline (sequence)

```
ingest → detect → store-raw → (sandbox/sidecar) extract → normalize → chunk → [optional] embed → index → ready
```

1. **`file.ingest`** (API or sidecar). Web: client requests a **presigned PUT** (`BlobStore.putPresigned`), uploads directly to object storage (bytes never transit the API process). Desktop local-first: the **Rust sidecar** reads bytes from the user's disk under RO scope; bytes stay local unless the user opts into cloud.
2. **Detect.** MIME + magic-bytes sniff (`file-type`), not extension alone. Mismatch → quarantine + typed error.
3. **Persist `FileRecord`** (status `UPLOADED`) with `sha256` (content hash → dedup), size, source (`upload|sidecar|artifact|web-download`), `workspaceId`, `projectId`.
4. **Extraction job** (BullMQ → worker; heavy/untrusted formats run **in the sandbox**, never in the API). Emits `file.progress` events on `/chat`. Per-format library in §9. Produces normalized text + structure (pages, sheets, tables, headings) stored as a derived blob + DB metadata.
5. **Chunk.** Structure-aware: PDF by page→paragraph; docx by heading; xlsx/csv by sheet/row-window; code by symbol; markdown/html by heading. Each `FileChunk` carries a precise `sourceRef` (page/sheet/cell-range/line-range/timestamp) for citations. Token-bounded with overlap (config).
6. **Embed (optional, consent-gated).** Only on `file.ingestToMemory`. Embeddings written to **pgvector** scoped by `workspaceId`; nothing sent to the model beyond what retrieval requires. Default: a freshly uploaded file is queryable *within the task* without being persisted to long-term memory.
7. **Ready.** `FileRecord.status = READY`; tools can now `preview/search/extractTables/...`.

**Error recovery:** corrupt PDF → OCR fallback; OCR-empty → flag `extractionConfidence: low` and surface to user (never claim success); password-protected → request credential via approval prompt (never bypass).

## 1.4 Local-first folder scan (desktop, RO — MVP)

`file.scanFolder` runs in the **sidecar** (Rust): canonicalizes paths (`realpath`, rejects `../` traversal), respects RO scope, applies an ignore list (`.git`, `node_modules`, binaries over threshold), and streams `FileRecord` stubs back over `/device`→`/chat`. **Bytes never leave the machine** unless the user approves cloud upload of a specific file (per-action approval, audited). Write/extract that would create derived files on the user disk is **RW = Phase 5 (LATER)**; MVP extracts to cloud/session-sandbox scratch.

## 1.5 Deletion & retention

- **`file.delete`** is **risk `high`** (destructive, irreversible from the user's view) → approval gate. Soft-delete first (`deletedAt`), hard-purge (blob + chunks + embeddings) after retention window or on explicit "purge now."
- **`memory.forgetFile`** removes that file's chunks/embeddings from `MemoryStore` and is reflected immediately in retrieval (asserted by test). User-controlled, per file, per workspace — satisfying "user-controlled deletion from memory."
- Every delete writes an **audit row** with risk + actor + decision.

---

# 2. Artifact System

An **Artifact** is a versioned, citeable, downloadable deliverable produced by the agent. Artifacts are the product's output currency; they are content-addressed, audit-linked, and carry **provenance** (what task, files, tools, prompts produced them).

## 2.1 Artifact types

| Type | Stored form | Viewer | Generator phase |
|---|---|---|---|
| `markdown` | `.md` text blob | rendered MD + raw toggle | **MVP** |
| `pdf` | `.pdf` blob | embedded PDF viewer | **MVP** (md→pdf) |
| `docx` | `.docx` blob | download + preview (rendered) | **MVP-lite** |
| `xlsx` | `.xlsx` blob | sheet grid viewer | **MVP-lite** |
| `csv` | `.csv` blob | table viewer | **MVP** |
| `json` | `.json` blob | tree/code viewer | **MVP** |
| `html` | `.html` blob | sandboxed iframe preview | **MVP** |
| `code` | text blob (+ lang) | syntax-highlighted | **MVP** |
| `zip` | `.zip` blob | manifest list | **MVP** |
| `screenshot` | `.png` | image viewer | **MVP** (from browser tool) |
| `browser_recording` | trace/`.webm` | timeline player | **LATER** |
| `slide_deck` | `.pptx`/`.pdf` + deck JSON | slide viewer + presenter | **LATER** |
| `chart` | `.png/.svg` + spec JSON | chart viewer + NL-edit | **LATER** |
| `transcript` | JSON (segments+speakers) | transcript viewer | **LATER** |
| `video_summary` | JSON (timestamped) + MD | timestamped summary viewer | **LATER** |

## 2.2 Capabilities

| Capability | Mechanism | Risk | MVP? |
|---|---|---|---|
| Preview | type-specific viewer (`packages/ui`) | low | **MVP** |
| Download | `BlobStore.getPresigned` | low | **MVP** |
| Version history | `ArtifactVersion` chain (immutable, append-only) | low | **MVP** |
| Diff | text diff (md/code/csv/json); structural diff (deck/chart spec LATER) | low | **MVP** (text) |
| Comments | `ArtifactComment` (anchored to version/region) | low | **LATER** |
| Edit via agent | `artifact.edit` → new version | medium | **MVP** (md/code/csv) |
| Sharing link | signed, scoped, expiring URL | **high** (data egress) | **MVP-lite** |
| Permissions | `viewer/commenter/editor` per share | medium | **LATER** (full RBAC) |
| Export | format conversion (md→pdf/docx, deck→pptx/pdf) | medium | **MVP** (md→pdf) |
| Source references | `Provenance.sourceRefs` rendered as citations | — | **MVP** |
| Provenance | `Provenance` record (task+files+tools+prompts) | — | **MVP** |
| Rollback | restore a prior `ArtifactVersion` as new head | medium | **MVP** |

## 2.3 Provenance (PROVENANCE is a first-class, mandatory record)

Every artifact version links a `Provenance` capturing **exactly** how it was produced:

- `taskId`, `sessionId`, `stepIds[]` — the run and steps that created it.
- `sourceFileRefs[]` — `{ fileId, chunkIds[], sourceRef }` for every input chunk → renders as inline citations.
- `toolInvocationIds[]` — every tool call that touched the output.
- `providerCalls[]` — `{ provider, model, promptHash, tokensIn, tokensOut, costUsd }` (prompt **hashed**, not stored verbatim, to respect masking; full prompt retrievable only inside the backend trust zone with redaction).
- `dataProviderRefs[]` — external data sources used (§7), with `fetchedAt` + `freshness` + `reliabilityLevel`.
- `parentVersionId` — for edits/rollbacks (full lineage chain).

**Why hashed prompts:** satisfies "sensitive data masked in logs" while preserving auditability/reproducibility. A reproduce action re-runs from the lineage; a verification test asserts a generated artifact's `Provenance` lists every input file and tool.

## 2.4 Versioning, diff, rollback (state machine)

```
DRAFT ──finalize──► v1 ──artifact.edit──► v2 ──edit──► v3
   ▲                  │        │                 │
   └──── discard ─────┘     rollback(v1) ───────►v4 (= copy of v1, new head, parent=v3)
```

- Versions are **immutable**; an edit always creates a new version (content-addressed by blob `sha256`). Rollback creates a *new* head copying an old version's content with `parentVersionId` pointing at the prior head — history is never rewritten (audit integrity).
- `diff(vA, vB)` returns a unified text diff for textual types; deck/chart use a structural spec diff (LATER).

## 2.5 Generators (engine-side)

- **`artifact.generateReport`** (**MVP-lite**): synthesizes a markdown report from `FileChunk`s + tool results, inserts inline citations from `sourceRef`, optionally embeds tables/charts. Exports to PDF (md→PDF).
- **`artifact.edit`** (**MVP**): agent applies an instruction to an existing artifact → new version + provenance delta.
- Slides/chart/design/transcript generators: **LATER** (§§4–6), but all emit the *same* `Artifact`/`ArtifactVersion`/`Provenance` shape so viewers and history work uniformly from day one.

## 2.6 Sharing & permissions

- A share creates a `ShareLink` with `{ artifactId, versionId?, role, expiresAt, masked: true }`. Creating an externally-reachable link is **risk `high`** (data egress) → approval gate; **sensitive values masked in the shared/replay view** (inherited rule). MVP ships view-only expiring links; commenter/editor roles + full RBAC are **LATER** (align with Collaboration, scope doc Phase 7).

---

# 3. Multimedia (§22) — **LATER (Phase 9), media-store seams MVP**

All multimedia heavy lifting runs **in the sandbox** (ffmpeg, whisper, image libs) or via provider abstractions — never in the API or the thin desktop bundle. Each capability is a risk-tagged tool emitting `Artifact`s with provenance.

## 3.1 Capabilities

| Capability | Tool | Engine/library | Risk | MVP? |
|---|---|---|---|---|
| Image understanding | `media.describeImage` | multimodal LLM via `LlmProvider` (image content blocks) | low | **MVP** (basic) / rich LATER |
| Image generation | `media.generateImage` | `ImageProvider` abstraction (see below) | medium | **LATER** |
| Image editing workflow | `media.editImage` | provider inpaint/edit + `sharp` compositing | medium | **LATER** (ties to Design View §4) |
| Video understanding | `media.analyzeVideo` | ffmpeg keyframes + multimodal + transcript | low | **LATER** |
| Video transcription | `media.transcribe` (video) | ffmpeg→audio→ASR | low | **LATER** |
| Timestamped summary | `media.timelineSummary` | ASR segments + LLM reduce | low | **LATER** |
| Audio transcription | `media.transcribe` | ASR (whisper-class / provider) | low | **LATER** |
| Speaker diarization | `media.diarize` | diarization model (`pyannote`-class) | low | **LATER** |
| TTS | `media.synthesizeSpeech` | `TtsProvider` abstraction | medium | **LATER** |
| Voice-note → task | `media.voiceToTask` | STT → task intake | medium | **LATER** |
| Screenshot/diagram/chart analysis | `media.analyzeVisual` | multimodal + OCR | low | **MVP** (screenshot read) |

## 3.2 Provider abstractions (mirror `LlmProvider` style)

Following the stack doc's `LlmProvider` pattern (thin interface, server-side keys encrypted at rest), media providers are **swappable** behind interfaces so no capability is hardwired to one vendor:

- `ImageProvider` — `generate(prompt, size, refs?) / edit(image, mask, prompt) / variations()`.
- `TtsProvider` — `synthesize(text, voice, format) → audio blob`.
- `AsrProvider` — `transcribe(audio) → { segments, language }`; `diarize(audio) → speakers[]`.
- All keys live in the encrypted secrets vault (`packages/crypto`), decrypted only in the worker/engine, **never** in the frontend. Cost metered per call into `Provenance.providerCalls` and usage tables (same path as LLM tokens).

## 3.3 Transcript & summary artifacts

`transcript` artifact = `{ segments: [{ start, end, speaker, text, confidence }], language }`. `video_summary` = timestamped sections each linking back to a transcript segment / keyframe (those links are the `sourceRef`s). Diarization labels are editable (rename "Speaker 1" → "Alex") and re-export updates the artifact as a new version.

---

# 4. Design View (§23) — **LATER (Phase 9)**

An original visual-edit surface: upload an image, select regions, instruct per region, batch, detect/edit text elements, compare before/after, version, save each edit as an artifact. Architected so a future **mobile long-press** region selection drops in without redesign.

## 4.1 Model

```
DesignSession
  ├─ baseImage: FileRecord            (the uploaded image)
  ├─ referenceImage?: FileRecord      (style/content reference)
  ├─ regions: Region[]                (rectangles/polygons/lasso; normalized 0..1 coords)
  │     └─ Region { id, shape, normCoords, instruction, kind: 'edit'|'textEdit'|'mask', status }
  ├─ detectedTextElements: TextElement[]   (OCR boxes → editable text + font guess)
  └─ edits: DesignEdit[]              (each → an Artifact version: before/after pair)
```

- **Region coords are normalized (0..1)** and **input-method-agnostic** — mouse drag, touch long-press, or programmatic. This is the key forward-compat decision: the selection geometry is decoupled from the pointer event, so mobile long-press (LATER) reuses the same `Region` contract.
- **Detect text elements:** OCR (`tesseract`-class) returns boxes; the UI overlays editable text fields; "edit text" produces a targeted inpaint/replace via `ImageProvider`.
- **Batch regions:** one instruction applied across N selected regions in a single `media.editImage` flow → one new artifact version with N region deltas in provenance.
- **Before/after + version history:** every `DesignEdit` saves as an `Artifact` version (type `screenshot`/`image`), so the generic artifact diff/rollback/provenance machinery applies; the viewer adds an image-specific before/after slider.

## 4.2 Capabilities table

| Capability | Risk | MVP? |
|---|---|---|
| Upload base image | low | **MVP** (upload exists) |
| Select region (rect/poly/lasso) | low | **LATER** |
| Per-region instruction | medium | **LATER** |
| Batch regions | medium | **LATER** |
| Detect/edit text elements | medium | **LATER** |
| Reference image | low | **LATER** |
| Before/after compare | low | **LATER** |
| Version history per edit | low | **LATER** (uses MVP artifact versioning) |
| Save edit as artifact | medium | **LATER** |
| Mobile long-press selection | low | **LATER** (architecture ready in MVP via normalized coords) |

---

# 5. Slides (§24) — **LATER (Phase 9), Presenter ties to scope C21**

Generate a deck from a prompt, files, or web research; themeable (brand color + font); visuals/charts/diagrams; speaker notes; export PPTX/PDF/web; edit outline; regenerate a single slide; embed data charts.

## 5.1 Deck model (the editable source of truth)

```
Deck { id, title, theme: DeckTheme, slides: Slide[] }
DeckTheme { palette, fontHeading, fontBody, logoRef?, layoutPreset }
Slide {
  id, layout: 'title'|'bullets'|'two-col'|'image'|'chart'|'quote'|'section',
  title, body: Block[],            // text/bullets
  visuals: VisualRef[],            // chart spec | image artifact | diagram
  speakerNotes,
  sourceRefs: SourceRef[]          // citations per slide
}
```

- The **deck JSON is the artifact's editable form**; PPTX/PDF/web are *renders* of it. This makes "edit outline" and "regenerate single slide" cheap (mutate JSON → re-render only what changed) and keeps full provenance per slide.
- **From prompt/files/web-research:** the engine plans an outline → fills slides from `FileChunk`s + data/web results, threading `sourceRefs` (citations) per slide.
- **Theme/brand:** `DeckTheme` defaults to `BRAND` tokens; user can override palette/fonts.
- **Visuals:** charts come from §6 chart specs; diagrams from a text-to-diagram step; images from §3.
- **Regenerate single slide:** `slides.regenerateSlide(slideId, instruction?)` replaces one `Slide`, new deck version, provenance delta — no full re-gen.
- **Export:** deck JSON → PPTX (`pptxgenjs`), → PDF (headless Chromium print or LibreOffice), → web (static HTML reveal-style viewer). **Presenter mode** (multi-monitor) reuses the desktop `presenter` window (scope C21).

## 5.2 Capabilities table

| Capability | Risk | MVP? |
|---|---|---|
| Deck from prompt | medium | **LATER** |
| Deck from files / web research | medium | **LATER** |
| Theme / brand color + font | low | **LATER** |
| Visuals / charts / diagrams | medium | **LATER** |
| Speaker notes | low | **LATER** |
| Export PPTX / PDF / web | medium | **LATER** |
| Edit outline | low | **LATER** |
| Regenerate single slide | medium | **LATER** |
| Data charts into slides | medium | **LATER** |
| Presenter mode (multi-monitor) | low | **LATER** (scope Phase 9) |

---

# 6. Data Analysis & Visualization (§25) — **LATER (Phase 9), CSV/XLSX read MVP**

Load tabular data, clean/profile/validate, summarize statistics, find trends/segments/comparisons, render chart types, build dashboards/reports/slides, edit charts in natural language, export to many formats. Heavy compute runs **in the sandbox** (Python: pandas/polars/duckdb), never in the API/renderer.

## 6.1 Pipeline & state machine

```
load → profile → clean → analyze → visualize → assemble → export
```

```
LOADED ─profile─► PROFILED ─clean(approved if destructive)─► CLEANED
   └────────────────────────► ANALYZED ─► VISUALIZED ─► REPORT|DASHBOARD|DECK
```

| Stage | Tool | What it does | Risk | MVP? |
|---|---|---|---|---|
| Load csv/xlsx | `data.load` | parse → typed `DataFrame` ref (column types inferred) | low | **MVP** (read+profile) |
| Load pdf tables | `data.loadPdfTables` | table-extract (§1) → DataFrame | low | **LATER** |
| Clean | `data.clean` | dedupe, type-coerce, fill/drop NA, trim, normalize | medium (mutates) | **LATER** |
| Profile | `data.profile` | per-column type, null %, cardinality, min/max/mean/quantiles, sample | low | **MVP** |
| Detect missing/broken | `data.validate` | missing cells, broken rows, encoding/parse errors, outliers | low | **MVP** (flags) |
| Stats summary | `data.summary` | descriptive stats, correlations | low | **LATER** |
| Trend | `data.trend` | time-series trend / moving avg / growth | low | **LATER** |
| Segmentation | `data.segment` | group-by / clustering | medium | **LATER** |
| Comparison | `data.compare` | A/B, period-over-period, cohort | low | **LATER** |
| Chart | `data.chart` | bar/line/pie/scatter/heatmap/radar from a `ChartSpec` | low | **LATER** |
| Dashboard | `data.dashboard` | multi-chart layout artifact | medium | **LATER** |
| Report | `artifact.generateReport` | narrative + charts + tables | medium | **MVP-lite** (text+table) |
| Slides | → §5 | charts into deck | medium | **LATER** |
| NL chart editing | `data.editChart` | "make it a line chart, color by region" → mutate `ChartSpec` | low | **LATER** |
| Export | `data.export` | png/pdf/pptx/html/csv/xlsx | medium | **MVP** (csv/xlsx/png) |

## 6.2 ChartSpec (declarative, NL-editable, renderer-agnostic)

```typescript
interface ChartSpec {
  id: string;
  kind: 'bar' | 'line' | 'pie' | 'scatter' | 'heatmap' | 'radar';
  data: { source: DataFrameRef; transform?: Transform[] };
  encoding: {                       // grammar-of-graphics style
    x?: FieldEnc; y?: FieldEnc; color?: FieldEnc; size?: FieldEnc; theta?: FieldEnc;
  };
  title?: string; theme?: ChartTheme;
}
```

- **NL editing** mutates `ChartSpec` fields (the LLM edits a small typed JSON, not pixels) → deterministic re-render. The spec is stored on the `chart` artifact so edits are versioned/diffable and carry provenance back to the `DataFrame` and source file.
- **Rendering:** server-side render in the sandbox (e.g. Vega/Vega-Lite spec → PNG/SVG via a headless renderer; or a Python plotting lib) so output is a portable image artifact; the web viewer can also render the spec interactively. (Concrete renderer pinned in the dedicated viewer doc; this doc commits the **spec-as-source-of-truth** decision.)

## 6.3 Privacy & cost

- Profiling/stats run **in the sandbox on the full data**; only **aggregates/samples** (not raw private rows) are sent to the model for narration — directly serving "avoid sending unnecessary private data to the model." Row-level data reaches the LLM only if the user opts in for a specific small slice.

---

# 7. Data Provider Registry — **LATER, with MVP-lite freshness seam**

A registry of external data sources (market/financial/social/news/economic/company) the agent can pull from, with health checks, caching, rate limits, freshness display, reliability levels, and an **official-source verification warning**.

## 7.1 Provider definition

A `DataProvider` is a typed, risk-tagged connector authored like a tool (Zod-validated, key in the encrypted vault). Categories: `market | financial | social | news | economic | company | weather | generic`. Auth kinds: `none | api_key | oauth`.

## 7.2 Capabilities

| Capability | Mechanism | MVP? |
|---|---|---|
| Add provider (key / no-key) | registry entry + encrypted credential | **LATER** |
| Health check | scheduled probe → `health: up/degraded/down` | **LATER** |
| Cache | `ProviderCache` keyed by (provider, query, params) + TTL | **LATER** (freshness seam MVP-lite) |
| Rate limit | per-provider token bucket in Redis | **LATER** |
| Freshness display | `fetchedAt` + `ttl` → "as of HH:MM" badge | **MVP-lite** (on report data) |
| Reliability level | `reliabilityLevel: official/verified/community/experimental` | **LATER** |
| Official-source verification warning | if `reliabilityLevel < verified`, UI + artifact show a **"unofficial source — verify"** banner; written into `Provenance.dataProviderRefs` | **LATER** |

## 7.3 Trust, freshness & safety

- **Reliability is surfaced, not hidden.** Any artifact built on a `community`/`experimental` source carries a visible warning and an audit note. Official-source verification is a **warning**, never a silent claim of truth — aligns with the security-first / no-fake-success rule.
- **Caching respects freshness:** a stale cache hit past TTL triggers a re-fetch (or, if the provider is `down`, returns last-good **with a stale badge** and an audit note — never silently presents stale data as fresh).
- **Rate-limit + health** prevent abuse/ToS violations (hard rule); a `down` provider degrades gracefully and tells the user.
- Keys encrypted at rest, decrypted server-side only, masked in UI/logs (inherited).

---

# 8. Core TypeScript interface sketches

> Sketches only — pin contracts, not implementation. Authored with Zod in `packages/tool-abi` / `packages/db` repos; types here are the inferred shapes. `ArtifactRef`, `RiskLevel`, `SourceRef` reuse the names already in `packages/protocol`.

```typescript
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';   // from packages/protocol

// Where in a source a piece of content came from (drives citations).
type SourceRef =
  | { fileId: string; kind: 'pdfPage';  page: number }
  | { fileId: string; kind: 'sheetCell'; sheet: string; range: string }
  | { fileId: string; kind: 'lineRange'; from: number; to: number }
  | { fileId: string; kind: 'timestamp'; startMs: number; endMs: number }
  | { providerId: string; kind: 'dataProvider'; query: string; fetchedAt: string };

// ---------- FILE SYSTEM ----------
interface FileRecord {
  id: string;
  workspaceId: string;
  projectId?: string;
  taskId?: string;                 // task that ingested it (if any)
  name: string;
  relPath?: string;                // for folder-scan members
  mime: string;
  ext: string;
  sizeBytes: number;
  sha256: string;                  // content hash → dedup + provenance
  source: 'upload' | 'sidecar' | 'artifact' | 'web-download';
  storage: { backend: 'blob' | 'local-fs'; key: string };  // local-fs => bytes never left machine
  status: 'UPLOADED' | 'EXTRACTING' | 'READY' | 'FAILED' | 'QUARANTINED';
  extraction?: {
    pages?: number; sheets?: string[]; hasTables: boolean;
    ocrApplied: boolean; extractionConfidence: 'high' | 'low';
  };
  inMemory: boolean;               // ingested into MemoryStore (consent)
  version: number;
  createdAt: string; deletedAt?: string;
}

interface FileChunk {
  id: string;
  fileId: string;
  workspaceId: string;             // tenancy scope for pgvector filter
  ordinal: number;
  text: string;
  tokenCount: number;
  sourceRef: SourceRef;            // exact origin → citation
  embedding?: number[];            // pgvector; present only if ingested to memory
  embeddingModel?: string;
}

// ---------- ARTIFACTS ----------
type ArtifactType =
  | 'markdown' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'json' | 'html' | 'code'
  | 'zip' | 'screenshot' | 'browser_recording' | 'slide_deck' | 'chart'
  | 'transcript' | 'video_summary';

interface Artifact {
  id: string;
  workspaceId: string;
  projectId?: string;
  type: ArtifactType;
  title: string;
  headVersionId: string;           // current version
  createdByTaskId: string;
  createdAt: string; deletedAt?: string;
}

interface ArtifactVersion {
  id: string;
  artifactId: string;
  versionNumber: number;
  blobKey: string;                 // content-addressed store key
  sha256: string;
  bytes: number;
  parentVersionId?: string;        // edit/rollback lineage
  provenanceId: string;
  createdByStepId?: string;
  createdAt: string;
  editSummary?: string;            // human-readable "what changed"
}

interface Provenance {
  id: string;
  taskId: string;
  sessionId: string;
  stepIds: string[];
  sourceFileRefs: { fileId: string; chunkIds: string[]; sourceRef: SourceRef }[];
  toolInvocationIds: string[];
  providerCalls: {
    provider: string; model: string; promptHash: string;     // hashed, not raw (masking)
    tokensIn: number; tokensOut: number; costUsd: number;
  }[];
  dataProviderRefs: {
    providerId: string; query: string; fetchedAt: string;
    freshnessTtlSec: number; reliabilityLevel: ReliabilityLevel;
  }[];
  parentVersionId?: string;
}

// ---------- DATA PROVIDER ----------
type ReliabilityLevel = 'official' | 'verified' | 'community' | 'experimental';

interface DataProvider {
  id: string;
  workspaceId: string;
  name: string;
  category: 'market' | 'financial' | 'social' | 'news' | 'economic'
          | 'company' | 'weather' | 'generic';
  auth: 'none' | 'api_key' | 'oauth';
  credentialId?: string;           // → encrypted vault (never inlined)
  baseUrl: string;
  reliabilityLevel: ReliabilityLevel;
  isOfficialSource: boolean;       // false => "verify" warning surfaced
  rateLimit: { perMinute: number; burst: number };
  cacheTtlSec: number;
  health: { status: 'up' | 'degraded' | 'down'; lastCheckedAt: string };
  enabled: boolean;
  risk: RiskLevel;
}
```

---

# 9. Library matrix (per format)

> All TS-side; heavy/native libs run **in the sandbox image** (not the API process, not the desktop bundle), consistent with the stack doc's sandbox decision. Concrete pins (versions) live in `infra/docker/sandbox` + each package's manifest.

| Need | Library (primary) | Fallback / notes | Phase |
|---|---|---|---|
| MIME/magic sniff | `file-type` | — | MVP |
| PDF text + per-page | `pdfjs-dist` (text/layout) + `pdf-lib` (manipulate) | `mutool`/`poppler` in sandbox for hard cases | MVP |
| PDF → page images | `pdfjs-dist` render / `pdftoppm` (poppler) | — | MVP |
| PDF tables | `camelot`/`tabula` (Python, sandbox) | heuristic ruling-line parse | MVP |
| OCR | `tesseract.js` (light) / Tesseract in sandbox | provider OCR for scale (LATER) | MVP |
| DOCX | `mammoth` (→ HTML/text) + `docx` (generate) | LibreOffice headless for fidelity | MVP |
| XLSX/CSV parse | `exceljs` (xlsx) + `papaparse` (csv) | `duckdb`/`polars` (sandbox) for big files | MVP |
| HTML clean text | `@mozilla/readability` + `linkedom`/`cheerio` | — | MVP |
| Archive | `yauzl`/`adm-zip` (zip, bomb-guarded) | `7zip` in sandbox (LATER) | MVP |
| Image process/thumbnail/EXIF | `sharp` | — | MVP |
| Code chunking | `tree-sitter` (symbol-aware) | line-window fallback | MVP |
| md → PDF | headless Chromium print (sandbox) | `md-to-pdf` | MVP |
| md → DOCX / DOCX gen | `docx` | LibreOffice convert | MVP-lite |
| Audio/video demux/keyframes | `ffmpeg` (sandbox) | — | LATER |
| ASR (transcription) | whisper-class in sandbox / `AsrProvider` | — | LATER |
| Diarization | `pyannote`-class (sandbox) / provider | — | LATER |
| TTS | `TtsProvider` (abstraction) | — | LATER |
| Image generation/edit | `ImageProvider` (abstraction) + `sharp` compositing | — | LATER |
| Charts | Vega-Lite spec → render (sandbox) | Python plotting | LATER |
| Slides export | `pptxgenjs` (PPTX) + Chromium/LibreOffice (PDF) | — | LATER |
| DataFrame/profiling | `polars`/`pandas` + `duckdb` (sandbox) | — | MVP (profile) / LATER (full) |

---

# 10. Data model (tables & fields)

> New tables added to `packages/db` (Prisma → Postgres 16). All carry `workspaceId` (+ RLS backstop) for tenancy. Vector columns use pgvector. Append-only tables never UPDATE content.

| Table | Key fields | Notes |
|---|---|---|
| `file_record` | `id, workspaceId, projectId, taskId, name, relPath, mime, ext, sizeBytes, sha256, source, storageBackend, storageKey, status, extractionMeta(jsonb), inMemory, version, createdAt, deletedAt` | dedup on `(workspaceId, sha256)`; soft-delete |
| `file_chunk` | `id, fileId, workspaceId, ordinal, text, tokenCount, sourceRef(jsonb), embedding(vector), embeddingModel` | HNSW index on `embedding` filtered by `workspaceId` |
| `artifact` | `id, workspaceId, projectId, type, title, headVersionId, createdByTaskId, createdAt, deletedAt` | head pointer to current version |
| `artifact_version` | `id, artifactId, versionNumber, blobKey, sha256, bytes, parentVersionId, provenanceId, createdByStepId, editSummary, createdAt` | immutable; append-only |
| `provenance` | `id, taskId, sessionId, stepIds(jsonb), sourceFileRefs(jsonb), toolInvocationIds(jsonb), providerCalls(jsonb), dataProviderRefs(jsonb), parentVersionId` | one per artifact version |
| `artifact_comment` | `id, artifactId, versionId, anchor(jsonb), authorId, body, resolvedAt, createdAt` | LATER |
| `share_link` | `id, artifactId, versionId, role, token, expiresAt, masked, createdByUserId, createdAt, revokedAt` | risk-high creation |
| `data_provider` | `id, workspaceId, name, category, auth, credentialId, baseUrl, reliabilityLevel, isOfficialSource, rateLimitJson, cacheTtlSec, healthJson, enabled, risk` | keys → encrypted vault |
| `provider_cache` | `id, providerId, queryKey, params(jsonb), payloadBlobKey, fetchedAt, ttlSec, stale` | freshness + stale badge |
| `dataframe_ref` | `id, workspaceId, sourceFileId, schemaJson, rowCount, storageKey, createdAt` | tabular handle for §6 (sandbox-resident) |
| `design_session` | `id, workspaceId, baseImageId, referenceImageId, regions(jsonb), detectedText(jsonb), createdAt` | LATER (§4) |
| `deck` | `id, workspaceId, artifactId, title, themeJson, slidesJson, version, createdAt` | LATER (§5); JSON = editable source |

> Existing tables reused: `task`, `session`, `step`, `tool_invocation`, `audit_log`, `usage` — provenance & risk/audit hook into these, no duplication.

---

# 11. Folder layout additions

> Extends the monorepo layout in stack doc §34. New packages/modules only.

```
packages/
├─ files/                    # FileRecord/FileChunk logic: detect, extract, chunk, search (orchestrates sandbox jobs)
├─ artifacts/                # Artifact/Version/Provenance domain + diff/rollback + export
├─ media/                    # ImageProvider/TtsProvider/AsrProvider abstractions + transcript/summary builders  (LATER)
├─ data-analysis/            # DataFrame ops, profile/clean/analyze, ChartSpec, render hand-off                  (LATER)
├─ slides/                   # Deck model, outline planner, render→pptx/pdf/web                                   (LATER)
├─ design-view/              # DesignSession, Region (normalized coords), text-element detect                    (LATER)
├─ data-providers/           # DataProvider registry, health, cache, rate-limit, freshness/reliability           (LATER)
└─ tool-abi/  (extend)       # + file.* artifact.* media.* slides.* data.* provider.* tool defs (risk-tagged)

services/
├─ api/  (extend)            # + files, artifacts, data-providers REST modules (presigned, share, delete risk-gate)
└─ worker/ (extend)          # + extract/ocr/transcribe/profile/render/generate BullMQ consumers

infra/docker/
└─ sandbox/  (extend)        # + ffmpeg, tesseract, libreoffice, poppler, python(polars/pandas/duckdb), chromium
```

---

# 12. Consolidated MVP-vs-LATER feature table

| Area | MVP (Phases 0–4) | LATER (Phase 5+) |
|---|---|---|
| **File system** | upload (presigned + sidecar RO), detect, preview, extract-text, chunk, search, pdf page-by-page, table-extract, OCR, zip-extract, folder-scan (RO), csv/xlsx read, **delete (risk-high)**, file→memory + forget (MVP-lite), source-references | full audio/video/tar/7z extract, RW folder writes (Phase 5), rich version history UI |
| **Artifacts** | md/pdf/csv/json/html/code/zip/screenshot types; preview, download, version history, **text diff**, **edit-via-agent (md/code/csv)**, export (md→pdf), **provenance**, rollback, sharing-link (MVP-lite, risk-high) | docx/xlsx full fidelity, deck/chart/transcript/video types, comments, permissions/RBAC, structural diff, browser-recording |
| **Multimedia** | basic image understanding, screenshot/visual analysis | image generation/editing, video understanding, transcription, diarization, TTS, voice-note→task, timestamped summaries |
| **Design view** | (upload only; normalized-coord architecture in place) | region select, per-region instruct, batch, text-element detect/edit, reference image, before/after, version, mobile long-press |
| **Slides** | — | full deck gen from prompt/files/research, themes, visuals, speaker notes, PPTX/PDF/web export, outline edit, single-slide regen, data charts, presenter |
| **Data analysis** | load csv/xlsx, profile, validate (flags), report (text+table, MVP-lite), export csv/xlsx/png | clean, full stats, trend, segmentation, comparison, all chart types, dashboard, NL chart edit, slides export, pdf-table load |
| **Data providers** | freshness/`fetchedAt` display on report data (MVP-lite) | full registry: add (key/no-key), health, cache, rate-limit, reliability levels, official-source warning |

---

# 13. Test scenarios & acceptance criteria

> Per the hard rule, **no module ships "done" without passing tests.** Unit + integration via Vitest; heavy-format extraction via Testcontainers + the sandbox image; contract tests on the new tool defs. Every scenario below is automatable.

## 13.1 File system

- **FS-1 (ingest + dedup).** Upload the same PDF twice. **Accept:** one stored blob (same `sha256`), two `FileRecord`s referencing it; status reaches `READY`; `pages` populated.
- **FS-2 (extraction fidelity).** Ingest a known 10-page PDF with a table. **Accept:** `extractText` returns text for all pages; `pdfPage(7)` returns page-7 text; `extractTables` returns the table as rows; each chunk's `sourceRef` cites the correct page.
- **FS-3 (OCR fallback).** Ingest a scanned (image-only) PDF. **Accept:** `ocrApplied=true`; non-empty text OR `extractionConfidence:'low'` surfaced (never a false-success claim).
- **FS-4 (chunk citations).** Ingest a docx with headings. **Accept:** chunks split on headings; each `FileChunk.sourceRef` resolves to a real location; a generated report's citation links back to the exact chunk.
- **FS-5 (zip safety).** Ingest a zip bomb (high expansion ratio). **Accept:** extraction aborts at the configured ratio with a typed error; no disk exhaustion; audited.
- **FS-6 (folder scan, RO, local-first).** Desktop scan of a folder with cloud disabled. **Accept:** `FileRecord` stubs stream back; **file bytes never leave the machine** (object storage untouched — asserted); ignore-list respected; a write attempt is denied + audited.
- **FS-7 (delete = risk-high).** Agent calls `file.delete`. **Accept:** `approval_request` (risk `high`) emitted; nothing deleted until approve; on approve, blob+chunks+embeddings purged; audited.
- **FS-8 (memory forget).** Ingest-to-memory then `memory.forgetFile`. **Accept:** retrieval returns the file's chunks before, **none** after; embeddings removed; user-scoped.

## 13.2 Artifacts & provenance

- **AR-1 (versioning + immutability).** Generate report, then `artifact.edit`. **Accept:** v1 and v2 both retrievable; v1 unchanged (content-addressed); head = v2.
- **AR-2 (diff).** Diff v1↔v2 of a markdown artifact. **Accept:** unified text diff matches the actual edit.
- **AR-3 (rollback integrity).** Rollback to v1 from v3. **Accept:** a new v4 is created (copy of v1, `parentVersionId=v3`); history is **not** rewritten; audit records the rollback.
- **AR-4 (provenance completeness).** Generate a report from 2 files + a web search. **Accept:** `Provenance` lists both `fileId`s with chunk refs, the search `toolInvocationId`, and ≥1 `providerCalls` entry with token/cost; prompt stored **hashed**, not raw.
- **AR-5 (citations render).** **Accept:** each cited claim in the report links to a resolvable `sourceRef`; clicking opens the exact page/cell/line.
- **AR-6 (share = risk-high + masking).** Create a share link over seeded-secret content. **Accept:** approval gate fires; the shared view **masks** the secret; link expires per `expiresAt`; revoke makes it 404.

## 13.3 Multimedia (LATER)

- **MM-1 (transcript + diarization).** Transcribe a 2-speaker clip. **Accept:** segments with timestamps; ≥2 speaker labels; renaming a speaker re-exports a new transcript version.
- **MM-2 (timestamped summary).** **Accept:** each summary section links to a real transcript segment (`sourceRef`).
- **MM-3 (provider abstraction).** Swap `ImageProvider` implementation in config. **Accept:** `media.generateImage` works against the new provider with **zero** call-site changes; key never in any client bundle.

## 13.4 Design view (LATER)

- **DV-1 (normalized regions).** Define a region via mouse and via simulated long-press. **Accept:** both yield identical `Region.normCoords`; edit applies to the same pixels (proves mobile-ready architecture).
- **DV-2 (batch + text-element edit).** Detect text boxes, batch-edit 3 regions. **Accept:** one new artifact version with 3 region deltas in provenance; before/after slider shows changes.

## 13.5 Slides (LATER)

- **SL-1 (single-slide regen).** Regenerate slide 4 only. **Accept:** only slide 4's JSON changes; new deck version; other slides byte-identical; provenance delta scoped to slide 4.
- **SL-2 (export parity).** Export to PPTX and PDF. **Accept:** both open; slide count + titles + speaker notes match the deck JSON; theme = brand tokens unless overridden.

## 13.6 Data analysis (LATER; CSV/XLSX read MVP)

- **DA-1 (profile + validate).** Load a CSV with missing cells + a broken row. **Accept (MVP):** profile reports per-column null %, types, cardinality; `validate` flags the broken row and missing cells — **without** sending raw rows to the model (only aggregates/sample).
- **DA-2 (NL chart edit).** "Make it a line chart colored by region." **Accept:** `ChartSpec.kind` → `line`, `encoding.color` → region; deterministic re-render; spec versioned with provenance back to the DataFrame.
- **DA-3 (export).** Export a chart png + the cleaned data xlsx. **Accept:** both download; xlsx round-trips column types.

## 13.7 Data providers (LATER; freshness MVP-lite)

- **DP-1 (freshness + stale badge).** Fetch with a short TTL, let it expire, provider `down`. **Accept:** last-good returned **with a stale badge** + audit note; never presented as fresh.
- **DP-2 (reliability warning).** Build a report on a `community` source. **Accept:** artifact + UI show an **"unofficial source — verify"** banner; `Provenance.dataProviderRefs.reliabilityLevel='community'`.
- **DP-3 (rate limit + health).** Exceed the per-minute limit. **Accept:** requests throttled (no ToS violation); `health` reflects `degraded`; user is informed, not silently failed.

## 13.8 Cross-cutting

- **CC-1 (stop mid-job).** Send `stop` during a long video transcription. **Accept:** job aborts within one step boundary; partials discarded or marked partial (never falsely "complete"); task → `STOPPED`; audited.
- **CC-2 (secrets never in frontend).** Build web + desktop bundles; scan. **Accept:** no media/provider/LLM keys in any client artifact; all credential reads are server-side only.
- **CC-3 (heavy work in sandbox).** **Accept:** ffmpeg/tesseract/libreoffice/pandas never run in the API or desktop process; extraction/render execute in the sandbox image (asserted by process boundary).

---

## Acceptance summary (definition of done for this scope)

A feature in this doc is "done" only when: (1) its tool(s) are registered in `packages/tool-abi` with a **risk level**; (2) `high`/`critical` actions gate to **approval** and honor **instant stop**; (3) outputs are `Artifact`s with complete **`Provenance`** and resolvable **source references**; (4) **no secret** reaches the frontend and sensitive data is **masked** in UI/logs/shared views; (5) heavy/untrusted processing runs **in the sandbox** (or the RO sidecar for local-first); and (6) the scenarios in §13 pass in CI. MVP scope is the **bold MVP** rows of §12; everything else is explicitly **LATER (Phase 5+)**, consistent with Appendix A of the scope doc.
