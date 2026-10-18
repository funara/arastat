// AI + provider settings: JSON file in the app userData directory.
// Supported providers: 'google' (Google Gemini) and 'custom' (OpenAI-compatible).
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type AiProvider = 'google' | 'custom'

export interface AiSettings {
  provider: AiProvider
  baseUrl: string
  key: string
  model: string
}

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const GOOGLE_DEFAULT_MODEL = 'gemini-3.8-flash'

export const CUSTOM_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const CUSTOM_DEFAULT_MODEL = 'gpt-4o-mini'

export const DEFAULT_SETTINGS: AiSettings = {
  provider: 'google',
  baseUrl: GOOGLE_BASE_URL,
  key: '',
  model: GOOGLE_DEFAULT_MODEL
}

/**
 * Resolve the settings actually sent to the provider.
 * provider='google' pins Google's endpoint and defaults to gemini-3.8-flash;
 * provider='custom' defaults model to gpt-4o-mini.
 */
export function effectiveSettings(settings: AiSettings): AiSettings {
  if (settings.provider === 'google') {
    return {
      provider: 'google',
      baseUrl: settings.baseUrl || GOOGLE_BASE_URL,
      key: settings.key,
      model: settings.model || GOOGLE_DEFAULT_MODEL
    }
  }
  return {
    provider: 'custom',
    baseUrl: settings.baseUrl || CUSTOM_DEFAULT_BASE_URL,
    key: settings.key,
    model: settings.model || CUSTOM_DEFAULT_MODEL
  }
}

/**
 * Masked tail for the renderer's "Saved key" hint: last 4 chars only when the
 * stored key is long enough that the tail reveals nothing meaningful, '' for
 * short keys (never reveal them). The full key never crosses the bridge - this
 * hint is the renderer's only view of it.
 */
export function keyHintFor(key: string): string {
  return key.length >= 8 ? key.slice(-4) : ''
}

export function settingsPath(userDataDir: string): string {
  const primary = join(userDataDir, 'arastat-settings.json')
  const legacy = join(userDataDir, 'ara-stats-settings.json')
  return existsSync(primary) ? primary : existsSync(legacy) ? legacy : primary
}

function clean(raw: unknown): AiSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const provider: AiProvider = r['provider'] === 'custom' ? 'custom' : 'google'
  return {
    provider,
    baseUrl: typeof r['baseUrl'] === 'string' && r['baseUrl']
      ? r['baseUrl']
      : (provider === 'google' ? GOOGLE_BASE_URL : CUSTOM_DEFAULT_BASE_URL),
    key: typeof r['key'] === 'string' ? r['key'] : '',
    model: typeof r['model'] === 'string' && r['model']
      ? r['model']
      : (provider === 'google' ? GOOGLE_DEFAULT_MODEL : CUSTOM_DEFAULT_MODEL)
  }
}

export async function loadSettings(userDataDir: string): Promise<AiSettings> {
  try {
    return clean(JSON.parse(await readFile(settingsPath(userDataDir), 'utf8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(userDataDir: string, patch: Partial<AiSettings>): Promise<AiSettings> {
  const current = await loadSettings(userDataDir)
  const provider: AiProvider = patch.provider === 'custom' ? 'custom' : patch.provider === 'google' ? 'google' : current.provider
  const next: AiSettings = {
    provider,
    baseUrl: typeof patch.baseUrl === 'string' && patch.baseUrl ? patch.baseUrl : current.baseUrl,
    // Empty key means "keep what is stored": the dialog never round-trips the key.
    key: typeof patch.key === 'string' && patch.key ? patch.key : current.key,
    model: typeof patch.model === 'string' && patch.model ? patch.model : current.model
  }
  await mkdir(dirname(settingsPath(userDataDir)), { recursive: true })
  await writeFile(settingsPath(userDataDir), JSON.stringify(next, null, 2), 'utf8')
  return next
}
