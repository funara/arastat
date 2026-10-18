/**
 * `.xlsx` import/export via exceljs (§10). Export writes sheet `Data` plus a
 * `Column meta` sheet (one row per column: name, label, type, measure,
 * valueLabels JSON, missing JSON, decimals, width, align). Import reads
 * `Column meta` when present (exact round-trip) and infers types otherwise.
 * Date columns travel as their ISO strings.
 */
import ExcelJS from 'exceljs'
import type { Buffer as ExcelBuffer, CellValue, Workbook } from 'exceljs'
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
    for (let i = 2; i <= ws.rowCount; i++) {
      const cells = Array.from({ length: META_FIELDS.length }, (_, c) => cellText(ws.getRow(i).getCell(c + 1).value))
      if (cells.every((c) => c === '')) continue
      const [name, label, type, measure, valueLabels, missing, decimals, width, align] = cells
      columns.push({
        ...defaultMeta(name, type as ColumnType),
        label,
        measure: measure as Measure,
        align: align as Align,
        valueLabels: JSON.parse(valueLabels || '{}') as Record<string, string>,
        missing: JSON.parse(missing || '{"values":[],"ranges":[]}') as MissingRules,
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
    await wb.xlsx.load(Uint8Array.from(bytes) as unknown as ExcelBuffer)
  } catch (err) {
    throw new IoError('xlsx-invalid', 'This workbook can\'t be read. It may be damaged or not .xlsx. Try re-saving it from Excel, or import as .csv.', String(err))
  }
  const ws = opts.sheetName ? wb.getWorksheet(opts.sheetName) : wb.worksheets[0]
  if (!ws) {
    throw new IoError('xlsx-sheet', 'That sheet does not exist in this workbook. Pick another sheet name, or import as .csv.', opts.sheetName)
  }
  const rows: string[][] = []
  for (let i = 1; i <= ws.rowCount; i++) {
    const row = ws.getRow(i)
    rows.push(Array.from({ length: ws.columnCount }, (_, c) => cellText(row.getCell(c + 1).value)))
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop()
  if (rows.length === 0) {
    throw new IoError('io-empty', 'The sheet is empty. Pick a sheet with data in it, or import as .csv.')
  }
  const body = rows.slice(1)
  for (const r of body) {
    while (r.length > 0 && r[r.length - 1] === '') r.pop()
    if (r.length > rows[0].length) {
      throw new IoError('xlsx-shape', 'A row has more values than the header has columns. Fix the row, then import again.', JSON.stringify(r))
    }
  }
  const ds = datasetFromRows(rows[0], body, { missingTokens: opts.missingTokens, types: opts.types })
  const meta = metaSheet(wb)
  if (meta) applyMeta(ds, meta)
  return ds
}

/** Export a dataset (§10): `Data` sheet + `Column meta` sheet. */
export async function exportXlsx(ds: ColumnarDataset): Promise<Buffer> {
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
  return Buffer.from(buf as ArrayBuffer)
}
