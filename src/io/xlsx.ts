/**
 * `.xlsx` import/export via exceljs (§10). Export writes sheet `Data` plus a
 * `Column meta` sheet (one row per column: name, label, type, measure,
 * valueLabels JSON, missing JSON, decimals, width, align). Import reads
 * `Column meta` when present (exact round-trip) and infers types otherwise.
 * Date columns travel as their ISO strings.
 */
import ExcelJS from 'exceljs'
import type { CellValue, Workbook } from 'exceljs'
import { IoError } from './errors.ts'
import { datasetFromRows, datasetRowCount, defaultMeta, type Align, type ColumnMeta, type ColumnarDataset, type ColumnType, type Measure, type MissingRules, type RowImportOptions } from './types.ts'

const META_SHEET = 'Column meta'
const META_FIELDS = ['name', 'label', 'type', 'measure', 'valueLabels', 'missing', 'decimals', 'width', 'align']

export interface XlsxImportOptions extends RowImportOptions {
  sheetName?: string // default: first sheet
}

/** One cell to plain text: rich text, hyperlinks, formulas, Dates, numbers. */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((t) => t.text).join('')
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('result' in value) return value.result === null || value.result === undefined ? '' : String(value.result)
    return ''
  }
  return String(value)
}

/** The `Column meta` sheet as column meta, or null when the sheet is absent. */
function metaSheet(wb: Workbook): ColumnMeta[] | null {
  const ws = wb.getWorksheet(META_SHEET)
  if (!ws) return null
  const columns: ColumnMeta[] = []
  try {
    const names = new Set<string>()
    for (let i = 2; i <= ws.rowCount; i++) {
      const cells = Array.from({ length: META_FIELDS.length }, (_, c) => cellText(ws.getRow(i).getCell(c + 1).value))
      if (cells.every((c) => c === '')) continue
      const [name, label, type, measure, valueLabels, missing, decimals, width, align] = cells
      const labels: unknown = JSON.parse(valueLabels || '{}')
      const rules: unknown = JSON.parse(missing || '{"values":[],"ranges":[]}')
      if (
        !name || names.has(name) ||
        !['numeric', 'string', 'date'].includes(type) ||
        !['nominal', 'ordinal', 'scale', 'ratio'].includes(measure) ||
        !['left', 'right', 'center'].includes(align) ||
        !Number.isInteger(Number(decimals)) || Number(decimals) < 0 || Number(decimals) > 16 ||
        !Number.isInteger(Number(width)) || Number(width) < 0 || Number(width) > 32767 ||
        typeof labels !== 'object' || labels === null || Array.isArray(labels) ||
        Object.values(labels).some((v) => typeof v !== 'string') ||
        typeof rules !== 'object' || rules === null ||
        !('values' in rules) || !Array.isArray(rules.values) ||
        rules.values.some((v) => typeof v !== 'string' && (typeof v !== 'number' || !Number.isFinite(v))) ||
        !('ranges' in rules) || !Array.isArray(rules.ranges) ||
        rules.ranges.some((r) => !Array.isArray(r) || r.length !== 2 || r.some((v) => typeof v !== 'number' || !Number.isFinite(v)) || r[0] > r[1])
      ) throw new Error('invalid column metadata')
      names.add(name)
      columns.push({
        ...defaultMeta(name, type as ColumnType),
        label,
        measure: measure as Measure,
        align: align as Align,
        valueLabels: labels as Record<string, string>,
        missing: rules as MissingRules,
        decimals: Number(decimals),
        width: Number(width)
      })
    }
  } catch (err) {
    throw new IoError('xlsx-meta', 'The Column meta sheet of this workbook can\'t be read. Remove or repair that sheet, then import again.', String(err))
  }
  return columns
}

/** Apply imported column meta over the inferred dataset (names must match). */
function applyMeta(ds: ColumnarDataset, columns: ColumnMeta[]): void {
  const byName = new Map(columns.map((c) => [c.name, c]))
  for (let i = 0; i < ds.columns.length; i++) {
    const meta = byName.get(ds.columns[i].name)
    // Date cells travel as ISO text, so inferred 'string' accepts 'date' meta.
    const inferred = ds.columns[i].type
    if (meta && (meta.type === inferred || (meta.type === 'date' && inferred === 'string'))) ds.columns[i] = meta
  }
}

/** Import one workbook (§10): sheet rows → §6 dataset. */
export async function importXlsxBytes(bytes: Uint8Array, opts: XlsxImportOptions = {}): Promise<ColumnarDataset> {
  if (bytes.length === 0) {
    throw new IoError('io-empty', 'The file is empty. Pick a .csv, .sav, or .xlsx file with data in it.')
  }
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(Uint8Array.from(bytes).buffer)
  } catch (err) {
    throw new IoError('xlsx-invalid', 'This workbook can\'t be read. It may be damaged or not .xlsx. Try re-saving it from Excel, or import as .csv.', String(err))
  }
  const ws = opts.sheetName ? wb.getWorksheet(opts.sheetName) : wb.worksheets[0]
  if (!ws) {
    throw new IoError('xlsx-sheet', 'That sheet does not exist in this workbook. Pick another sheet name, or import as .csv.', opts.sheetName)
  }
  const metaWs = wb.getWorksheet(META_SHEET)
  const savedCount = metaWs?.getCell('K1').value === 'arastat-row-count' ? metaWs.getCell('K2').value : null
  if (savedCount !== null && (typeof savedCount !== 'number' || !Number.isInteger(savedCount) || savedCount < 0 || savedCount > 1048575)) throw new IoError('xlsx-meta', 'The workbook row count is invalid. Repair the Column meta sheet and import again.')
  const rows: string[][] = []
  for (let i = 1; i <= Math.max(ws.rowCount, (savedCount ?? 0) + 1); i++) {
    const row = ws.getRow(i)
    rows.push(Array.from({ length: ws.columnCount }, (_, c) => cellText(row.getCell(c + 1).value)))
  }
  if (rows.length === 0 || rows[0].every((c) => c === '')) {
    throw new IoError('io-empty', 'The sheet is empty. Pick a sheet with data in it, or import as .csv.')
  }
  const body = rows.slice(1)
  for (const r of body) {
    while (r.length > 0 && r[r.length - 1] === '') r.pop()
    if (r.length > rows[0].length) {
      throw new IoError('xlsx-shape', 'A row has more values than the header has columns. Fix the row, then import again.', JSON.stringify(r))
    }
  }
  const meta = metaSheet(wb)
  const types: Record<string, ColumnType> = {}
  const missingTokensByColumn: Record<string, string[]> = {}
  for (const col of meta ?? []) {
    types[col.name] = col.type
    missingTokensByColumn[col.name] = opts.missingTokens ?? ['']
  }
  // Excel text cells are explicit text even when their contents look numeric.
  rows[0].forEach((name, c) => {
    if (types[name]) return
    const values = Array.from({ length: ws.rowCount - 1 }, (_, i) => ws.getRow(i + 2).getCell(c + 1).value).filter((v) => v !== null && v !== undefined && v !== '')
    if (values.length && values.every((v) => v instanceof Date)) types[name] = 'date'
    else if (values.some((v) => typeof v === 'string')) types[name] = 'string'
    if (types[name] === 'string' || types[name] === 'date') missingTokensByColumn[name] = opts.missingTokens ?? ['']
  })
  const ds = datasetFromRows(rows[0], body, { missingTokens: opts.missingTokens, missingTokensByColumn, types: { ...types, ...opts.types } })
  if (meta) applyMeta(ds, meta)
  if (!opts.missingTokens) {
    ds.columns.forEach((col, c) => {
      if (col.type !== 'string') return
      for (let row = 0; row < body.length; row++) {
        if (ws.getRow(row + 2).getCell(c + 1).value === '') (ds.data[col.name] as Array<string | null>)[row] = ''
      }
    })
  }
  return ds
}

/** Export a dataset (§10): `Data` sheet + `Column meta` sheet. */
export async function exportXlsx(ds: ColumnarDataset): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Data')
  ws.addRow(ds.columns.map((c) => c.name))
  const rows = datasetRowCount(ds) // ragged columns fail here, not mid-write
  for (let r = 0; r < rows; r++) {
    ws.addRow(ds.columns.map((c) => {
      const v = ds.data[c.name][r]
      return v === null ? null : c.type === 'numeric' ? (v as number) : String(v)
    }))
  }
  const meta = wb.addWorksheet(META_SHEET)
  meta.addRow(META_FIELDS)
  meta.getCell('K1').value = 'arastat-row-count'
  meta.getCell('K2').value = rows
  for (const c of ds.columns) {
    meta.addRow([
      c.name,
      c.label,
      c.type,
      c.measure,
      JSON.stringify(c.valueLabels),
      JSON.stringify(c.missing),
      c.decimals,
      c.width,
      c.align
    ])
  }
  const buf = await wb.xlsx.writeBuffer()
  // exceljs types writeBuffer as its own Buffer (an ArrayBuffer alias) but
  // hands back a Node Buffer in Node; both are valid Uint8Array sources.
  return new Uint8Array(buf)
}
