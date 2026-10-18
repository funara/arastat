<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { ChangelogEntry } from '../../shared/update-api'

// Post-restart "just updated" changelog: shown once when the updater flags a
// version bump (or ARASTAT_FAKE_JUST_UPDATED=1 in dev), then cleared so it
// never re-appears for the same launch.
const open = ref(false)
const loading = ref(true)
const entries = ref<ChangelogEntry[]>([])

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
}

function badgeFor(line: string): { badge?: string; text: string } {
  const m = line.match(/^(\*\*([a-zA-Z0-9_\s-]+)\*\*|\[([a-zA-Z0-9_\s-]+)\]):\s*(.*)$/)
  if (!m) return { text: line }
  const raw = (m[2] || m[3] || '').trim().toLowerCase()
  const label = BADGES[raw]
  return label ? { badge: label, text: m[4] } : { text: `${m[2] || m[3]}: ${m[4]}` }
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
    if (line.startsWith('#')) {
      out.push({ kind: 'heading', text: line.replace(/^#+\s*/, '') })
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const last = out[out.length - 1]
      const item = badgeFor(line.slice(2).trim())
      if (last?.kind === 'list') last.items!.push(item)
      else out.push({ kind: 'list', items: [item] })
    } else {
      const { badge, text } = badgeFor(line)
      out.push({ kind: 'para', badge, text })
    }
  }
  return out
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

function close(): void {
  open.value = false
  window.removeEventListener('keydown', onKeydown)
}

function openExternal(url: string): void {
  // the main window's setWindowOpenHandler routes https URLs to the shell browser
  window.open(url, '_blank')
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') close()
}

onMounted(async () => {
  try {
    if (!(await window.araUpdate.getJustUpdated())) return
    await window.araUpdate.clearJustUpdated()
    open.value = true
    window.addEventListener('keydown', onKeydown)
    entries.value = await window.araUpdate.getChangelog()
  } catch {
    // updater IPC unavailable: skip the modal silently
  } finally {
    loading.value = false
  }
})

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="close">
    <div class="modal-card update-modal" role="dialog" aria-modal="true" aria-labelledby="update-modal-title">
      <div class="modal-header">
        <div>
          <div class="update-eyebrow"><span aria-hidden="true">✦</span> ARASTAT</div>
          <h3 id="update-modal-title">ARAStat was updated</h3>
        </div>
        <button class="icon-close-btn" type="button" aria-label="Close" @click="close">&times;</button>
      </div>
      <div class="modal-body">
        <p v-if="loading" class="update-empty">Loading changelog…</p>
        <p v-else-if="entries.length === 0" class="update-empty">No release notes available.</p>
        <template v-else>
          <article v-for="(entry, index) in entries" :key="entry.version || index" class="update-entry">
            <div class="update-entry-head">
              <span class="update-version">v{{ entry.version }}</span>
              <time class="update-date">{{ formatDate(entry.publishedAt) }}</time>
            </div>
            <div class="update-entry-body">
              <template v-for="(block, bi) in blocks(entry.body)" :key="bi">
                <h4 v-if="block.kind === 'heading'" class="update-heading">{{ block.text }}</h4>
                <p v-else-if="block.kind === 'para'" class="update-para">
                  <span v-if="block.badge" class="update-tag" :class="block.badge === 'NEW' ? 'is-new' : 'is-fix'">{{ block.badge }}</span>
                  <template v-for="(seg, si) in segments(block.text ?? '')" :key="si">
                    <strong v-if="seg.t === 'b'">{{ seg.v }}</strong>
                    <code v-else-if="seg.t === 'c'">{{ seg.v }}</code>
                    <template v-else>{{ seg.v }}</template>
                  </template>
                </p>
                <ul v-else class="update-list">
                  <li v-for="(item, ii) in block.items" :key="ii">
                    <span v-if="item.badge" class="update-tag" :class="item.badge === 'NEW' ? 'is-new' : 'is-fix'">{{ item.badge }}</span>
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
              @click.prevent="openExternal(entry.htmlUrl)"
            >GitHub release ↗</a>
          </article>
        </template>
      </div>
      <div class="modal-footer">
        <span class="update-footer-hint">Thanks for using ARAStat</span>
        <button class="btn btn-primary" type="button" @click="close">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.update-modal {
  width: 520px;
  max-width: 100%;
}

.update-eyebrow {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--muted);
}

.update-eyebrow span {
  color: var(--accent);
}

.update-modal h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}

.update-empty {
  color: var(--muted);
  font-size: 13px;
  text-align: center;
  padding: 18px 0;
}

.update-entry {
  display: flex;
  flex-direction: column;
  gap: 10px;
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

.update-version {
  font-size: 13px;
  font-weight: 700;
  color: var(--accent);
}

.update-date {
  font-size: 11.5px;
  color: var(--faint);
}

.update-entry-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.update-heading {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink-secondary);
  margin-top: 4px;
}

.update-para,
.update-list {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ink);
}

.update-list {
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.update-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.update-tag.is-new {
  background: var(--accent-soft);
  color: var(--accent);
}

.update-tag.is-fix {
  background: var(--warn-bg);
  color: var(--warn);
}

.update-entry-body code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: var(--surface-hover);
  border-radius: 4px;
  padding: 0 4px;
}

.update-link {
  align-self: flex-start;
  font-size: 11.5px;
  color: var(--accent);
  text-decoration: none;
}

.update-link:hover {
  text-decoration: underline;
}

.update-footer-hint {
  font-size: 12px;
  color: var(--muted);
}
</style>
