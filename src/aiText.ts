// Pure AI-chat text helpers (no Vue/store imports, so node tests can import this).

/**
 * Detach trailing prose jammed onto a single-line bullet.
 * Model output sometimes packs a list and its follow-up sentence on one line:
 *   "- Variables: 8 - ... performance_rating To get started, ..."
 * Known column names locate the cut: the last whole-token column name followed
 * by " <Capital>" ends the list; the rest becomes its own paragraph.
 * Returns [listPart, prosePart | null]; input untouched when no clean cut exists.
 */
export function splitTrailingProse(item: string, columnNames: string[]): [string, string | null] {
  if (!item.includes(' - ')) return [item, null]
  let cut = -1
  for (const name of columnNames) {
    if (!name) continue
    let from = 0
    for (;;) {
      const i = item.indexOf(name, from)
      if (i < 0) break
      from = i + name.length
      const before = i === 0 ? '' : (item[i - 1] ?? '')
      const after = item.slice(i + name.length)
      if (!/[A-Za-z0-9_]/.test(before) && /^ [A-Z]/.test(after)) {
        cut = Math.max(cut, i + name.length)
      }
    }
  }
  if (cut < 0) return [item, null]
  const prose = item.slice(cut).trim()
  if (!prose) return [item, null]
  return [item.slice(0, cut).trimEnd(), prose]
}

/**
 * Detach a first bullet jammed onto its intro line.
 * Model output sometimes ends the intro and starts the list on one line:
 *   "Here are the viable tests: - **Compare groups ...**"
 * which the list parser reads as a paragraph, leaving the first point stuck
 * in the prose while the rest render as bullets.
 * A colon followed by " - " unambiguously opens a list, so split there into
 * [intro, "- bullet"]. Lines already starting as bullets, tables, headings,
 * quotes, dividers, or fences stay untouched.
 */
export function splitLeadingBullet(line: string): string[] {
  const t = line.trim()
  if (!t) return [line]
  if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) return [line]
  if (t.startsWith('|') || t.startsWith('#') || t.startsWith('>') || t.startsWith('```')) return [line]
  if (t === '---' || t === '***' || t === '___') return [line]
  const m = /:\s*-\s+(\S[\s\S]*)$/.exec(line)
  if (!m) return [line]
  const intro = line.slice(0, m.index + 1).trimEnd()
  const rest = (m[1] ?? '').trim()
  if (!intro || !rest) return [line]
  return [intro, `- ${rest}`]
}
