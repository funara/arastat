import { IoError } from './errors.ts'

/**
 * §6 data model shared with the engine seam: column meta + columnar arrays.
 * Null = missing everywhere (PLAN §6: blanks, empty cells, user-missing all
 * collapse to one null; the rules themselves live in `ColumnMeta.missing`).
 */

export type ColumnType = 'numeric' | 'string' | 'date'
export type Measure = 'nominal' | 'ordinal' | 'scale' | 'ratio'
export type StorageType = 'integer' | 'float' | 'string' | 'date'
export type Align = 'left' | 'right' | 'center'

export function getStorageType(meta: ColumnMeta): StorageType {
  if (meta.type === 'string') return 'string'
  if (meta.type === 'date') return 'date'
  return meta.decimals === 0 ? 'integer' : 'float'
}

/** Short lowercase dtype label for grid headers: int, float, str, date. */
export function storageShort(meta: ColumnMeta): string {
  const t = getStorageType(meta)
  if (t === 'integer') return 'int'
  if (t === 'string') return 'str'
  return t
}

/** User-missing rules (§6): discrete values and/or inclusive numeric ranges. */
export interface MissingRules {
  values: Array<number | string>
  ranges: Array<[number, number]>
}

/** Column meta (§6). `valueLabels` keys are the codes as strings. */
export interface ColumnMeta {
  name: string
  label: string
  type: ColumnType
  measure: Measure
  valueLabels: Record<string, string>
  missing: MissingRules
  decimals: number
  width: number
  align: Align
}

/** One column's values; null = missing. */
export type ColumnValues = Array<number | null> | Array<string | null>

/** Columnar dataset (§6). */
export interface ColumnarDataset {
  columns: ColumnMeta[]
  data: Record<string, ColumnValues>
}

/** Boring defaults for columns without meta (csv/xlsx inference). */
export function defaultMeta(name: string, type: ColumnType): ColumnMeta {
  return {
    name,
    label: '',
    type,
    measure: type === 'numeric' ? 'scale' : 'nominal',
    valueLabels: {},
    missing: { values: [], ranges: [] },
    decimals: type === 'numeric' ? 2 : 0,
    width: type === 'numeric' ? 8 : 0,
    align: type === 'numeric' ? 'right' : 'left'
  }
}

const NUMERIC_SHAPE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
/** Parse one non-missing cell as a finite number, or null if it isn't one. */
export function numericCell(raw: string): number | null {
  const s = raw.trim()
  if (!NUMERIC_SHAPE.test(s)) return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

export interface RowImportOptions {
  /** Exact-match tokens that mean missing. Default: '', 'NA', '.'. */
  missingTokens?: string[]
  /** Per-column type overrides ('date' only exists via override). */
  types?: Record<string, ColumnType>
}

/**
 * Shared csv/xlsx import core: cell rows (row 0 = names) → columnar dataset.
 * A column is numeric iff every non-missing cell parses as a finite number;
 * `date` columns keep their ISO strings and only appear via `types`.
 * Missing tokens are applied here, so imported `missing` rules stay empty.
 */
export function datasetFromRows(header: string[], rows: string[][], opts: RowImportOptions = {}): ColumnarDataset {
  const missingTokens = opts.missingTokens ?? ['', 'NA', '.']
  const columns: ColumnMeta[] = []
  const data: Record<string, ColumnValues> = {}
  const seen = new Set<string>()
  for (const name of header) {
    if (!name || seen.has(name)) {
      throw new IoError('io-header', `Two columns share the name ${JSON.stringify(name)}, or a column has no name. Rename the columns and import again.`, name)
    }
    seen.add(name)
  }
  for (let c = 0; c < header.length; c++) {
    const raws = rows.map((row) => row[c] ?? '')
    const cells = raws.map((raw) => (missingTokens.includes(raw) ? null : raw))
    const override = opts.types?.[header[c]]
    const allNumeric = cells.every((cell) => cell === null || numericCell(cell) !== null)
    const type: ColumnType = override ?? (cells.some((cell) => cell !== null) && allNumeric ? 'numeric' : 'string')
    const meta = defaultMeta(header[c], type)
    if (type === 'numeric') {
      data[meta.name] = cells.map((cell) => (cell === null ? null : Number(cell.trim())))
    } else {
      data[meta.name] = cells as Array<string | null>
    }
    columns.push(meta)
  }
  return { columns, data }
}

/** Row count = the shared length of every column; throws `io-shape` if ragged. */
export function datasetRowCount(ds: ColumnarDataset): number {
  const first = ds.columns[0]
  const n = first ? (ds.data[first.name]?.length ?? -1) : 0
  for (const col of ds.columns) {
    const len = ds.data[col.name]?.length
    if (len === undefined || len !== n) {
      throw new IoError('io-shape', 'The columns have different numbers of values. Pad the shorter columns with missing values and try again.', `${col.name}: ${len} vs ${n}`)
    }
  }
  return n
}
