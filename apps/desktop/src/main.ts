import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join } from 'node:path';
import { BRAND } from '@agentos/brand';
import { PROTOCOL_VERSION } from '@agentos/protocol';
import {
  APP_SCHEME,
  buildAppUrl,
  registerPrivilegedScheme,
  registerAppProtocol,
} from './protocol/app-protocol';
import { apiConnectSources } from './security/csp';
import { validateRequest, validateResponse } from './ipc/contracts';

// The renderer (app:// origin) talks to the locally-running API over HTTP + WebSocket. Keep the
// origin in sync with the web bundle's NEXT_PUBLIC_API_BASE (both default to localhost:4000).
const API_ORIGIN = process.env.AGENTOS_API_ORIGIN ?? 'http://localhost:4000';
const CONNECT_SRC: string[] = apiConnectSources(API_ORIGIN);

// Privileged scheme must be registered before `ready`.
registerPrivilegedScheme();

function webRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'web')
    : join(__dirname, '..', '..', 'web', 'out');
}

/**
 * Probe the AgentOS API from the MAIN process (not the renderer, so no CSP/connect-src limit and no
 * key handling). Short timeout — a desktop launch must not hang on an unreachable API.
 */
async function checkApiHealth(timeoutMs = 2500): Promise<{ ok: boolean; origin: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_ORIGIN}/health`, { signal: controller.signal });
    return { ok: res.ok, origin: API_ORIGIN };
  } catch {
    return { ok: false, origin: API_ORIGIN };
  } finally {
    clearTimeout(timer);
  }
}

/** Register handlers for ONLY the allowlisted channels — no generic passthrough exists. */
function registerIpc(): void {
  ipcMain.handle('app:getInfo', () =>
    validateResponse('app:getInfo', {
      name: BRAND.appName,
      appId: BRAND.appId,
      protocolVersion: PROTOCOL_VERSION,
    }),
  );

  ipcMain.handle('app:ping', (_event, payload: unknown) => {
    const { at } = validateRequest('app:ping', payload) as { at: number };
    return validateResponse('app:ping', { pong: true, at });
  });

  ipcMain.handle('app:apiStatus', async () =>
    validateResponse('app:apiStatus', await checkApiHealth()),
  );
}

/**
 * Before showing the UI, confirm the API is reachable. If not, surface a clear native prompt instead
 * of a broken-looking app — the user can start the API and retry, open anyway, or quit. Returns true
 * to proceed with launching the window, false to quit.
 */
async function awaitApiOrPrompt(): Promise<boolean> {
  for (;;) {
    if ((await checkApiHealth()).ok) return true;
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: BRAND.appName,
      message: `Can’t reach the ${BRAND.appName} API`,
      detail: `Expected at ${API_ORIGIN}.\n\nStart the AgentOS API, then click Retry.`,
      buttons: ['Retry', 'Open anyway', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) continue; // retry the health check
    return response === 1; // 1 = open anyway, 2 = quit
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    show: false,
    backgroundColor: '#020617',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  // Deny all window.open; route trusted external links to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Cancel any navigation away from our own app:// origin.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`)) {
      event.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => win.show());
  void win.loadURL(buildAppUrl('/'));
  return win;
}

function bootstrap(): void {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  if (process.platform === 'win32') {
    app.setAppUserModelId(BRAND.appId);
  }

  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    registerAppProtocol(webRoot(), CONNECT_SRC);
    registerIpc();

    // Gate the window on API reachability so a launch against a stopped API is explained, not broken.
    if (!(await awaitApiOrPrompt())) {
      app.quit();
      return;
    }
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Register the deep-link scheme (PKCE auth callback wired in a later phase).
  if (!app.isDefaultProtocolClient(BRAND.protocol)) {
    app.setAsDefaultProtocolClient(BRAND.protocol);
  }
}

bootstrap();
