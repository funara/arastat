// Tauri runtime bridge: implements the `window.ara` / `window.araUpdate`
// surfaces the Vue app calls, so no component call site changes. Imported first
// in `main.ts`; installs nothing outside the Tauri WebView.
import { invoke } from '@tauri-apps/api/core'
import type { InvokeArgs } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppUpdateState, ChangelogEntry } from './shared/update-api.ts'
import type { AraApi, AraUpdateApi, AiSettingsPatch, RendererAiSettings } from './shared/bridge-api.ts'

/** Tauri injects this marker into the page before any app script runs. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

interface CallOptions {
  headers: HeadersInit
}

/** Engine/settings rejections arrive as `{ code, message, userMessage, detail }`. */
function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err
  const record = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {}
  const userMessage = typeof record['userMessage'] === 'string' ? record['userMessage'] : ''
  const message = typeof record['message'] === 'string' ? record['message'] : ''
  const error = new Error(userMessage || message || String(err)) as Error & {
    code?: number
    data?: { userMessage?: string; detail?: string }
  }
  if (typeof record['code'] === 'number') error.code = record['code']
  error.data = {
    userMessage: userMessage || undefined,
    detail: typeof record['detail'] === 'string' ? record['detail'] : undefined
  }
  return error
}

async function call<T>(cmd: string, args?: InvokeArgs, options?: CallOptions): Promise<T> {
  try {
    return await invoke<T>(cmd, args, options)
  } catch (err) {
    throw normalizeError(err)
  }
}

/** The unlisten handle arrives asynchronously; callers get a sync disposer. */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let stop: (() => void) | null = null
  let cancelled = false
  void listen<T>(event, (message) => handler(message.payload)).then((unlisten) => {
    // A caller may unsubscribe before `listen` resolves (component unmount, HMR);
    // honour it on arrival instead of leaking the listener.
    if (cancelled) unlisten()
    else stop = unlisten
  })
  return () => {
    cancelled = true
    stop?.()
  }
}

/** Open an http(s) link in the OS browser, never inside the app WebView. */
function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  void call<void>('open_external', { url }).catch((err: unknown) => {
    console.error('[bridge] could not open external link', err)
  })
}

export function installTauriBridge(): void {
  if (!inTauri() || typeof window === 'undefined') return

  // `window.open` is the app's only external-navigation path (the update modal's
  // release link); route it to the OS browser (NFR-2).
  window.open = ((url?: string | URL): Window | null => {
    if (url) openExternal(String(url))
    return null
  }) as typeof window.open

  const ara: AraApi = {
    file: {
      open: (): Promise<string | null> => call<string | null>('file_open'),
      readBytes: (path: string): Promise<ArrayBuffer | null> =>
        call<ArrayBuffer>('file_read_bytes', { path }).catch(() => null),
      save: (defaultPath?: string): Promise<string | null> =>
        call<string | null>('file_save', { defaultPath: defaultPath ?? null }),
      writeBytes: (path: string, bytes: ArrayBuffer): Promise<boolean> =>
        call<boolean>('file_write_bytes', bytes, { headers: { 'x-file-path': encodeURIComponent(path) } })
    },
    engine: {
      invoke: (method: string, params?: unknown): Promise<unknown> =>
        call<unknown>('engine_invoke', { method, params: params ?? null }),
      onNotification: (cb: (note: { method: string; params: unknown }) => void): (() => void) =>
        subscribe('engine:notification', cb)
    },
    ai: {
      chat: (messages: Array<{ role: string; content: string }>): Promise<string> =>
        call<string>('ai_chat', { messages }),
      missingAdvice: (payload: { summary: string }): Promise<string> =>
        call<string>('ai_missing_advice', { payload }),
      getSettings: (): Promise<RendererAiSettings> => call('settings_get'),
      setSettings: (patch: AiSettingsPatch): Promise<RendererAiSettings> =>
        call('settings_set', { patch }),
      listModels: (payload?: { baseUrl?: string; key?: string }): Promise<string[]> =>
        call<string[]>('ai_list_models', { payload: payload ?? null })
    },
    window: {
      minimize: (): Promise<void> => call<void>('window_minimize'),
      toggleMaximize: (): Promise<void> => call<void>('window_toggle_maximize'),
      isMaximized: (): Promise<boolean> => call<boolean>('window_is_maximized'),
      close: (): Promise<void> => call<void>('window_close'),
      onStateChanged: (cb: (maximized: boolean) => void): (() => void) =>
        subscribe('window:stateChanged', cb)
    }
  }

  // The active-update prompt and the post-restart changelog share this one
  // surface; no second window exists (FR-6).
  const araUpdate: AraUpdateApi = {
    getState: (): Promise<AppUpdateState> => call<AppUpdateState>('updater_get_state'),
    restartAndInstall: (): Promise<void> => call<void>('updater_install'),
    getChangelog: (): Promise<ChangelogEntry[]> => call<ChangelogEntry[]>('updater_get_changelog'),
    getJustUpdated: (): Promise<boolean> => call<boolean>('updater_get_just_updated'),
    clearJustUpdated: (): Promise<void> => call<void>('updater_clear_just_updated'),
    onUpdateState: (cb: (state: AppUpdateState) => void): (() => void) =>
      subscribe('updater:state-changed', cb),
    check: (): Promise<void> => call<void>('updater_check'),
    download: (): Promise<void> => call<void>('updater_download'),
    dismiss: (): Promise<void> => call<void>('updater_dismiss')
  }

  window.ara = ara
  window.araUpdate = araUpdate
}

export { inTauri }
