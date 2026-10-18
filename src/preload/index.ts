import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdateState, ChangelogEntry } from '../shared/update-api'

/**
 * §2 named API: file.open, file.readBytes, engine.invoke.
 * ONE event channel addition: engine.onNotification carries the
 * analysis/update + analysis/done stream (see README [NEW-DECISION]).
 */
contextBridge.exposeInMainWorld('ara', {
  file: {
    open: (): Promise<string | null> => ipcRenderer.invoke('file:open'),
    readBytes: (path: string): Promise<ArrayBuffer | null> => ipcRenderer.invoke('file:readBytes', path),
    save: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('file:save', defaultPath),
    writeBytes: (path: string, bytes: ArrayBuffer): Promise<boolean> => ipcRenderer.invoke('file:writeBytes', path, bytes)
  },
  engine: {
    invoke: (method: string, params?: unknown): Promise<unknown> => ipcRenderer.invoke('engine:invoke', method, params),
    onNotification: (cb: (note: { method: string; params: unknown }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, note: { method: string; params: unknown }): void => cb(note)
      ipcRenderer.on('engine:notification', listener)
      return () => ipcRenderer.removeListener('engine:notification', listener)
    }
  },
  ai: {
    chat: (messages: Array<{ role: string; content: string }>): Promise<string> => ipcRenderer.invoke('ai:chat', messages),
    missingAdvice: (payload: { summary: string }): Promise<string> => ipcRenderer.invoke('ai:missing-advice', payload),
    getSettings: (): Promise<{ provider: 'google' | 'custom'; baseUrl: string; key: string; model: string; keyHint: string }> => ipcRenderer.invoke('settings:get'),
    setSettings: (patch: { provider?: 'google' | 'custom'; baseUrl?: string; key?: string; model?: string }): Promise<{ provider: 'google' | 'custom'; baseUrl: string; key: string; model: string; keyHint: string }> =>
      ipcRenderer.invoke('settings:set', patch),
    listModels: (payload?: { baseUrl?: string; key?: string }): Promise<string[]> =>
      ipcRenderer.invoke('ai:list-models', payload)
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggleMaximize'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    onStateChanged: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, max: boolean): void => cb(max)
      ipcRenderer.on('window:stateChanged', listener)
      return () => ipcRenderer.removeListener('window:stateChanged', listener)
    }
  }
})

// Auto-update surface for the main window (state machine + post-restart
// changelog; the update card window uses the separate update preload).
contextBridge.exposeInMainWorld('araUpdate', {
  getState: async (): Promise<AppUpdateState> => {
    const result: unknown = await ipcRenderer.invoke('updater:get-state')
    return result as AppUpdateState
  },
  restartAndInstall: (): Promise<void> => ipcRenderer.invoke('updater:restart-and-install'),
  getChangelog: async (): Promise<ChangelogEntry[]> => {
    const result: unknown = await ipcRenderer.invoke('updater:get-changelog')
    return (result ?? []) as ChangelogEntry[]
  },
  getJustUpdated: async (): Promise<boolean> => Boolean(await ipcRenderer.invoke('updater:get-just-updated')),
  clearJustUpdated: (): Promise<void> => ipcRenderer.invoke('updater:clear-just-updated'),
  onUpdateState: (cb: (state: AppUpdateState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState): void => cb(state)
    ipcRenderer.on('updater:state-changed', listener)
    return () => ipcRenderer.removeListener('updater:state-changed', listener)
  }
})