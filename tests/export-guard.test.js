// CSV export must neutralize spreadsheet formula injection (OWASP).
import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeCsv } from '../src/io/csv.ts'
import { datasetFromRows } from '../src/io/types.ts'

test('csv export escapes leading formula characters and leaves normal data alone', () => {
  const ds = datasetFromRows(['name'], [['=CMD|/C calc'], ['+1'], ['@SUM(A1)'], ['\tTAB'], ['plain', 'plain']])
  const text = serializeCsv(ds)
  assert.ok(text.includes("'=CMD"), `leading = not escaped: ${text}`)
  assert.ok(text.includes("'+1"), `leading + not escaped: ${text}`)
  assert.ok(text.includes("'@SUM"), `leading @ not escaped: ${text}`)
  assert.ok(text.includes("'\tTAB"), `leading tab not escaped: ${text}`)
  const lines = text.split('\r\n')
  assert.ok(lines.some((l) => l === 'plain'), `plain cell was altered: ${text}`)
})
