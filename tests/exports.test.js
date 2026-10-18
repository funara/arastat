// APA 7th clipboard fragment: inline borders, italic stats headers, XSS escaping.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApaClipboardHtml } from '../src/exports.ts'

function runWith(elements, runId = 'run1') {
  return {
    runId,
    analysisId: 't_test',
    title: 't test',
    spec: {},
    missingPolicy: 'listwise',
    status: 'done',
    elements,
    lastSeq: 1,
    fresh: false,
    createdAt: 0,
    startTime: 0,
    revealed: true,
  }
}

function tableEl(overrides = {}) {
  return {
    address: 'summary',
    status: 'ok',
    kind: 'table',
    caption: 'Means and t test',
    columns: ['Variable', 't', 'df', 'p', 'M', 'SD'],
    rows: [
      ['group a', 2.512, 18, 0.012, 3.4, 1.02],
      ['group b', 1.104, 18, 0.28, 2.9, 1.11],
    ],
    footnotes: ['Note. Higher is better.'],
    ...overrides,
  }
}

test('apa clipboard: inline three-line rules, no vertical borders', () => {
  const html = buildApaClipboardHtml([runWith([tableEl()])])
  assert.ok(html.includes('border-top:1.5pt solid #000000'), html)
  assert.ok(html.includes('border-bottom:1.5pt solid #000000'), html)
  assert.ok(html.includes('border-bottom:1pt solid #000000'), html)
  assert.ok(html.includes('border-left:none;border-right:none'), html)
  // Clipboard fragment, not a document: no head/style block for Word to drop.
  assert.ok(!html.includes('<html') && !html.includes('<style'), html)
})

test('apa clipboard: statistical headers italicized', () => {
  const html = buildApaClipboardHtml([runWith([tableEl()])])
  for (const h of ['t', 'p', 'M', 'SD', 'df']) assert.ok(html.includes(`<em>${h}</em>`), `${h} not italic: ${html}`)
  assert.ok(html.includes('<th scope="col"'), html)
})

test('apa clipboard: escapes caption, footnote and cell text (XSS)', () => {
  const nasty = 'x <script>alert(1)</script> " onmouseover=x'
  const html = buildApaClipboardHtml([runWith([tableEl({
    caption: nasty,
    footnotes: [`Note. ${nasty}`],
    rows: [[nasty, 2.512, 18, 0.012, 3.4, 1.02]],
  })])])
  assert.ok(!html.includes('<script>'), html)
  assert.ok(!html.includes('" onmouseover=x'), 'raw quote survived escaping')
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), html)
  assert.ok(html.includes('&quot; onmouseover=x'), html)
})

test('apa clipboard: Note. footer and * marker follow significance', () => {
  const html = buildApaClipboardHtml([runWith([tableEl()])])
  assert.ok(html.includes('<em>Note.</em> Higher is better. * p &lt; .05.'), html)
  assert.ok(html.includes('.012 *'), `significant p not starred: ${html}`)
  assert.ok(html.includes('.28<'), `non-significant p wrongly starred: ${html}`)
})

test('apa clipboard: tables numbered across runs, notes text passes through', () => {
  const html = buildApaClipboardHtml([
    runWith([tableEl(), { address: 'note:x', status: 'ok', kind: 'note', text: 'A note.' }], 'run1'),
    runWith([tableEl({ caption: 'Second table' })], 'run2'),
  ])
  assert.ok(html.includes('<strong>Table 1</strong>'), html)
  assert.ok(html.includes('<strong>Table 2</strong>'), html)
  assert.ok(html.includes('<p>A note.</p>'), html)
})
