// Contract between the shell and the renderer's update surface
// (UpdateRestartModal.vue). The app has ONE update modal: it handles the active
// prompt and the post-restart changelog, so no second window or channel map
// exists any more.

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface AppUpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  percent?: number
  error?: string
  /** Release notes from the update feed (may be markdown); absent = hide the box. */
  releaseNotes?: string
}

export interface ChangelogEntry {
  version: string
  title: string
  body: string
  publishedAt: string
  htmlUrl?: string
}
