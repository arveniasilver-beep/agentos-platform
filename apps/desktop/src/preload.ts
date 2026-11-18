import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload bridge. Exposes ONLY named, explicit methods — never a generic
 * `invoke(channel, …)` passthrough. Each method maps to one allowlisted IPC channel whose
 * payload is Zod-validated in the main process. Runs in a sandboxed context (no Node in renderer).
 */
const bridge = {
  getInfo: (): Promise<unknown> => ipcRenderer.invoke('app:getInfo'),
  ping: (at: number): Promise<unknown> => ipcRenderer.invoke('app:ping', { at }),
  /** Is the AgentOS API reachable? (checked from the main process) */
  apiStatus: (): Promise<unknown> => ipcRenderer.invoke('app:apiStatus'),
};

export type DesktopBridge = typeof bridge;

contextBridge.exposeInMainWorld('desktopBridge', bridge);
