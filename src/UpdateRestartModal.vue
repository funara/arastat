<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppUpdateState, ChangelogEntry } from './shared/update-api'

// Single update surface for the whole app (FR-6): the active update prompt
// (available / downloading / downloaded / error / idle / checking) and the post-restart
// changelog share this one modal, so no second OS window exists.
const promptOpen = ref(false)
const open = ref(false)
const loading = ref(true)
const notesOpen = ref(true)
const manualCheck = ref(false)
const entries = ref<ChangelogEntry[]>([])
const state = ref<AppUpdateState | null>(null)
let stopUpdateState: (() => void) | null = null

const PROMPT_STATUSES = ['available', 'downloading', 'downloaded', 'error']

/** Version the user dismissed; the prompt stays hidden until a newer build. */
const dismissedVersion = ref<string | null>(null)

function showPrompt(next: AppUpdateState | null): void {
  state.value = next
  if (manualCheck.value) {
    promptOpen.value = true
    return
  }
  // A status without a target version has nothing to offer: `error` there means a
  // background check could not reach the feed, and must never open a modal.
  if (!next || !next.availableVersion || !PROMPT_STATUSES.includes(next.status)) {
    promptOpen.value = false
    return
  }
  const version = next.availableVersion
  if (version === dismissedVersion.value) return
  promptOpen.value = true
}

function later(): void {
  manualCheck.value = false
  dismissedVersion.value = state.value?.availableVersion ?? null
  promptOpen.value = false
  void window.araUpdate?.dismiss?.()
}

async function checkNow(): Promise<void> {
  manualCheck.value = true
  dismissedVersion.value = null
  promptOpen.value = true
  const curVer = state.value?.currentVersion || '0.1.0'

  // If already downloaded, let user install immediately
  if (state.value?.status === 'downloaded' && state.value?.availableVersion) {
    return
  }

  state.value = {
    status: 'checking',
    currentVersion: curVer,
  }

  try {
    if (window.araUpdate?.check) {
      await window.araUpdate.check()
      const next = await window.araUpdate.getState()
      state.value = next
    } else {
      setTimeout(() => {
        if (manualCheck.value && state.value?.status === 'checking') {
          state.value = {
            status: 'idle',
            currentVersion: curVer,
          }
        }
      }, 700)
    }
  } catch {
    state.value = {
      status: 'error',
      currentVersion: curVer,
      error: 'Could not connect to the update service.',
    }
  }
}

function primaryAction(): void {
  const status = state.value?.status
  if (status === 'downloaded') void window.araUpdate?.restartAndInstall()
  else if (status === 'idle') later()
  else void window.araUpdate?.download?.()
}

const percent = computed(() => Math.max(0, Math.min(100, Math.round(state.value?.percent ?? 0))))
const targetVersion = computed(() => state.value?.availableVersion ?? '')
const currentVersion = computed(() => state.value?.currentVersion ?? '')
const displayVersion = computed(() => targetVersion.value || currentVersion.value)

const primaryLabel = computed(() => {
  switch (state.value?.status) {
    case 'downloaded':
      return 'Restart & Install'
    case 'error':
      return 'Retry'
    case 'idle':
      return 'Done'
    default:
      return 'Download'
  }
})

interface Seg {
  t: 'b' | 'c' | 'x'
  v: string
}

interface Block {
  kind: 'heading' | 'para' | 'list'
  badge?: string
  text?: string
  items?: Array<{ badge?: string; text: string }>
}

const BADGES: Record<string, string> = {
  new: 'NEW',
  feature: 'NEW',
  feat: 'NEW',
  add: 'NEW',
  fix: 'FIX',
  fixes: 'FIX',
  bug: 'FIX',
  perf: 'PERF',
  performance: 'PERF',
  speed: 'PERF',
  improve: 'IMP',
  improvement: 'IMP',
  update: 'NEW',
  docs: 'DOCS',
  refactor: 'REF',
}

function badgeFor(line: string): { badge?: string; text: string } {
  const m = line.match(/^(\*\*([a-zA-Z0-9_\s-]+)\*\*|\[([a-zA-Z0-9_\s-]+)\]):\s*(.*)$/)
  if (!m) return { text: line }
  const raw = (m[2] || m[3] || '').trim().toLowerCase()
  const label = BADGES[raw]
  return label ? { badge: label, text: m[4] } : { text: `${m[2] || m[3]}: ${m[4]}` }
}

function badgeClass(badge?: string): string {
  switch (badge) {
    case 'NEW':
      return 'is-new'
    case 'FIX':
      return 'is-fix'
    case 'PERF':
      return 'is-perf'
    default:
      return 'is-default'
  }
}

function segments(text: string): Seg[] {
  return text
    .split(/(\*\*.*?\*\*|`.*?`)/g)
    .filter(Boolean)
    .map((part) =>
      part.startsWith('**') && part.endsWith('**')
        ? { t: 'b' as const, v: part.slice(2, -2) }
        : part.startsWith('`') && part.endsWith('`')
          ? { t: 'c' as const, v: part.slice(1, -1) }
          : { t: 'x' as const, v: part },
    )
}

function blocks(body: string): Block[] {
  const out: Block[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue

    // Filter out redundant "What's New in v..." title headings
    if (/^#*\s*what'?s\s+new(?:\s+in\s+v?[\d.]+)?/i.test(line)) continue

    if (line.startsWith('#')) {
      out.push({ kind: 'heading', text: line.replace(/^#+\s*/, '') })
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
      const last = out[out.length - 1]
      const cleanLine = line.replace(/^[-*•]\s*/, '').trim()
      const item = badgeFor(cleanLine)
      if (last?.kind === 'list') last.items!.push(item)
      else out.push({ kind: 'list', items: [item] })
    } else {
      const { badge, text } = badgeFor(line)
      out.push({ kind: 'para', badge, text })
    }
  }
  return out
}

const parsedReleaseBlocks = computed(() => blocks(state.value?.releaseNotes ?? ''))
const hasReleaseNotes = computed(() => parsedReleaseBlocks.value.length > 0)

function formatDate(iso: string): string {
  if (!iso) return ''
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
}

function close(): void {
  open.value = false
}

function openExternal(url: string): void {
  window.open(url, '_blank')
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    if (promptOpen.value) later()
    else if (open.value) close()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  try {
    showPrompt(await window.araUpdate.getState())
    stopUpdateState = window.araUpdate.onUpdateState(showPrompt)
  } catch {
    // updater IPC unavailable: only the changelog path can still run
  }
  try {
    if (!(await window.araUpdate.getJustUpdated())) return
    await window.araUpdate.clearJustUpdated()
    open.value = true
    entries.value = await window.araUpdate.getChangelog()
  } catch {
    // no changelog available: skip the modal silently
  } finally {
    loading.value = false
  }
})

onUnmounted(() => {
  stopUpdateState?.()
  window.removeEventListener('keydown', onKeydown)
})

defineExpose({ checkNow })
</script>

<template>
  <!-- Active Update Prompt Modal -->
  <div v-if="promptOpen" class="modal-backdrop update-backdrop" @click.self="later">
    <div
      class="modal-card update-modal update-prompt-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-prompt-title"
    >
      <div class="modal-header update-header">
        <div class="update-header-left">
          <img src="/icon.png" alt="ARAStat" class="update-app-icon" />
          <h3 id="update-prompt-title" class="update-brand-title">
            <span>ARAStat</span>
            <span class="title-bullet">•</span>
            <span>Release</span>
          </h3>
        </div>
        <button
          class="icon-close-btn"
          type="button"
          title="Dismiss for now (Esc)"
          aria-label="Close"
          @click="later"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="modal-body update-body">
        <!-- Up to Date Card -->
        <div v-if="state?.status === 'idle'" class="update-up-to-date-card">
          <div class="up-to-date-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <div class="up-to-date-info">
            <h4>ARAStat is up to date</h4>
            <p>Version {{ currentVersion || '0.1.0' }} is currently the latest release. No new updates are required.</p>
          </div>
        </div>

        <!-- Checking Card -->
        <div v-else-if="state?.status === 'checking'" class="update-checking-card">
          <div class="checking-icon-spin" aria-hidden="true">
            <svg class="spin-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </div>
          <div class="checking-info">
            <h4>Checking for updates…</h4>
            <p>Connecting to the ARAStat release channel.</p>
          </div>
        </div>

        <!-- Version Transition Stepper (centered, without status pill) -->
        <template v-else>
          <div class="version-transition-card">
            <div class="version-step">
              <span class="version-step-label">Installed</span>
              <span class="version-step-val">v{{ currentVersion || '0.1.0' }}</span>
            </div>
            <div class="version-arrow" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <line x1="4" y1="12" x2="18" y2="12" />
                <polyline points="12 6 18 12 12 18" />
              </svg>
            </div>
            <div class="version-step is-target">
              <span class="version-step-label">Target</span>
              <span class="version-step-val">v{{ targetVersion || displayVersion }}</span>
            </div>
          </div>

          <!-- Progress bar when downloading -->
          <div
            v-if="state?.status === 'downloading'"
            class="update-progress-container"
            role="progressbar"
            :aria-valuenow="percent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="progress-labels">
              <span>Downloading package…</span>
              <span class="percent-val">{{ percent }}%</span>
            </div>
            <div class="update-track">
              <div class="update-bar" :style="{ width: `${percent}%` }"></div>
            </div>
          </div>

          <!-- Error callout if update failed -->
          <div v-else-if="state?.status === 'error'" class="update-error-banner" role="alert">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{{ state?.error || 'The update package could not be downloaded.' }}</span>
          </div>

          <!-- Release Notes Drawer -->
          <div v-if="hasReleaseNotes" class="update-notes-card">
            <button
              type="button"
              class="notes-toggle-bar"
              :aria-expanded="notesOpen"
              @click="notesOpen = !notesOpen"
            >
              <span class="notes-toggle-left">
                <svg
                  class="notes-chevron"
                  :class="{ 'is-expanded': notesOpen }"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                <strong>Release Highlights</strong>
              </span>
              <span class="notes-toggle-hint">{{ notesOpen ? 'Collapse' : 'Expand' }}</span>
            </button>

            <div v-show="notesOpen" class="notes-content-scroll">
              <template v-for="(block, bi) in parsedReleaseBlocks" :key="bi">
                <h4 v-if="block.kind === 'heading'" class="update-heading">{{ block.text }}</h4>
                <p v-else-if="block.kind === 'para'" class="update-para">
                  <span v-if="block.badge" class="update-tag" :class="badgeClass(block.badge)">{{ block.badge }}</span>
                  <template v-for="(seg, si) in segments(block.text ?? '')" :key="si">
                    <strong v-if="seg.t === 'b'">{{ seg.v }}</strong>
                    <code v-else-if="seg.t === 'c'">{{ seg.v }}</code>
                    <template v-else>{{ seg.v }}</template>
                  </template>
                </p>
                <ul v-else class="update-list">
                  <li v-for="(item, ii) in block.items" :key="ii">
                    <span v-if="item.badge" class="update-tag" :class="badgeClass(item.badge)">{{ item.badge }}</span>
                    <template v-for="(seg, si) in segments(item.text)" :key="si">
                      <strong v-if="seg.t === 'b'">{{ seg.v }}</strong>
                      <code v-else-if="seg.t === 'c'">{{ seg.v }}</code>
                      <template v-else>{{ seg.v }}</template>
                    </template>
                  </li>
                </ul>
              </template>
            </div>
          </div>
        </template>
      </div>

      <!-- Single Line Footer with Author Hyperlink -->
      <div class="modal-footer update-footer">
        <div class="updater-attribution">
          <span class="attribution-text">
            ARAStat by
            <a
              href="https://adhirahmadian.id"
              class="author-name-link"
              target="_blank"
              rel="noopener noreferrer"
              title="Visit adhirahmadian.id"
              @click.prevent="openExternal('https://adhirahmadian.id')"
            >Adhi Rahmadian</a>
          </span>
        </div>
        <div class="update-action-group">
          <template v-if="state?.status === 'idle'">
            <button class="btn btn-primary" type="button" @click="later">
              Done
            </button>
          </template>
          <template v-else-if="state?.status === 'checking'">
            <button class="btn btn-secondary update-btn-later" type="button" @click="later">
              Cancel
            </button>
          </template>
          <template v-else>
            <button class="btn btn-secondary update-btn-later" type="button" @click="later">
              Later
            </button>
            <button
              class="btn btn-primary update-btn-primary"
              type="button"
              :disabled="state?.status === 'downloading'"
              @click="primaryAction"
            >
              <svg v-if="state?.status === 'downloaded'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <svg v-else-if="state?.status !== 'downloading'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>{{ state?.status === 'downloading' ? 'Downloading…' : primaryLabel }}</span>
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>

  <!-- Post-Restart Changelog Modal -->
  <div v-if="open" class="modal-backdrop update-backdrop" @click.self="close">
    <div
      class="modal-card update-modal update-changelog-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="changelog-modal-title"
    >
      <div class="modal-header update-header">
        <div class="update-header-left">
          <img src="/icon.png" alt="ARAStat" class="update-app-icon" />
          <h3 id="changelog-modal-title" class="update-brand-title">
            <span>ARAStat</span>
            <span class="title-bullet">•</span>
            <span>Changelog</span>
          </h3>
        </div>
        <button
          class="icon-close-btn"
          type="button"
          title="Close (Esc)"
          aria-label="Close"
          @click="close"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="modal-body update-body">
        <p v-if="loading" class="update-empty">Loading release notes…</p>
        <p v-else-if="entries.length === 0" class="update-empty">No changelog entries found.</p>
        <template v-else>
          <article v-for="(entry, index) in entries" :key="entry.version || index" class="update-entry">
            <div class="update-entry-head">
              <span class="update-version-tag">v{{ entry.version }}</span>
              <time class="update-date">{{ formatDate(entry.publishedAt) }}</time>
            </div>
            <div class="update-entry-body">
              <template v-for="(block, bi) in blocks(entry.body)" :key="bi">
                <h4 v-if="block.kind === 'heading'" class="update-heading">{{ block.text }}</h4>
                <p v-else-if="block.kind === 'para'" class="update-para">
                  <span v-if="block.badge" class="update-tag" :class="badgeClass(block.badge)">{{ block.badge }}</span>
                  <template v-for="(seg, si) in segments(block.text ?? '')" :key="si">
                    <strong v-if="seg.t === 'b'">{{ seg.v }}</strong>
                    <code v-else-if="seg.t === 'c'">{{ seg.v }}</code>
                    <template v-else>{{ seg.v }}</template>
                  </template>
                </p>
                <ul v-else class="update-list">
                  <li v-for="(item, ii) in block.items" :key="ii">
                    <span v-if="item.badge" class="update-tag" :class="badgeClass(item.badge)">{{ item.badge }}</span>
                    <template v-for="(seg, si) in segments(item.text)" :key="si">
                      <strong v-if="seg.t === 'b'">{{ seg.v }}</strong>
                      <code v-else-if="seg.t === 'c'">{{ seg.v }}</code>
                      <template v-else>{{ seg.v }}</template>
                    </template>
                  </li>
                </ul>
              </template>
            </div>
            <a
              v-if="entry.htmlUrl"
              class="update-link"
              :href="entry.htmlUrl"
              @click.prevent="openExternal(entry.htmlUrl!)"
            >
              <span>GitHub Release Notes</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </article>
        </template>
      </div>

      <div class="modal-footer update-footer">
        <div class="updater-attribution">
          <span class="attribution-text">
            ARAStat by
            <a
              href="https://adhirahmadian.id"
              class="author-name-link"
              target="_blank"
              rel="noopener noreferrer"
              title="Visit adhirahmadian.id"
              @click.prevent="openExternal('https://adhirahmadian.id')"
            >Adhi Rahmadian</a>
          </span>
        </div>
        <button class="btn btn-primary" type="button" @click="close">
          Done
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Modal Framing & Position */
.update-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(9, 13, 22, 0.55);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  padding: 20px;
}

.update-modal {
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  box-shadow: 0 24px 50px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--line);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: updateModalPop 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.update-prompt-card {
  width: min(440px, 94vw);
  max-height: min(520px, 86vh);
}

.update-changelog-card {
  width: min(520px, 94vw);
  max-height: min(600px, 86vh);
}

@keyframes updateModalPop {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(-4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

/* Header */
.update-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-subtle);
  flex-shrink: 0;
}

.update-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.update-app-icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  flex-shrink: 0;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.update-brand-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 700;
  color: var(--ink);
  margin: 0;
  line-height: 1;
}

.title-bullet {
  color: var(--accent);
  font-size: 13px;
}

/* Modal Body */
.update-body {
  padding: 14px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
}

/* Up-to-Date & Checking Cards */
.update-up-to-date-card,
.update-checking-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border-radius: 8px;
  background: var(--surface-subtle);
  border: 1px solid var(--line);
}

.up-to-date-icon {
  color: var(--ok);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--ok);
}

.checking-icon-spin {
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--line);
}

.up-to-date-info h4,
.checking-info h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  margin: 0 0 2px;
}

.up-to-date-info p,
.checking-info p {
  font-size: 11.5px;
  color: var(--muted);
  margin: 0;
  line-height: 1.45;
}

/* Centered Version Stepper Card */
.version-transition-card {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--surface-subtle);
  border: 1px solid var(--line);
}

.version-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.version-step-label {
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.version-step-val {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  margin-top: 1px;
}

.version-step.is-target .version-step-val {
  color: var(--accent);
  font-weight: 700;
}

.version-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}

/* Progress Bar */
.update-progress-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.progress-labels {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--muted);
}

.percent-val {
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.update-track {
  height: 6px;
  border-radius: 999px;
  background: var(--surface-hover);
  overflow: hidden;
  border: 1px solid var(--line);
}

.update-bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}

.spin-icon {
  animation: updateSpin 1.2s linear infinite;
}

@keyframes updateSpin {
  100% {
    transform: rotate(360deg);
  }
}

/* Error Callout */
.update-error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn);
  color: var(--warn);
  font-size: 12px;
}

/* Release Highlights Card */
.update-notes-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-subtle);
  overflow: hidden;
}

.notes-toggle-bar {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--ink);
  font-size: 12px;
  transition: background 0.12s ease;
}

.notes-toggle-bar:hover {
  background: var(--surface-hover);
}

.notes-toggle-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.notes-chevron {
  color: var(--accent);
  transition: transform 0.18s ease;
}

.notes-chevron.is-expanded {
  transform: rotate(180deg);
}

.notes-toggle-hint {
  font-size: 10.5px;
  color: var(--muted);
}

.notes-content-scroll {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--line);
  max-height: 160px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.update-heading {
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-secondary);
  margin-top: 4px;
}

.update-para,
.update-list {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink);
  margin: 0;
}

.update-list {
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.update-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.update-tag.is-new {
  background: var(--accent-soft);
  color: var(--accent);
}

.update-tag.is-fix {
  background: var(--warn-bg);
  color: var(--warn);
}

.update-tag.is-perf {
  background: var(--surface-hover);
  color: var(--ok);
}

.update-tag.is-default {
  background: var(--surface-hover);
  color: var(--muted);
}

.notes-content-scroll code,
.update-entry-body code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--surface-hover);
  border-radius: 4px;
  padding: 0 4px;
}

/* Changelog Articles */
.update-entry {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-subtle);
}

.update-entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.update-version-tag {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--accent);
  font-family: var(--font-mono);
}

.update-date {
  font-size: 11px;
  color: var(--muted);
}

.update-entry-body {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.update-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
  margin-top: 4px;
}

.update-link:hover {
  text-decoration: underline;
}

.update-empty {
  color: var(--muted);
  font-size: 12.5px;
  text-align: center;
  padding: 24px 0;
}

/* Single-Line Footer & Author Hyperlink */
.update-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px;
  border-top: 1px solid var(--line);
  background: var(--surface-subtle);
  flex-shrink: 0;
}

.updater-attribution {
  display: flex;
  align-items: center;
}

.attribution-text {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.author-name-link {
  color: var(--accent);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2.5px;
  transition: opacity 0.12s ease;
}

.author-name-link:hover {
  opacity: 0.8;
}

.update-action-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.update-btn-later {
  padding: 5px 12px;
  font-size: 12px;
}

.update-btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  font-size: 12px;
  font-weight: 600;
}
</style>
