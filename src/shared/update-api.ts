// Contract between the update window renderer (update.html) and the shell
// main process. Update-dialog IPC surface:
// get-state / download / install / later + a state-changed push event.

export const UPDATE_CHANNELS = {
  getState: 'update:get-state',
  download: 'update:download',
  install: 'update:install',
  later: 'update:later',
  changed: 'update:changed',
} as const

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface AppUpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  percent?: number
  error?: string
  releaseNotes?: string
}

export interface ChangelogEntry {
  version: string
  title: string
  body: string
  publishedAt: string
  htmlUrl?: string
}

export type UpdatePhase = 'available' | 'downloading' | 'downloaded' | 'error'

/** window copy is owned by the main process */
export interface UpdateUiStrings {
  title: string
  headline: string
  desc: string
  download: string
  later: string
  install: string
  downloading: string
  failed: string
  retry: string
}

export interface UpdateUiState {
  phase: UpdatePhase
  version: string
  currentVersion: string
  /** 0-100, meaningful while downloading */
  percent: number
  /** BCP-47 tag for documentElement.lang */
  lang: string
  /** raw release notes from the feed (may be markdown); empty/absent = hide changelog box */
  notes?: string
  strings: UpdateUiStrings
}

export interface UpdateWindowApi {
  getState(): Promise<UpdateUiState | null>
  download(): void
  install(): void
  later(): void
  onState(handler: (state: UpdateUiState) => void): () => void
}

/** user-selectable update channel; 'stable' maps to the latest.yml feed, 'beta' to beta.yml */
export type UpdateChannel = 'stable' | 'beta'

export function isUpdateChannel(v: unknown): v is UpdateChannel {
  return v === 'stable' || v === 'beta'
}
