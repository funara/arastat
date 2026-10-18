// The single source of truth for the `window.ara` / `window.araUpdate` bridge.
//
// The Tauri host implements this contract — `src/tauri-bridge.ts` binds it onto
// `window` — and is annotated with these types, so a method the host forgets is
// a `vue-tsc` error rather than a runtime `undefined` in the UI.
import type { AppUpdateState, ChangelogEntry } from './update-api.ts'

/** Provider settings as the renderer sees them: the key never crosses, only a hint. */
export interface RendererAiSettings {
  provider: 'google' | 'custom'
  baseUrl: string
  key: string
  model: string
  /** Last-4 hint of the key stored for each provider, so a tab never claims the other's key. */
  keyHints: { google: string; custom: string }
}

export interface AiSettingsPatch {
  provider?: 'google' | 'custom'
  baseUrl?: string
  key?: string
  model?: string
}

export interface AraApi {
  file: {
    /** Native open dialog; null when the user cancels. */
    open(): Promise<string | null>
    /** Raw bytes as an ArrayBuffer; null when the file cannot be read. */
    readBytes(path: string): Promise<ArrayBuffer | null>
    /** Native save dialog (filters follow the suggested name); null on cancel. */
    save(defaultPath?: string): Promise<string | null>
    /** Write raw bytes to `path`; false when the write failed. */
    writeBytes(path: string, bytes: ArrayBuffer): Promise<boolean>
  }
  engine: {
    /** One NDJSON-RPC request to the statistical engine. */
    invoke(method: string, params?: unknown): Promise<unknown>
    /** Subscribe to `analysis/update` + `analysis/done` pushes; returns a disposer. */
    onNotification(cb: (note: { method: string; params: unknown }) => void): () => void
  }
  ai: {
    chat(messages: Array<{ role: string; content: string }>): Promise<string>
    missingAdvice(payload: { summary: string }): Promise<string>
    getSettings(): Promise<RendererAiSettings>
    setSettings(patch: AiSettingsPatch): Promise<RendererAiSettings>
    listModels(payload?: { baseUrl?: string; key?: string }): Promise<string[]>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    isMaximized(): Promise<boolean>
    close(): Promise<void>
    onStateChanged(cb: (maximized: boolean) => void): () => void
  }
}

export interface AraUpdateApi {
  getState(): Promise<AppUpdateState>
  restartAndInstall(): Promise<void>
  getChangelog(): Promise<ChangelogEntry[]>
  getJustUpdated(): Promise<boolean>
  clearJustUpdated(): Promise<void>
  onUpdateState(cb: (state: AppUpdateState) => void): () => void
  /** Ask the updater to check now (the Tauri host then downloads what it finds). */
  check(): Promise<void>
  /** Fetch the pending update, streaming progress to the modal. */
  download(): Promise<void>
  /** Hide this build's update prompt until a newer build arrives. */
  dismiss(): Promise<void>
}
