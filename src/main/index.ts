import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SeamClient, type SeamNotification } from './seamClient'
import { chat } from './ai'
import { fallbackAdvice } from './aiResponse.ts'
import { listCustomModels } from './modelCall'
import { loadSettings, saveSettings, keyHintFor, type AiSettings } from './settings'
import {
  checkForUpdates,
  clearJustUpdated,
  fetchChangelog,
  getAppUpdateState,
  getJustUpdated,
  initAutoUpdater,
  onUpdateState,
  restartAndInstall,
  APP_SETTINGS_PATH
} from './updater'
import { showUpdateWindow, pushUpdateState, closeUpdateWindow } from './update-window'
import type { AppUpdateState, UpdatePhase, UpdateUiState } from '../shared/update-api'

const ENGINE_CHANNEL = 'engine:notification'

let win: BrowserWindow | null = null
let engine: ChildProcessWithoutNullStreams | null = null
let seam: SeamClient | null = null



// ---- Auto-update (electron-updater + strong-guidance card + changelog) ----

function updateUiState(state: AppUpdateState): UpdateUiState {
  const phase: UpdatePhase =
    state.status === 'downloading'
      ? 'downloading'
      : state.status === 'downloaded'
        ? 'downloaded'
        : state.status === 'error'
          ? 'error'
          : 'available'
  const version = state.availableVersion ?? state.currentVersion
  return {
    phase,
    version,
    currentVersion: state.currentVersion,
    percent: state.percent ?? 0,
    lang: 'en',
    notes: state.releaseNotes,
    strings: {
      title: 'ARAStat Update',
      headline: 'A new version of ARAStat is available',
      desc: `Version ${version} is ready to install.`,
      download: 'Download',
      later: 'Later',
      install: 'Restart & Install',
      downloading: 'Downloading…',
      failed: state.error ?? 'The update could not be completed.',
      retry: 'Retry'
    }
  }
}

// Version whose update card the user dismissed; it stays hidden until a
// different build arrives (rechecks of the same build re-emit 'downloaded').
let dismissedVersion: string | null = null

function registerUpdateIpc(): void {
  ipcMain.handle('updater:get-state', () => getAppUpdateState())
  ipcMain.handle('updater:restart-and-install', () => restartAndInstall())
  ipcMain.handle('updater:get-changelog', () => fetchChangelog())
  ipcMain.handle('updater:get-just-updated', () => getJustUpdated())
  ipcMain.handle('updater:clear-just-updated', () => clearJustUpdated())
  onUpdateState((state) => {
    if (state.status === 'downloaded') {
      if (state.availableVersion && state.availableVersion === dismissedVersion) return
      showUpdateWindow(win, updateUiState(state), {
        onDownload: () => checkForUpdates(),
        onInstall: () => restartAndInstall(),
        onLater: () => {
          dismissedVersion = state.availableVersion ?? null
          closeUpdateWindow()
        }
      })
    }
    pushUpdateState(updateUiState(state))
  })
}

/**
 * Engine root: the directory holding ara_engine/ (and usually .venv).
 * app.getAppPath() is the entry script's directory - the repo root in dev,
 * <repo>/out/main when running the built bundle, resources/app when packaged
 * (extraResources lands engine at resources/app/engine). Walk the candidates
 * instead of assuming one layout.
 */
function engineRoot(): string | null {
  const candidates = [
    join(app.getAppPath(), 'engine'),
    join(app.getAppPath(), '..', 'engine'),
    join(app.getAppPath(), '..', '..', 'engine'),
    join(process.resourcesPath ?? '', 'app', 'engine'),
    join(process.resourcesPath ?? '', 'engine')
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'ara_engine', '__init__.py'))) return dir
  }
  return null
}

function startEngine(): void {
  const root = engineRoot()
  if (!root) {
    console.error(`[engine] ara_engine not found near ${app.getAppPath()}; engine will not run`)
    return
  }
  const venvPython = join(root, '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
  const python = existsSync(venvPython) ? venvPython : 'python3.12'
  console.log(`[engine] spawning ${python} in ${root}`)
  const child = spawn(python, ['-m', 'ara_engine'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  engine = child
  child.stderr.on('data', (chunk: Buffer) => {
    console.error(`[engine] stderr: ${chunk.toString().trimEnd()}`)
  })
  child.on('error', (error) => {
    console.error(`[engine] spawn error: ${error.message}`)
    seam = null
    engine = null
  })
  child.on('exit', (code) => {
    console.log(`[engine] exited with code ${code}`)
    seam = null
    engine = null
  })
  seam = new SeamClient(child.stdin, child.stdout, (note: SeamNotification) => {
    win?.webContents.send(ENGINE_CHANNEL, note)
  })
}

function createWindow(): void {
  const iconPath = join(app.getAppPath(), 'out', 'renderer', 'icon.png')
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 600,
    show: false,
    ...(process.platform === 'win32' ? { frame: false as const } : {}),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })
  win.on('maximize', () => {
    win?.webContents.send('window:stateChanged', true)
  })
  win.on('unmaximize', () => {
    win?.webContents.send('window:stateChanged', false)
  })
  let showFallback: NodeJS.Timeout | undefined
  const showWindow = (): void => {
    clearTimeout(showFallback)
    showFallback = undefined
    if (!win || win.isDestroyed()) return
    win.maximize()
    win.show()
  }
  win.once('ready-to-show', showWindow)
  showFallback = setTimeout(showWindow, 5000)
  win.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https://') || details.url.startsWith('http://')) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })
  win.on('closed', () => {
    clearTimeout(showFallback)
    showFallback = undefined
    win = null
  })
}

app.whenReady().then(async () => {
  createWindow()
  registerUpdateIpc()
  ipcMain.handle('file:open', async () => {
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'] })
    return canceled ? null : filePaths[0]
  })
  ipcMain.handle('file:readBytes', (_event, path: string) => {
    if (typeof path !== 'string') return null
    return readFile(path).then((bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), () => null)
  })
  ipcMain.handle('file:save', async (_event, defaultPath?: string) => {
    if (!win) return null
    const isHtml = typeof defaultPath === 'string' && defaultPath.toLowerCase().endsWith('.html')
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      ...(typeof defaultPath === 'string' ? { defaultPath } : {}),
      ...(isHtml ? { filters: [{ name: 'HTML', extensions: ['html'] }] } : {})
    })
    return canceled ? null : filePath ?? null
  })
  ipcMain.handle('file:writeBytes', (_event, path: string, bytes: ArrayBuffer) => {
    if (typeof path !== 'string' || !(bytes instanceof ArrayBuffer)) return false
    return writeFile(path, new Uint8Array(bytes)).then(() => true, () => false)
  })
  ipcMain.handle('engine:invoke', (_event, method: string, params: unknown) => {
    // [NEW-DECISION: engine error fields cross the IPC boundary as plain data, never as a
    // custom Error subclass.]
    // Electron marshals rejected values down to name and message, dropping SeamError's
    // code and data. The renderer's error blocks need data.userMessage verbatim, so
    // rejections are re-shaped to {message, code, userMessage, detail} here and read
    // defensively in the renderer (message is the fallback when fields are absent).
    if (!seam) return Promise.reject(new Error('engine not running'))
    return seam.invoke(method, params).catch((err: unknown) => {
      const e = err as { message?: string; code?: number; data?: { userMessage?: string; detail?: string } }
      // message = the user-ready copy: Electron preserves Error.message across invoke while
      // plain objects serialize to "[object Object]". code and data ride along where the
      // boundary keeps them; ResultsPane strips Electron's invoke prefix for display.
      const failure = new Error(e?.data?.userMessage ?? e?.message ?? 'engine error') as Error & { code?: number; data?: unknown }
      failure.code = typeof e?.code === 'number' ? e.code : -1
      failure.data = { userMessage: e?.data?.userMessage, detail: e?.data?.detail }
      return Promise.reject(failure)
    })
  })
  // [NEW-DECISION: AI + settings channels]
  // The AI client lives in main so the provider key never enters the
  // renderer. ai:chat forwards one message list and resolves with the reply
  // text; settings:get/settings:set expose the provider settings held in a
  // JSON file under app.getPath('userData').
  ipcMain.handle('ai:chat', async (_event, messages: unknown) => {
    try {
      const settings = await loadSettings(app.getPath('userData'))
      return await chat(settings, messages)
    } catch (err) {
      const e = err as { userMessage?: string; message?: string }
      return Promise.reject(new Error(e?.userMessage ?? e?.message ?? 'The AI service is unavailable.'))
    }
  })
  // [NEW-DECISION: AI missing-value advice]
  // Never rejects: provider failures resolve to the deterministic
  // offline rule so the caller needs no error branch. Summary is renderer-
  // computed aggregates (profileText counts + missing % + ranges), never raw
  // rows. Tier1 engine reason (if any) arrives inside summary from the
  // renderer via diagnoseColumns; main only does Tier2 narrative (never
  // decides). Key stays in main (loadSettings + chat here).
  ipcMain.handle('ai:missing-advice', async (_event, payload: unknown) => {
    const body = (payload ?? {}) as { summary?: unknown }
    const text = typeof body.summary === 'string' && body.summary.trim() ? body.summary.trim() : 'Missing values were found in the dataset.'
    try {
      const settings = await loadSettings(app.getPath('userData'))
      const advice = await chat(settings, [
        {
          role: 'system',
          content: 'You are ARA Assistant in ARAStat. Recommend exactly one missing-value handling: listwise, pairwise, or fill (mean/median/mode). One short paragraph, no filler. Tier2 narrative only: never decide handling, only explain the aggregate profile. In prose, name grid positions as rows and columns, never cases or variables.'
        },
        { role: 'user', content: text }
      ])
      return advice
    } catch {
      return fallbackAdvice('missing values')
    }
  })
  ipcMain.handle('ai:list-models', async (_event, payload?: { baseUrl?: string; key?: string }) => {
    const settings = await loadSettings(app.getPath('userData'))
    const baseUrl = payload?.baseUrl?.trim() || settings.baseUrl || 'https://api.openai.com/v1'
    const key = payload?.key !== undefined && payload.key !== '' ? payload.key.trim() : settings.key
    return await listCustomModels(baseUrl, key)
  })
  ipcMain.handle('settings:get', async () => {
    const s = await loadSettings(app.getPath('userData'))
    // The key never crosses the bridge; the renderer only ever sees '' plus a
    // masked tail hint computed here from the stored key.
    return { ...s, key: '', keyHint: keyHintFor(s.key) }
  })
  ipcMain.handle('settings:set', async (_event, patch: Partial<AiSettings>) => {
    const s = await saveSettings(app.getPath('userData'), patch ?? {})
    return { ...s, key: '', keyHint: keyHintFor(s.key) }
  })
  ipcMain.handle('window:minimize', () => win?.minimize())
  ipcMain.handle('window:toggleMaximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:isMaximized', () => win?.isMaximized() ?? false)
  ipcMain.handle('window:close', () => win?.close())

  const url = process.env['ELECTRON_RENDERER_URL']
  if (url) win!.loadURL(url)
  else win!.loadFile(join(__dirname, '../renderer/index.html'))
  try {
    startEngine()
  } catch (error) {
    console.error('[engine] failed to start', error)
    engine = null
    seam = null
  }
  void initAutoUpdater()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // SeamClient holds no resources of its own; closing stdin gives the engine
  // its clean EOF shutdown.
  engine?.stdin.end()
  engine = null
  seam = null
})
