import type { AppUpdateState, ChangelogEntry } from '../shared/update-api'

export {}

declare global {
  interface Window {
    ara: {
      file: {
        open(): Promise<string | null>
        readBytes(path: string): Promise<ArrayBuffer | null>
        save(defaultPath?: string): Promise<string | null>
        writeBytes(path: string, bytes: ArrayBuffer): Promise<boolean>
      }
      engine: {
        invoke(method: string, params?: unknown): Promise<unknown>
        onNotification(cb: (note: { method: string; params: unknown }) => void): () => void
      }
      ai: {
        chat(messages: Array<{ role: string; content: string }>): Promise<string>
        missingAdvice(payload: { summary: string }): Promise<string>
        getSettings(): Promise<{ provider: 'google' | 'custom'; baseUrl: string; key: string; keyHint: string; model: string }>
        setSettings(patch: { provider?: 'google' | 'custom'; baseUrl?: string; key?: string; model?: string }): Promise<{ provider: 'google' | 'custom'; baseUrl: string; key: string; keyHint: string; model: string }>
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
    araUpdate: {
      getState(): Promise<AppUpdateState>
      restartAndInstall(): Promise<void>
      getChangelog(): Promise<ChangelogEntry[]>
      getJustUpdated(): Promise<boolean>
      clearJustUpdated(): Promise<void>
      onUpdateState(cb: (state: AppUpdateState) => void): () => void
    }
  }
}
