// Helpers for userData/app-settings.json — a flat JSON object holding
// cross-cutting app markers (e.g. the updater's lastSeenAppVersion).
// Shape must stay a plain object; values are written read-modify-write.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readAppSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>
    }
  } catch {
    // missing or corrupt file: treat as empty settings
  }
  return {}
}

export async function writeAppSetting(path: string, key: string, value: unknown): Promise<void> {
  const settings = { ...(await readAppSettings(path)), [key]: value }
  await mkdir(dirname(path), { recursive: true })
  // temp file + rename so a crash mid-write cannot truncate the store
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
  await rename(tmp, path)
}

