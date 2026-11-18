import { z } from 'zod';
import { join, dirname } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { defineTool } from '@agentos/tool-abi';
import type { Browser, Page } from 'playwright';
import type { RuntimeTool } from './runtime';
import { assertAllowedUrl } from './net-guard';
import { safeResolve } from './fs-tools';
import { evaluateHost, parseHostList, fenceWebContent } from './browser-hardening';

/** TICKET-1: the operator-hardening layer is opt-in; off => byte-identical legacy browser behavior. */
function operatorHardened(): boolean {
  return process.env.BROWSER_OPERATOR_ENABLED === 'true';
}

// Viewport == screencast frame size, so live-view click fractions map 1:1 to page coordinates.
const VIEW_W = 1200;
const VIEW_H = 750;

// Keys a human take-over may press (no OS/devtools combos).
const ALLOWED_KEYS = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Escape',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export interface BrowserToolsOptions {
  headless?: boolean;
  /** Cap on extracted page text returned to the model. */
  maxChars?: number;
  navigationTimeoutMs?: number;
  /** If set, screenshots are written here and the path returned (instead of base64). */
  artifactDir?: string;
  /** If set, a live CDP screencast streams JPEG frames (base64) here for a real-time browser view. */
  onFrame?: (jpegBase64: string) => void;
}

/**
 * A lazily-launched, single-page Playwright session reused across one task's browser tool calls.
 * Chromium only launches on the first call (so tasks that never browse pay nothing), and a clear
 * error surfaces if the browser binary isn't installed (`npx playwright install chromium`).
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private shotCount = 0;
  // Holds the CDP session used for the live screencast so it can be stopped on dispose.
  private screencast: { detach(): Promise<void> } | undefined;
  // Mutex: all page operations (agent AND injected human input) run one-at-a-time so they never
  // interleave mid-action.
  private opLock: Promise<unknown> = Promise.resolve();
  // While the human holds control (set by injected input), the AGENT's actions wait — pause-on-takeover.
  private humanControlUntil = 0;
  private static readonly HUMAN_CONTROL_MS = 15_000;

  constructor(private readonly opts: BrowserToolsOptions = {}) {}

  /** Run an op exclusively (serialized against all other page ops). */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opLock.then(fn, fn);
    this.opLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Block (bounded) while the human is in control, so the agent doesn't fight the user for the page. */
  private async awaitAgentTurn(): Promise<void> {
    while (this.humanControlUntil > Date.now()) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Start a CDP screencast on the page, streaming JPEG frames to opts.onFrame (best-effort). */
  private async startScreencast(page: Page): Promise<void> {
    if (!this.opts.onFrame) return;
    try {
      const client = await page.context().newCDPSession(page);
      this.screencast = client;
      client.on('Page.screencastFrame', (params) => {
        const p = params as { data: string; sessionId: number };
        try {
          this.opts.onFrame?.(p.data);
        } finally {
          void client.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
        }
      });
      await client.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 50,
        maxWidth: VIEW_W,
        maxHeight: VIEW_H,
        everyNthFrame: 2,
      });
    } catch {
      // Screencast is a non-essential live view; never fail a browse because it couldn't start.
      this.screencast = undefined;
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: this.opts.headless ?? true });
    // Fixed viewport == the screencast frame size, so a fractional click on the live frame maps 1:1
    // to a page coordinate for manual take-over.
    const context = await this.browser.newContext({
      viewport: { width: VIEW_W, height: VIEW_H },
      acceptDownloads: true,
    });
    // SSRF guard for EVERY request (navigations, redirects, sub-resources, in-page JS nav): refuse
    // http(s) requests to internal/private addresses; block non-http(s) schemes like file:.
    await context.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      try {
        const u = new URL(reqUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
          return route.abort('accessdenied');
        }
        await assertAllowedUrl(reqUrl);
        return route.continue();
      } catch {
        return route.abort('accessdenied');
      }
    });
    this.page = await context.newPage();
    this.page.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs ?? 30_000);
    await this.startScreencast(this.page);
    return this.page;
  }

  /** Take a screenshot after an action so the UI can show the live browser view (Operator-style).
   * Returns the sandbox-relative filename, or undefined when no artifact dir is configured. */
  private async autoShot(): Promise<string | undefined> {
    if (!this.opts.artifactDir) return undefined;
    const name = `screenshot-${this.shotCount++}.png`;
    const page = await this.ensurePage();
    await page.screenshot({ path: join(this.opts.artifactDir, name), fullPage: false }).catch(() => undefined);
    return name;
  }

  async navigate(url: string): Promise<{ url: string; status: number | null; title: string; screenshot?: string }> {
    // Fail fast before launching/navigating. http(s) is SSRF-guarded; data: is allowed (inert);
    // every other scheme (file:, about:, chrome:, ...) is refused.
    let proto = '';
    try {
      proto = new URL(url).protocol;
    } catch {
      throw new Error(`invalid URL: ${url}`);
    }
    if (proto === 'http:' || proto === 'https:') await assertAllowedUrl(url);
    else if (proto !== 'data:') throw new Error(`refused scheme: ${proto}`);

    await this.awaitAgentTurn();
    return this.runExclusive(async () => {
      const page = await this.ensurePage();
      const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
      const screenshot = await this.autoShot();
      return { url: page.url(), status: res?.status() ?? null, title: await page.title(), ...(screenshot ? { screenshot } : {}) };
    });
  }

  async read(): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
    const page = await this.ensurePage();
    // innerText is computed in the browser, so this avoids referencing the DOM lib from Node code.
    const raw = (await page.innerText('body').catch(() => '')) || '';
    const max = this.opts.maxChars ?? 20_000;
    return {
      url: page.url(),
      title: await page.title(),
      text: raw.slice(0, max),
      truncated: raw.length > max,
    };
  }

  async click(target: { selector?: string; text?: string }): Promise<{ clicked: string; url: string; screenshot?: string }> {
    if (!target.selector && !target.text) throw new Error('provide either a CSS selector or visible text to click');
    await this.awaitAgentTurn();
    return this.runExclusive(async () => {
      const page = await this.ensurePage();
      if (target.selector) {
        await page.click(target.selector, { timeout: 10_000 });
      } else {
        await page.getByText(target.text!, { exact: false }).first().click({ timeout: 10_000 });
      }
      const screenshot = await this.autoShot();
      return { clicked: target.selector ?? target.text ?? '', url: page.url(), ...(screenshot ? { screenshot } : {}) };
    });
  }

  /** Type text into a form field (by CSS selector or visible label), optionally pressing Enter. */
  async type(
    target: { selector?: string; label?: string },
    text: string,
    submit?: boolean,
  ): Promise<{ filled: string; url: string; screenshot?: string }> {
    if (!target.selector && !target.label) throw new Error('provide a CSS selector or a field label to type into');
    await this.awaitAgentTurn();
    return this.runExclusive(async () => {
      const page = await this.ensurePage();
      if (target.selector) {
        await page.fill(target.selector, text, { timeout: 10_000 });
      } else {
        await page.getByLabel(target.label!, { exact: false }).first().fill(text, { timeout: 10_000 });
      }
      if (submit) await page.keyboard.press('Enter').catch(() => undefined);
      const screenshot = await this.autoShot();
      return { filled: target.selector ?? target.label ?? '', url: page.url(), ...(screenshot ? { screenshot } : {}) };
    });
  }

  /** Upload a file (a task artifact, by sandbox-relative path) into a file input on the page. The path
   * is resolved INSIDE the task sandbox via safeResolve, so the agent can only upload its own files. */
  async upload(
    selector: string,
    sandboxRelPath: string,
  ): Promise<{ uploaded: string; url: string; screenshot?: string }> {
    if (!this.opts.artifactDir) throw new Error('file upload needs a task sandbox (artifactDir)');
    const abs = safeResolve(this.opts.artifactDir, sandboxRelPath);
    if (!abs) throw new Error('file path escapes the task sandbox');
    const exists = await stat(abs).then((s) => s.isFile()).catch(() => false);
    if (!exists) throw new Error(`no such file in the task sandbox: ${sandboxRelPath}`);
    await this.awaitAgentTurn();
    return this.runExclusive(async () => {
      const page = await this.ensurePage();
      await page.setInputFiles(selector, abs, { timeout: 10_000 });
      const screenshot = await this.autoShot();
      return { uploaded: sandboxRelPath, url: page.url(), ...(screenshot ? { screenshot } : {}) };
    });
  }

  /** Trigger a download (by clicking a selector or visible text) and save it as a task artifact. */
  async download(
    target: { selector?: string; text?: string },
    timeoutMs = 30_000,
  ): Promise<{ path: string; filename: string; bytes: number; url: string }> {
    const artifactDir = this.opts.artifactDir;
    if (!artifactDir) throw new Error('file download needs a task sandbox (artifactDir)');
    if (!target.selector && !target.text) throw new Error('provide a CSS selector or visible text that triggers the download');
    await this.awaitAgentTurn();
    return this.runExclusive(async () => {
      const page = await this.ensurePage();
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: timeoutMs }),
        target.selector
          ? page.click(target.selector, { timeout: 10_000 })
          : page.getByText(target.text!, { exact: false }).first().click({ timeout: 10_000 }),
      ]);
      // Sanitize the suggested filename to a flat, safe name under downloads/.
      const suggested = download.suggestedFilename() || 'download';
      const safe = suggested.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'download';
      const rel = `downloads/${safe}`;
      const abs = join(artifactDir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await download.saveAs(abs);
      const s = await stat(abs).catch(() => null);
      return { path: rel, filename: safe, bytes: s?.size ?? 0, url: page.url() };
    });
  }

  async screenshot(): Promise<{ path?: string; bytes: number }> {
    const page = await this.ensurePage();
    if (this.opts.artifactDir) {
      const path = join(this.opts.artifactDir, `screenshot-${this.shotCount++}.png`);
      const buf = await page.screenshot({ path, fullPage: false });
      return { path, bytes: buf.byteLength };
    }
    const buf = await page.screenshot({ fullPage: false });
    return { bytes: buf.byteLength };
  }

  // ---- Manual take-over: dispatch the user's live-view input to the page (best-effort) ----

  /** Mark that the human is actively driving — pauses the agent for a short window. */
  private holdHumanControl(): void {
    this.humanControlUntil = Date.now() + BrowserSession.HUMAN_CONTROL_MS;
  }

  /** Click at fractional (0..1) coordinates of the live frame. */
  async inputClick(xFraction: number, yFraction: number): Promise<void> {
    this.holdHumanControl();
    await this.runExclusive(async () => {
      if (!this.page) return;
      const x = Math.max(0, Math.min(1, xFraction)) * VIEW_W;
      const y = Math.max(0, Math.min(1, yFraction)) * VIEW_H;
      await this.page.mouse.click(x, y).catch(() => undefined);
    });
  }

  /** Type text into whatever currently has focus on the page. */
  async inputType(text: string): Promise<void> {
    this.holdHumanControl();
    await this.runExclusive(async () => {
      if (!this.page) return;
      await this.page.keyboard.type(text).catch(() => undefined);
    });
  }

  /** Press a single key. Restricted to a safe allowlist so injected input can't trigger surprises. */
  async inputKey(key: string): Promise<void> {
    if (!ALLOWED_KEYS.has(key)) return;
    this.holdHumanControl();
    await this.runExclusive(async () => {
      if (!this.page) return;
      await this.page.keyboard.press(key).catch(() => undefined);
    });
  }

  async dispose(): Promise<void> {
    await this.screencast?.detach().catch(() => undefined);
    await this.page?.context().close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.screencast = undefined;
    this.page = undefined;
    this.browser = undefined;
  }
}

/** Headless-browser tools (navigate / read / click / screenshot) over a shared session. */
export function createBrowserTools(session: BrowserSession): RuntimeTool[] {
  const navigate: RuntimeTool = {
    definition: defineTool({
      id: 'browser_navigate',
      name: 'browser_navigate',
      description:
        'Open a URL in a browser and return its final URL, status and title. A screenshot of the page ' +
        'is captured automatically (so the user can watch).',
      inputSchema: z.object({ url: z.string().url() }),
      outputSchema: z.object({
        url: z.string(),
        status: z.number().nullable(),
        title: z.string(),
        screenshot: z.string().optional(),
      }),
      riskLevel: 'medium',
      permissions: ['web.read', 'net.request', 'browser.control'],
      timeoutMs: 40_000,
    }),
    run: (input) => {
      const url = (input as { url: string }).url;
      // TICKET-1: operator URL allow/deny policy (complements the always-on SSRF guard in net-guard).
      if (operatorHardened()) {
        let host = '';
        try {
          host = new URL(url).host.toLowerCase();
        } catch {
          /* malformed; net-guard/playwright will reject below */
        }
        const verdict = evaluateHost(host, {
          allow: parseHostList(process.env.BROWSER_URL_ALLOWLIST),
          deny: parseHostList(process.env.BROWSER_URL_DENYLIST),
        });
        if (verdict.effect === 'deny') {
          throw new Error(`browser navigation blocked by operator policy: ${verdict.reason}`);
        }
      }
      return session.navigate(url);
    },
  };

  const read: RuntimeTool = {
    definition: defineTool({
      id: 'browser_read',
      name: 'browser_read',
      description: 'Read the visible text of the current browser page.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        url: z.string(),
        title: z.string(),
        text: z.string(),
        truncated: z.boolean(),
      }),
      riskLevel: 'low',
      permissions: ['web.read'],
      timeoutMs: 20_000,
    }),
    run: async () => {
      const r = await session.read();
      // TICKET-1: fence untrusted page text as DATA before it re-enters the model (prompt-injection
      // mitigation + cookie/token redaction). Off => raw text, exactly as before.
      return operatorHardened() ? { ...r, text: fenceWebContent(r.text) } : r;
    },
  };

  const click: RuntimeTool = {
    definition: defineTool({
      id: 'browser_click',
      name: 'browser_click',
      description:
        'Click an element on the current page by CSS selector or visible text. A screenshot is captured ' +
        'automatically afterwards.',
      inputSchema: z
        .object({ selector: z.string().optional(), text: z.string().optional() })
        .refine((v) => Boolean(v.selector || v.text), 'selector or text is required'),
      outputSchema: z.object({ clicked: z.string(), url: z.string(), screenshot: z.string().optional() }),
      riskLevel: 'medium',
      permissions: ['web.read', 'browser.control'],
      timeoutMs: 20_000,
    }),
    run: (input) => session.click(input as { selector?: string; text?: string }),
  };

  const type: RuntimeTool = {
    definition: defineTool({
      id: 'browser_type',
      name: 'browser_type',
      description:
        'Type text into a form field on the current page — give a CSS selector OR a visible field ' +
        'label. Set submit:true to press Enter after (e.g. to run a search). A screenshot is captured ' +
        'automatically.',
      inputSchema: z
        .object({
          selector: z.string().optional(),
          label: z.string().optional(),
          text: z.string().min(1).max(4_000),
          submit: z.boolean().optional(),
        })
        .refine((v) => Boolean(v.selector || v.label), 'selector or label is required'),
      outputSchema: z.object({ filled: z.string(), url: z.string(), screenshot: z.string().optional() }),
      riskLevel: 'medium',
      permissions: ['web.read', 'browser.control'],
      timeoutMs: 20_000,
    }),
    run: (input) => {
      const v = input as { selector?: string; label?: string; text: string; submit?: boolean };
      const target: { selector?: string; label?: string } = {};
      if (v.selector) target.selector = v.selector;
      if (v.label) target.label = v.label;
      return session.type(target, v.text, v.submit);
    },
  };

  const screenshot: RuntimeTool = {
    definition: defineTool({
      id: 'browser_screenshot',
      name: 'browser_screenshot',
      description: 'Capture a screenshot of the current page (saved as a task artifact).',
      inputSchema: z.object({}),
      outputSchema: z.object({ path: z.string().optional(), bytes: z.number() }),
      riskLevel: 'low',
      permissions: ['web.read', 'browser.control'],
      timeoutMs: 20_000,
    }),
    run: () => session.screenshot(),
  };

  const upload: RuntimeTool = {
    definition: defineTool({
      id: 'browser_upload',
      name: 'browser_upload',
      description:
        'Upload a file into a file input on the current page. Give the input element CSS selector and ' +
        'the path of a task file (a sandbox-relative path, e.g. a file the user attached or one you ' +
        'wrote with a file tool). A screenshot is captured automatically.',
      inputSchema: z.object({
        selector: z.string().min(1),
        path: z.string().min(1).max(1000),
      }),
      outputSchema: z.object({ uploaded: z.string(), url: z.string(), screenshot: z.string().optional() }),
      riskLevel: 'medium',
      permissions: ['web.read', 'browser.control', 'fs.read'],
      timeoutMs: 30_000,
    }),
    run: (input) => {
      const v = input as { selector: string; path: string };
      return session.upload(v.selector, v.path);
    },
  };

  const download: RuntimeTool = {
    definition: defineTool({
      id: 'browser_download',
      name: 'browser_download',
      description:
        'Download a file by clicking the link/button that triggers it (CSS selector OR visible text). ' +
        'The downloaded file is saved as a task artifact and its sandbox-relative path is returned.',
      inputSchema: z
        .object({ selector: z.string().optional(), text: z.string().optional() })
        .refine((v) => Boolean(v.selector || v.text), 'selector or text is required'),
      outputSchema: z.object({
        path: z.string(),
        filename: z.string(),
        bytes: z.number(),
        url: z.string(),
      }),
      riskLevel: 'medium',
      permissions: ['web.read', 'browser.control', 'fs.write'],
      timeoutMs: 40_000,
    }),
    run: (input) => session.download(input as { selector?: string; text?: string }),
  };

  return [navigate, read, click, type, screenshot, upload, download];
}
