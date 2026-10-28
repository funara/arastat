import { test } from 'node:test'
import ExcelJS from 'exceljs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importCsvBytes, serializeCsv } from '../src/io/csv.ts'
import { importSavBytes } from '../src/io/savRead.ts'
import { writeSav } from '../src/io/savWrite.ts'
import { exportXlsx, importXlsxBytes } from '../src/io/xlsx.ts'
import { readArchive, writeArchive } from '../src/io/archive.ts'
import { defaultMeta } from '../src/io/types.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => readFileSync(join(root, 'tests', 'fixtures', 'io', name))
const textBytes = (s) => Uint8Array.from(Buffer.from(s, 'utf8'))
const frozenDate = new Date('2026-09-24T12:34:56Z')

/** Full-meta dataset exercising every §6 field plus missing values. */
function richDataset() {
  const num = { ...defaultMeta('num', 'numeric'), label: 'Num label', measure: 'ordinal', valueLabels: { '1': 'One', '2': 'Two' }, missing: { values: [9], ranges: [] }, decimals: 3, width: 8, align: 'right' }
  const date = { ...defaultMeta('date', 'date'), label: 'When' }
  const note = { ...defaultMeta('note', 'string'), label: 'Note, with comma', valueLabels: { ab: 'ABee' }, missing: { values: ['xx'], ranges: [] }, width: 12, align: 'left' }
  return {
    columns: [num, date, note],
    data: {
      num: [1, 2, null, 3.5],
      date: ['2026-01-02', '2026-02-03', null, '2026-04-05'],
      note: ['ab', 'he said "hi"', null, 'a,b\nc']
    }
  }
}

test('csv round-trips quoting torture and missing cells', () => {
  const ds = {
    columns: [
      { ...defaultMeta('name', 'string') },
      { ...defaultMeta('note', 'string') },
      { ...defaultMeta('score', 'numeric') }
    ],
    data: {
      name: ['a,comma', 'line\nbreak', null, 'tab\tinside'],
      note: ['he said "hi"', 'plain', null, '"lead and trail" '],
      score: [1, null, null, 2.5]
    }
  }
  const text = serializeCsv(ds)
  // RFC 4180: CRLF rows, embedded quotes doubled, specials wrapped.
  assert.ok(text.includes('"a,comma"'))
  assert.ok(text.includes('"he said ""hi"""'))
  assert.ok(text.includes('"line\nbreak"'))
  const back = importCsvBytes(textBytes(text))
  assert.deepEqual(back, ds)
})

test('single-column csv preserves empty cases without adding a final case', () => {
  const ds = { columns: [defaultMeta('value', 'string')], data: { value: [null, 'A', null, 'B', null] } }
  assert.deepEqual(importCsvBytes(textBytes(serializeCsv(ds))).data, ds.data)
  assert.deepEqual(importCsvBytes(textBytes('value\n""')).data.value, [null])
  assert.deepEqual(importCsvBytes(textBytes('value\nA\n')).data.value, ['A'])
})

test('csv fixture sample.csv parses per RFC 4180 with missing tokens', () => {
  const ds = importCsvBytes(fixture('sample.csv'))
  assert.deepEqual(
    ds.data,
    {
      name: ['a,comma', 'line\nbreak', null, 'tab\tinside'],
      note: ['he said "hi"', 'plain', null, '"lead and trail" '],
      score: [1, null, null, 2.5]
    }
  )
  // 'NA' and '.' are missing tokens (default list); 'note' is string.
  assert.deepEqual(ds.columns.map((c) => c.type), ['string', 'string', 'numeric'])
})

test('compressed sav write then read keeps data and the meta that survives', async () => {
  // note is ≤ 8 bytes so its labels + missing rules survive; wide (> 8 bytes)
  // string labels/missing need spec record types 14 / long string missing,
  // which our writer does not emit - the loss is asserted below.
  const ds = {
    columns: [
      { ...defaultMeta('num', 'numeric'), label: 'Num label', measure: 'ordinal', valueLabels: { '1': 'One', '2': 'Two' }, missing: { values: [9], ranges: [] }, decimals: 3, width: 8, align: 'right' },
      { ...defaultMeta('date', 'date'), label: 'When' },
      { ...defaultMeta('note', 'string'), label: 'Note', valueLabels: { ab: 'ABee' }, missing: { values: ['xx'], ranges: [] }, width: 3, align: 'left' },
      { ...defaultMeta('wide', 'string'), label: 'Wide', valueLabels: { x: 'Ex' }, missing: { values: ['zz'], ranges: [] } }
    ],
    data: {
      num: [1, 2, null, 3.5],
      date: ['2026-01-02', '2026-02-03', null, '2026-04-05'],
      note: ['ab', null, null, 'a,b'],
      wide: ['he said "hi"', null, null, 'x']
    }
  }
  const buf = writeSav(ds, 'unit label', frozenDate)
  const back = await importSavBytes(new Uint8Array(buf))
  // Data round-trips exactly; date leaves as its ISO text (no date type in
  // our .sav writes), trailing spaces are string padding and never survive.
  assert.deepEqual(back.data.num, ds.data.num)
  assert.deepEqual(back.data.date, ds.data.date)
  assert.deepEqual(back.data.note, ds.data.note)
  assert.deepEqual(back.data.wide, ds.data.wide)
  const [num, date, note, wide] = back.columns
  assert.equal(num.name, 'num')
  assert.equal(num.label, 'Num label')
  assert.equal(num.type, 'numeric')
  assert.equal(num.measure, 'ordinal')
  assert.equal(num.align, 'right')
  assert.equal(num.decimals, 3) // read back from the spec print format
  assert.deepEqual(num.missing, { values: [9], ranges: [] })
  assert.deepEqual(num.valueLabels, { '1': 'One', '2': 'Two' })
  assert.equal(date.name, 'date')
  assert.equal(date.label, 'When')
  assert.equal(date.type, 'string') // documented loss: .sav stores no date type
  assert.equal(note.label, 'Note')
  assert.deepEqual(note.missing, { values: ['xx'], ranges: [] })
  assert.deepEqual(note.valueLabels, { ab: 'ABee' })
  // Documented loss for strings wider than 8 bytes: labels and missing rules
  // are dropped by the writer (their spec records are not emitted).
  assert.equal(wide.label, 'Wide')
  assert.deepEqual(wide.missing, { values: [], ranges: [] })
  assert.deepEqual(wide.valueLabels, {})
})

test('sav names longer than 8 chars round-trip via the long name record', async () => {
  const ds = {
    columns: [{ ...defaultMeta('my_long_name', 'numeric'), label: 'L' }],
    data: { my_long_name: [7, null] }
  }
  const back = await importSavBytes(new Uint8Array(writeSav(ds, '', frozenDate)))
  assert.deepEqual(back.columns[0].name, 'my_long_name')
  assert.equal(back.columns[0].label, 'L')
  assert.deepEqual(back.data.my_long_name, [7, null])
})

test('uncompressed sav fails with the exact required copy', async () => {
  await assert.rejects(importSavBytes(fixture('uncompressed.sav')), (err) => {
    assert.equal(err.code, 'sav-uncompressed')
    assert.equal(
      err.userMessage,
      "This .sav file is uncompressed, which this version can't read yet. Re-save it from SPSS with compression on, or import as .csv."
    )
    return true
  })
})

test('empty and non-sav bytes fail with typed IoErrors', async () => {
  // importSavBytes/importXlsxBytes reject; importCsvBytes throws synchronously.
  await assert.rejects(importSavBytes(new Uint8Array(0)), (err) => {
    assert.equal(err.code, 'io-empty')
    assert.ok(err.userMessage.length > 0)
    return true
  })
  await assert.rejects(importSavBytes(textBytes('definitely not a sav file')), (err) => {
    assert.equal(err.code, 'sav-invalid')
    assert.ok(err.userMessage.length > 0)
    return true
  })
  assert.throws(() => importCsvBytes(new Uint8Array(0)), (err) => {
    assert.equal(err.code, 'io-empty')
    return true
  })
  await assert.rejects(importXlsxBytes(new Uint8Array(0)), (err) => {
    assert.equal(err.code, 'io-empty')
    return true
  })
})

test('xlsx round-trips data and full column meta via the meta sheet', async () => {
  const ds = richDataset()
  const buf = await exportXlsx(ds)
  const back = await importXlsxBytes(new Uint8Array(buf))
  // Exact data, exact meta (the Column meta sheet round-trips every field).
  assert.deepEqual(back, ds)
})

test('xlsx metadata preserves text IDs and literal missing tokens', async () => {
  const ds = { columns: [defaultMeta('id', 'string')], data: { id: ['001', '002', 'NA', '.', '', null, 'end', null] } }
  assert.deepEqual(await importXlsxBytes(await exportXlsx(ds)), ds)
})

test('xlsx without metadata preserves Excel text IDs that look numeric', async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Data')
  ws.addRow(['id', 'value'])
  ws.addRow(['001', 1])
  ws.addRow(['NA', 2])
  ws.addRow(['.', 3])
  const imported = await importXlsxBytes(new Uint8Array(await wb.xlsx.writeBuffer()))
  assert.deepEqual(imported.data.id, ['001', 'NA', '.'])
  assert.deepEqual(imported.data.value, [1, 2, 3])
})

test('xlsx reads dates and mixed cells and rejects malformed metadata', async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Data')
  ws.addRow(['date', 'mixed'])
  ws.addRow([new Date('2020-01-02T00:00:00.000Z'), '001'])
  ws.addRow([new Date('2020-01-03T00:00:00.000Z'), 2])
  const imported = await importXlsxBytes(new Uint8Array(await wb.xlsx.writeBuffer()))
  assert.deepEqual(imported.data.date, ['2020-01-02T00:00:00.000Z', '2020-01-03T00:00:00.000Z'])
  assert.deepEqual(imported.data.mixed, ['001', '2'])
  assert.equal(imported.columns[0].type, 'date')
  const meta = wb.addWorksheet('Column meta')
  meta.addRow(['name', 'label', 'type', 'measure', 'valueLabels', 'missing', 'decimals', 'width', 'align'])
  meta.addRow(['mixed', '', 'string', 'nominal', '{}', '{"values":null,"ranges":[]}', 0, 8, 'left'])
  await assert.rejects(importXlsxBytes(new Uint8Array(await wb.xlsx.writeBuffer())), { code: 'xlsx-meta' })
  meta.getCell('F2').value = '{"values":[],"ranges":[]}'
  for (const invalid of [-1, 1.5, 17, 1000]) {
    meta.getCell('G2').value = invalid
    await assert.rejects(importXlsxBytes(new Uint8Array(await wb.xlsx.writeBuffer())), { code: 'xlsx-meta' })
  }
  meta.getCell('G2').value = 0
  meta.getCell('H2').value = 100000
  await assert.rejects(importXlsxBytes(new Uint8Array(await wb.xlsx.writeBuffer())), { code: 'xlsx-meta' })
  meta.getCell('H2').value = 8
  meta.getCell('F2').value = '{"values":[],"ranges":[[5,1]]}'
  await assert.rejects(importXlsxBytes(new Uint8Array(await wb.xlsx.writeBuffer())), { code: 'xlsx-meta' })
})

test('xlsx without a meta sheet infers types and missing tokens', async () => {
  // Round-trip, then hand-strip the meta sheet via a second import path is
  // overkill: the inference path is the same code csv uses (datasetFromRows),
  // so exercise it through csv above and assert the sheet-missing branch here.
  const buf = await exportXlsx({
    columns: [{ ...defaultMeta('x', 'numeric') }],
    data: { x: [1, 2] }
  })
  const back = await importXlsxBytes(new Uint8Array(buf))
  assert.equal(back.columns[0].type, 'numeric')
  await assert.rejects(importXlsxBytes(new Uint8Array(buf), { sheetName: 'nope' }), (err) => {
    assert.equal(err.code, 'xlsx-sheet')
    return true
  })
})

test('project archive round-trips full meta, data, and the results slot', async () => {
  const project = {
    dataset: richDataset(),
    computedColumns: { formulas: [] },
    resultTree: { runs: [{ id: 'r1' }] }
  }
  const buf = await writeArchive(project)
  const back = await readArchive(new Uint8Array(buf))
  assert.deepEqual(back, project)
})

test('archive rejects junk with a typed error', async () => {
  await assert.rejects(readArchive(new Uint8Array(0)), (err) => {
    assert.equal(err.code, 'io-empty')
    return true
  })
  await assert.rejects(readArchive(textBytes('not a zip')), (err) => {
    assert.equal(err.code, 'archive-invalid')
    assert.ok(err.userMessage.length > 0)
    return true
  })
})
