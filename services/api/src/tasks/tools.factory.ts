import { Injectable } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadServerEnv } from '@agentos/config';
import {
  ToolRegistryExecutor,
  createFsTools,
  createHttpFetchTool,
  createWebSearchTool,
  createBrowserTools,
  BrowserSession,
  createSandboxTools,
  createCodingTools,
  SandboxSession,
  createWideResearchTool,
  createKnowledgeSearchTool,
  createDeliverableTools,
  createMediaTools,
  createGithubTools,
  createNotionTools,
  createGoogleTools,
  createOutlookTools,
  type OutlookToolApi,
  createPeerTools,
  createDataSourceTools,
  createLocalFsTools,
  createHostingTools,
  type ApprovedFolder,
  type PublishSite,
  type SpawnSubtasks,
  type SearchKnowledge,
  type GenerateImage,
  type GenerateSpeech,
  type GithubToolApi,
  type NotionToolApi,
  type GoogleToolApi,
  type ConsultPeer,
} from '@agentos/tools';
import type { ToolExecutor } from '@agentos/agent-engine';

export interface TaskToolset {
  executor: ToolExecutor;
  /** Release per-task resources (e.g. the headless browser). Always call when the run ends. */
  dispose: () => Promise<void>;
  /** The live browser session, if browsing is enabled — exposed so the UI can take over input. */
  browser?: BrowserSession;
}

/**
 * Provisions the tool set for a single task run. Each task gets its own filesystem sandbox under
 * AGENT_SANDBOX_ROOT (or a temp folder) so file tools can never touch anything outside it, plus an
 * HTTP fetch tool and (unless disabled) lazily-launched headless-browser tools.
 */
@Injectable()
export class ToolsFactory {
  private readonly base: string;
  private readonly browserEnabled: boolean;
  private readonly sandboxEnabled: boolean;
  private readonly sandboxImage: string;
  private readonly persistentWorkspace: boolean;

  constructor() {
    const env = loadServerEnv();
    this.base = env.AGENT_SANDBOX_ROOT ?? join(tmpdir(), 'agentos-sandbox');
    this.browserEnabled = env.ENABLE_BROWSER_TOOLS;
    this.sandboxEnabled = env.ENABLE_SANDBOX;
    this.sandboxImage = env.SANDBOX_IMAGE;
    this.persistentWorkspace = env.ENABLE_PERSISTENT_WORKSPACE;
  }

  create(opts: {
    taskId: string;
    /** The owning workspace — keys the persistent computer's Docker volume (ENABLE_PERSISTENT_WORKSPACE). */
    workspaceId?: string;
    spawnSubtasks?: SpawnSubtasks;
    searchKnowledge?: SearchKnowledge;
    generateImage?: GenerateImage;
    generateSpeech?: GenerateSpeech;
    github?: GithubToolApi;
    notion?: NotionToolApi;
    google?: GoogleToolApi;
    outlook?: OutlookToolApi;
    /** Cross-model peer consultation (brain ⇄ peer, e.g. DeepSeek ⇄ MiMo-VL for vision). */
    consultPeer?: ConsultPeer;
    peerName?: string;
    /** Live browser screencast frames (base64 JPEG) for a real-time browser view in the UI. */
    onBrowserFrame?: (jpegBase64: string) => void;
    /** "My Computer": user-approved host folders the agent may read/write (ENABLE_LOCAL_FS only). */
    localFolders?: ApprovedFolder[];
    /** Static-site hosting: deploy a generated website to a public URL (when a token is configured). */
    publishSite?: PublishSite;
    /** Provision no tools (chat / pure-conversation mode). */
    disableTools?: boolean;
    /**
     * Coding Workspace (TICKET-CODING): provision the code-editing tools over the single real workspace
     * `dir`. When the Docker sandbox is enabled, the SAME `dir` is bind-mounted into a runner at /work so
     * edits === tested files. Only passed when CODING_WORKSPACE_ENABLED (gated by the caller).
     */
    coding?: {
      dir: string;
      checkpoint: (label: string) => Promise<{ ref: string; label: string }>;
      rollback: (ref: string) => Promise<{ ref: string }>;
    };
  }): TaskToolset {
    const root = join(this.base, opts.taskId);
    mkdirSync(root, { recursive: true });

    // Chat mode: a tool-free run. Still give it a sandbox dir (harmless, unused) and a no-op
    // dispose, but provision an empty executor so the model answers purely from its own knowledge.
    if (opts.disableTools) {
      return { executor: new ToolRegistryExecutor([]), dispose: async () => undefined };
    }

    const tools = [
      ...createFsTools({ root, writable: true }),
      createHttpFetchTool(),
      // web_search (Ticket-08): the missing core of a web-research agent — keyless search, results fenced
      // as untrusted. Always on (read-only, low-risk); the agent reads a hit in full via http_fetch/browser.
      createWebSearchTool(),
      // Built-in keyless data sources (World Bank Open Data) for grounded statistics.
      ...createDataSourceTools(),
      // Deliverable generators: real downloadable work products (slides, docs, charts, sites,
      // spreadsheets) written into this task's sandbox under deliverables/.
      ...createDeliverableTools({ root }),
    ];
    // Wide Research: only top-level tasks receive a spawn callback, so sub-agents can't recurse.
    if (opts.spawnSubtasks) tools.push(createWideResearchTool(opts.spawnSubtasks));
    // RAG: agents can search the workspace knowledge base.
    if (opts.searchKnowledge) tools.push(createKnowledgeSearchTool(opts.searchKnowledge));
    // Media generation: only registered when the workspace has a configured provider.
    tools.push(
      ...createMediaTools({
        root,
        ...(opts.generateImage ? { generateImage: opts.generateImage } : {}),
        ...(opts.generateSpeech ? { generateSpeech: opts.generateSpeech } : {}),
      }),
    );
    // GitHub connector tools: only when the workspace has connected a GitHub account.
    if (opts.github) tools.push(...createGithubTools(opts.github));
    // Notion connector tools: only when the workspace has connected a Notion account.
    if (opts.notion) tools.push(...createNotionTools(opts.notion));
    // Google connector tools (Calendar + Drive): only when a Google account is connected.
    if (opts.google) tools.push(...createGoogleTools(opts.google));
    // Outlook (Microsoft 365) connector tools (Mail + Calendar): only when an Outlook account is connected.
    if (opts.outlook) tools.push(...createOutlookTools(opts.outlook));
    // "My Computer": user-approved local folders (only when the host enabled ENABLE_LOCAL_FS).
    if (opts.localFolders && opts.localFolders.length > 0) {
      tools.push(...createLocalFsTools(opts.localFolders));
    }
    // Static-site hosting: only when the workspace has configured a deploy token.
    if (opts.publishSite) tools.push(...createHostingTools({ root, publishSite: opts.publishSite }));
    // Peer consultation: only when the workspace has configured a second (peer) model.
    if (opts.consultPeer) {
      tools.push(
        ...createPeerTools({
          root,
          consultPeer: opts.consultPeer,
          ...(opts.peerName ? { peerName: opts.peerName } : {}),
        }),
      );
    }
    let browser: BrowserSession | undefined;
    if (this.browserEnabled) {
      browser = new BrowserSession({
        headless: true,
        artifactDir: root,
        ...(opts.onBrowserFrame ? { onFrame: opts.onBrowserFrame } : {}),
      });
      tools.push(...createBrowserTools(browser));
    }
    let sandbox: SandboxSession | undefined;
    if (this.sandboxEnabled) {
      // Persistent computer: a per-workspace Docker named volume survives between tasks (opt-in).
      const persistVolume =
        this.persistentWorkspace && opts.workspaceId
          ? `agentos-ws-${opts.workspaceId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`
          : undefined;
      sandbox = new SandboxSession({
        image: this.sandboxImage,
        ...(persistVolume ? { persistVolume } : {}),
      });
      tools.push(...createSandboxTools(sandbox));
    }
    // Coding Workspace: edit tools over the real workspace dir + (when Docker is enabled) a runner whose
    // /work is bind-mounted to that SAME dir, so the agent tests the exact files it edited.
    let codingSession: SandboxSession | undefined;
    if (opts.coding) {
      if (this.sandboxEnabled) {
        codingSession = new SandboxSession({
          image: this.sandboxImage,
          workdir: '/work',
          networkDisabled: true,
          hostMount: { source: opts.coding.dir, target: '/work' },
        });
      }
      tools.push(
        ...createCodingTools({
          root: opts.coding.dir,
          ...(codingSession ? { session: codingSession } : {}),
          checkpoint: opts.coding.checkpoint,
          rollback: opts.coding.rollback,
        }),
      );
    }

    return {
      executor: new ToolRegistryExecutor(tools),
      dispose: async () => {
        await browser?.dispose();
        await sandbox?.dispose();
        await codingSession?.dispose();
      },
      ...(browser ? { browser } : {}),
    };
  }
}
