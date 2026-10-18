// HTML results export: a renderer-built standalone document from the run
// store. Saved through the existing file:save + file:writeBytes calls.
import { fmtCell, fmtP, isPColumn, isSig } from './format.ts'
import type { Run } from './results.ts'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cellHtml(v: unknown, header: string): string {
  if (isPColumn(header) && typeof v === 'number') {
    const star = isSig(v) ? ' *' : ''
    return `<td>${esc(fmtP(v))}${star}</td>`
  }
  return `<td>${esc(fmtCell(v))}</td>`
}

export function buildResultsHtml(runs: Run[], generatedAt: string): string {
  const blocks = runs.map((run) => {
    const parts: string[] = [`<h2>${esc(run.title)}</h2>`, `<p class="desc">${esc(run.analysisId)}, ${runs.length ? '' : ''}missing policy ${esc(run.missingPolicy)}.</p>`]
    for (const el of run.elements) {
      if (el.kind === 'table') {
        const head = el.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')
        const body = el.rows.map((row) => {
          const cells = row.map((v, i) => {
            const h = el.columns[i] ?? ''
            if (i === 0 && typeof v === 'string') return `<th scope="row">${esc(v)}</th>`
            return cellHtml(v, h)
          }).join('')
          return `<tr>${cells}</tr>`
        }).join('')
        const notes = el.footnotes.map((f) => `<p class="note">${esc(f)}</p>`).join('')
        const starred = el.columns.some((c, i) => isPColumn(c) && el.rows.some((r) => isSig(r[i])))
        parts.push(
          `<table><caption>${esc(el.caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
          (starred ? '<p class="note">* p &lt; .05.</p>' : '') + notes
        )
      } else if (el.kind === 'note') {
        parts.push(`<p class="note">${esc(el.text)}</p>`)
      } else if (el.kind === 'chart' && el.svg) {
        parts.push(el.svg)
      } else if (el.kind === 'chart') {
        parts.push(`<p class="note">${esc(el.caption)}</p>`)
      } else if (el.kind === 'error') {
        parts.push(`<p class="error">${esc(el.userMessage)}</p>`)
      }
    }
    return `<section>${parts.join('')}</section>`
  }).join('\n')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ARAStat results</title>
<style>
body { font-family: "Segoe UI", sans-serif; font-size: 13px; color: #2a2926; max-width: 72ch; margin: 24px auto; padding: 0 16px; }
table { border-collapse: collapse; margin: 12px 0; font-variant-numeric: tabular-nums; }
caption { text-align: left; font-weight: 600; padding-bottom: 4px; }
th, td { border-top: 1px solid #2a2926; border-bottom: 1px solid #2a2926; padding: 3px 10px; text-align: right; }
thead th { border-top-width: 2px; border-bottom-width: 1px; }
tbody th { text-align: left; font-weight: 400; }
.note, .desc { color: #6a665e; font-size: 12px; }
.error { color: #8c2f2f; }
</style>
</head>
<body>
<h1>ARAStat results</h1>
<p class="desc">Generated ${esc(generatedAt)}.</p>
${blocks || '<p class="desc">No results.</p>'}
</body>
</html>
`
}

// APA 7th clipboard fragment (§10): Word/Docs/LibreOffice drop <style> blocks on
// paste, so every rule is inline. No <html>/<head> wrapper - the fragment is what
// the clipboard consumer splices into its own document.
const APA_TABLE_STYLE = 'border-collapse:collapse;border-top:1.5pt solid #000000;border-bottom:1.5pt solid #000000;'
const APA_HEAD_STYLE = 'border-bottom:1pt solid #000000;border-left:none;border-right:none;padding:2pt 6pt;'
const APA_CELL_STYLE = 'border-left:none;border-right:none;padding:2pt 6pt;'

// APA 7th italicises these symbols wherever they head a column.
const APA_ITALIC_HEADERS: Record<string, string> = {
  t: '<em>t</em>', F: '<em>F</em>', p: '<em>p</em>', df: '<em>df</em>',
  M: '<em>M</em>', SD: '<em>SD</em>', r: '<em>r</em>', R: '<em>R</em>', 'R²': '<em>R</em>²',
}

type ApaTable = Extract<Run['elements'][number], { kind: 'table' }>

function apaCell(v: unknown, header: string, first: boolean): string {
  if (first && typeof v === 'string') {
    return `<th scope="row" style="${APA_CELL_STYLE}text-align:left;">${esc(fmtCell(v))}</th>`
  }
  const body = isPColumn(header) && typeof v === 'number'
    ? `${esc(fmtP(v))}${isSig(v) ? ' *' : ''}`
    : esc(fmtCell(v))
  return `<td style="${APA_CELL_STYLE}">${body}</td>`
}

// Same "Note. ..." line the pane renders: strip the engine's own prefix, then
// append the significance key when a p column earned a star.
function apaNote(el: ApaTable): string {
  const parts = el.footnotes.map((f) => f.replace(/^Note\.\s*/, ''))
  const starred = el.columns.some((c, i) => isPColumn(c) && el.rows.some((r) => isSig(r[i])))
  if (starred) parts.push('* p < .05.')
  return parts.join(' ')
}

/** APA 7th HTML fragment for the clipboard: caption + 3-line table + Note. line. */
export function buildApaClipboardHtml(runs: Run[]): string {
  const parts: string[] = []
  let n = 0
  for (const run of runs) {
    for (const el of run.elements) {
      if (el.kind === 'table') {
        n++
        const head = el.columns
          .map((c) => `<th scope="col" style="${APA_HEAD_STYLE}">${APA_ITALIC_HEADERS[c.trim()] ?? esc(c)}</th>`)
          .join('')
        const body = el.rows
          .map((row) => `<tr>${row.map((v, i) => apaCell(v, el.columns[i] ?? '', i === 0)).join('')}</tr>`)
          .join('')
        const note = apaNote(el)
        parts.push(
          `<p><strong>Table ${n}</strong><br><em>${esc(el.caption)}</em></p>` +
          `<table style="${APA_TABLE_STYLE}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
          (note ? `<p><em>Note.</em> ${esc(note)}</p>` : '')
        )
      } else if (el.kind === 'note') {
        parts.push(`<p>${esc(el.text)}</p>`)
      }
    }
  }
  return parts.join('\n')
}

/** TSV fallback for editors that ignore text/html; tables separated by a blank line. */
function buildApaClipboardText(runs: Run[]): string {
  const tables: string[] = []
  for (const run of runs) {
    for (const el of run.elements) {
      if (el.kind !== 'table') continue
      const lines = [el.caption, el.columns.join('\t')]
      for (const row of el.rows) lines.push(row.map((v) => fmtCell(v)).join('\t'))
      tables.push(lines.join('\n'))
    }
  }
  return tables.join('\n\n')
}

/** Write both MIMEs so Word/Sheets keep the table layout. UI-free: callers toast. */
export async function copyRunsToClipboard(runs: Run[]): Promise<void> {
  const html = buildApaClipboardHtml(runs)
  const text = buildApaClipboardText(runs)
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ])
    return
  }
  await navigator.clipboard.writeText(text)
}

/** KISS copy path: canonical HTML stays, plain text is derived for clipboard. */
export function buildResultsText(runs: Run[], generatedAt: string): string {
  const lines: string[] = [`ARAStat results`, `Generated ${generatedAt}.`, '']
  for (const run of runs) {
    lines.push(run.title)
    lines.push(`${run.analysisId}, missing policy ${run.missingPolicy}.`)
    for (const el of run.elements) {
      if (el.kind === 'table') {
        lines.push(el.caption)
        lines.push(el.columns.join('\t'))
        for (const row of el.rows) {
          lines.push(row.map((v, i) => {
            const h = el.columns[i] ?? ''
            if (isPColumn(h) && typeof v === 'number') return fmtP(v) + (isSig(v) ? ' *' : '')
            return fmtCell(v)
          }).join('\t'))
        }
        const notes = el.footnotes.map((f) => f.replace(/^Note\.\s*/, '')).join(' ')
        const starred = el.columns.some((c, i) => isPColumn(c) && el.rows.some((r) => isSig(r[i])))
        if (starred || notes) lines.push(`Note. ${[notes, starred ? '* p < .05.' : ''].filter(Boolean).join(' ')}`)
      } else if (el.kind === 'note') {
        lines.push(el.text)
      } else if (el.kind === 'error') {
        lines.push(`Analysis failed. ${el.userMessage}`)
      } else {
        lines.push(el.caption)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}
