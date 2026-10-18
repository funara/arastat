import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, GOOGLE_BASE_URL, GOOGLE_DEFAULT_MODEL, loadSettings, saveSettings } from '../src/main/settings.ts'

test('provider persists across save/load and defaults to google', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ara-settings-'))
  assert.equal((await loadSettings(dir)).provider, 'google')
  assert.equal(DEFAULT_SETTINGS.provider, 'google')
  await saveSettings(dir, { provider: 'custom', key: 'k1' })
  assert.equal((await loadSettings(dir)).provider, 'custom')
  await saveSettings(dir, { provider: 'google' })
  assert.equal((await loadSettings(dir)).provider, 'google')
})

test('unknown provider values keep saved endpoint via custom', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ara-settings-'))
  await saveSettings(dir, { key: 'k1' })
  const { writeFile } = await import('node:fs/promises')
  const { settingsPath } = await import('../src/main/settings.ts')
  await writeFile(settingsPath(dir), JSON.stringify({ provider: 'custom', baseUrl: 'https://provider.example/v1' }), 'utf8')
  const loaded = await loadSettings(dir)
  assert.equal(loaded.provider, 'custom')
  assert.equal(loaded.baseUrl, 'https://provider.example/v1')
})

test('effectiveSettings passes google and custom through', async () => {
  const { effectiveSettings } = await import('../src/main/settings.ts')
  const google = effectiveSettings({ provider: 'google', baseUrl: '', key: 'k', model: '' })
  assert.equal(google.provider, 'google')
  assert.equal(google.baseUrl, GOOGLE_BASE_URL)
  assert.equal(google.model, GOOGLE_DEFAULT_MODEL)
  const custom = effectiveSettings({ provider: 'custom', baseUrl: 'https://provider.example/v1', key: 'k', model: 'm' })
  assert.equal(custom.baseUrl, 'https://provider.example/v1')
  assert.equal(custom.model, 'm')
})
