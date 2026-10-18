import { app, webContents } from 'electron'
import type { BrowserWindow } from 'electron'
import eupdater from 'electron-updater'
const { autoUpdater } = eupdater
import type { UpdateInfo } from 'electron-updater'
import { join } from 'node:path'
import type { AppUpdateState, ChangelogEntry, UpdateChannel } from '../shared/update-api'
import { readAppSettings, writeAppSetting } from './app-settings'
/**
 * Full-package auto-update over the generic provider (ARASTAT_UPDATE_URL).
 *
 * The release pipeline publishes `latest.yml` + the versioned installer to
 * the update channel prefix; electron-builder bakes that URL into
 * resources/app-update.yml from the `publish` config in electron-builder.cjs.
 * The URL itself is injected at build time via the ARASTAT_UPDATE_URL env var
 * and is intentionally not committed to the repo — without it the packaged
 * app has no app-update.yml and auto-update stays disabled.
 *
 * Release notes and the changelog come from the GitHub releases of
 * funara/ara-stats-release; that repo is also the manual-download target for
 * platforms electron-updater cannot service (Linux/other).
 *
 * Dev preview: ARASTAT_FAKE_UPDATE=<version> in an unpacked run opens the
 * window with a simulated download so the UI can be exercised end to end;
 * ARASTAT_FAKE_JUST_UPDATED=1 forces the post-restart changelog modal.
 */

const FIRST_CHECK_DELAY_MS = 5_000
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const GITHUB_OWNER = 'funara'
const GITHUB_REPO = process.env.ARASTAT_GITHUB_REPO || 'arastat'
const UPDATE_STATE_CHANNEL = 'updater:state-changed'

let started = false
let updaterActive = false
let justUpdated = false
let cachedChangelog: ChangelogEntry[] | null = null

const APP_SETTINGS_PATH = () => join(app.getPath('userData'), 'app-settings.json')
export { APP_SETTINGS_PATH }

const stateListeners = new Set<(state: AppUpdateState) => void>()

let currentUpdateState: AppUpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
}

function log(...args: unknown[]): void {
  console.log('[updater]', ...args)
}

function broadcastUpdateState(state: AppUpdateState): void {
  for (const listener of stateListeners) listener(state)
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (!wc.isDestroyed()) {
        wc.send(UPDATE_STATE_CHANNEL, state)
      }
    } catch {
      // ignore webContents errors during teardown
    }
  }
}

export function onUpdateState(listener: (state: AppUpdateState) => void): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export function getAppUpdateState(): AppUpdateState {
  return currentUpdateState
}

export function setAppUpdateState(patch: Partial<AppUpdateState>): void {
  currentUpdateState = { ...currentUpdateState, ...patch }
  broadcastUpdateState(currentUpdateState)
}

export function getJustUpdated(): boolean {
  return justUpdated
}

export function clearJustUpdated(): void {
  justUpdated = false
}

/** Packaged builds on platforms electron-updater cannot service (Linux/other): no auto-update path exists. */
function manualDownloadNotice(): void {
  setAppUpdateState({
    status: 'error',
    error: `Auto-update is not available on this platform. Download the update manually: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
    availableVersion: undefined,
    percent: undefined,
  })
}

export function checkForUpdates(): void {
  if (!updaterActive) {
    if (!app.isPackaged && process.env.ARASTAT_FAKE_UPDATE) {
      triggerFakeUpdate(process.env.ARASTAT_FAKE_UPDATE)
    } else if (app.isPackaged && process.platform !== 'win32' && process.platform !== 'darwin') {
      // no auto-update path exists here: re-assert the manual notice instead of faking a check
      manualDownloadNotice()
    }
    return
  }
  setAppUpdateState({ status: 'checking', error: undefined })
  autoUpdater.checkForUpdates().catch((err: Error) => {
    log('check failed:', err?.message ?? err)
    setAppUpdateState({ status: 'error', error: err?.message ?? String(err) })
  })
}

export function restartAndInstall(): void {
  log('restart and install requested')
  if (!app.isPackaged) {
    log('[dev] fake restart and install')
    setAppUpdateState({ status: 'idle', percent: 100 })
    return
  }
  setImmediate(() => {
    autoUpdater.quitAndInstall(true, true)
  })
}

export async function fetchChangelog(): Promise<ChangelogEntry[]> {
  if (cachedChangelog && cachedChangelog.length > 0) {
    return cachedChangelog
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=10`,
      {
        headers: {
          'User-Agent': 'ARAStat',
          Accept: 'application/vnd.github.v3+json',
        },
      },
    )
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}`)
    }
    const data = (await res.json()) as Array<{
      tag_name?: string
      name?: string
      body?: string
      published_at?: string
      html_url?: string
      draft?: boolean
    }>
    const entries: ChangelogEntry[] = data
      .filter((rel) => !rel.draft)
      .map((rel) => ({
        version: (rel.tag_name ?? rel.name ?? '').replace(/^v/, ''),
        title: rel.name || rel.tag_name || `Version ${(rel.tag_name ?? '').replace(/^v/, '')}`,
        body: rel.body ?? '',
        publishedAt: rel.published_at ?? new Date().toISOString(),
        htmlUrl: rel.html_url,
      }))
    if (entries.length > 0) {
      cachedChangelog = entries
      return entries
    }
  } catch (err) {
    log('failed to fetch changelog from GitHub:', err)
  }
  // Fallback entry if offline or no releases yet
  const fallback: ChangelogEntry[] = [
    {
      version: app.getVersion(),
      title: `v${app.getVersion()}`,
      body: currentUpdateState.releaseNotes || '- Fixes and improvements in this release.',
      publishedAt: new Date().toISOString(),
    },
  ]
  return fallback
}

export function applyUpdateChannel(_channel: UpdateChannel): void {
  // kiss: stable only
  if (!updaterActive) return
  checkForUpdates()
}

export async function initAutoUpdater(
  _getWindow?: () => BrowserWindow | null,
  _initialChannel: UpdateChannel = 'stable',
): Promise<void> {
  if (started) return
  started = true

  // Version bump check for post-restart changelog popup
  try {
    const currentVer = app.getVersion()
    const settings = await readAppSettings(APP_SETTINGS_PATH())
    const lastSeenVer = settings.lastSeenAppVersion
    if (process.env.ARASTAT_FAKE_JUST_UPDATED === '1') {
      justUpdated = true
    } else if (typeof lastSeenVer === 'string' && lastSeenVer !== currentVer) {
      justUpdated = true
    }
    await writeAppSetting(APP_SETTINGS_PATH(), 'lastSeenAppVersion', currentVer)
  } catch (err) {
    log('failed to check lastSeenAppVersion:', err)
  }

  // dev preview with simulated download
  if (!app.isPackaged && process.env.ARASTAT_FAKE_UPDATE) {
    setTimeout(() => {
      triggerFakeUpdate(process.env.ARASTAT_FAKE_UPDATE!)
    }, 2000)
    return
  }

  if (!app.isPackaged) return
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    manualDownloadNotice()
    return
  }

  updaterActive = true
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Enable differential blockmap downloads on Windows NSIS (small patch instead of the full installer)
  autoUpdater.disableDifferentialDownload = false
  autoUpdater.on('checking-for-update', () => {
    log('checking for update...')
    setAppUpdateState({ status: 'checking', error: undefined })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log('update available:', info.version)
    const notes =
      typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n: { note: string | null }) => (typeof n === 'string' ? n : n.note ?? '')).join('\n')
          : undefined
    setAppUpdateState({
      status: 'downloading',
      availableVersion: info.version,
      percent: 0,
      releaseNotes: notes,
    })
  })

  autoUpdater.on('download-progress', (progress: { percent: number }) => {
    setAppUpdateState({
      status: 'downloading',
      percent: Math.round(progress.percent),
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log('update downloaded:', info.version)
    setAppUpdateState({
      status: 'downloaded',
      availableVersion: info.version,
      percent: 100,
    })
  })

  autoUpdater.on('update-not-available', () => {
    log('up to date')
    setAppUpdateState({ status: 'idle' })
  })

  autoUpdater.on('error', (err: Error) => {
    log('updater error:', err?.message ?? err)
    setAppUpdateState({ status: 'error', error: err?.message ?? String(err) })
  })

  setTimeout(() => checkForUpdates(), FIRST_CHECK_DELAY_MS)
  setInterval(() => checkForUpdates(), RECHECK_INTERVAL_MS)
}

function triggerFakeUpdate(version: string): void {
  log('[fake] simulating update for version', version)
  setAppUpdateState({ status: 'checking' })
  setTimeout(() => {
    setAppUpdateState({
      status: 'downloading',
      availableVersion: version,
      percent: 0,
      releaseNotes: `### What's New in v${version}\n- Auto-update flow with in-app changelog\n- Performance improvements\n- Bug fixes across modules`,
    })
    let pct = 0
    const timer = setInterval(() => {
      pct += 15
      if (pct >= 100) {
        clearInterval(timer)
        setAppUpdateState({
          status: 'downloaded',
          availableVersion: version,
          percent: 100,
        })
      } else {
        setAppUpdateState({
          status: 'downloading',
          availableVersion: version,
          percent: pct,
        })
      }
    }, 500)
  }, 1500)
}
