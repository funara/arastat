/**
 * CSV import/export (RFC 4180): quoted fields, `""` escapes, CR LF or LF
 * rows. Type inference and missing tokens are shared with xlsx through
 * `datasetFromRows`; blank lines in single-column files are missing records.
 */
import { IoError } from './errors.ts'
import { datasetFromRows, datasetRowCount, type ColumnarDataset, type RowImportOptions } from './types.ts'

export interface CsvImportOptions extends RowImportOptions {
  delimiter?: string // default ','
  encoding?: string // TextDecoder label, default 'utf-8'
}

export interface CsvExportOptions {
  delimiter?: string
  eol?: string // default '\r\n' per RFC 4180
}

/** RFC 4180 state machine over one char at a time. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true
      quoted = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      quoted = false
    } else {
      cell += ch
    }
  }
  if (cell !== '' || row.length > 0 || quoted) {
    row.push(cell)
    rows.push(row)
  }
  // A blank record in a one-column file represents one missing case.
  return rows[0]?.length === 1 ? rows : rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** Import CSV bytes (RFC 4180) into the §6 dataset contract. */
export function importCsvBytes(bytes: Uint8Array, opts: CsvImportOptions = {}): ColumnarDataset {
  if (bytes.length === 0) {
    throw new IoError('io-empty', 'The file is empty. Pick a .csv, .sav, or .xlsx file with data in it.')
  }
  const text = new TextDecoder(opts.encoding ?? 'utf-8').decode(Uint8Array.from(bytes))
  const rows = parseCsv(text, opts.delimiter ?? ',')
  if (rows.length === 0) {
    throw new IoError('io-empty', 'The file is empty. Pick a .csv, .sav, or .xlsx file with data in it.')
  }
  const header = rows[0]
  const body = rows.slice(1)
  for (const r of body) {
    if (r.length > header.length) {
      throw new IoError('csv-shape', 'A row has more values than the header has columns. Check the delimiter or fix the row, then import again.', JSON.stringify(r))
    }
  }
  return datasetFromRows(header, body, { missingTokens: opts.missingTokens, types: opts.types })
}

/** Quote one field iff RFC 4180 demands it, and escape spreadsheet formula
 *  injection: cells starting with '=', '+', '@', tab, or CR get a leading
 *  apostrophe. A leading '-' is left alone - every negative number would
 *  otherwise be corrupted; add it only if exports must be Excel-hardened
 *  against string columns that legitimately start with '-'. */
function quoteField(s: string, delimiter: string, eol: string): string {
  const guarded = /^[=+@\t\r]/.test(s) ? `'${s}` : s
  return guarded.includes(delimiter) || guarded.includes('"') || guarded.includes('\n') || guarded.includes('\r') || guarded.includes(eol)
    ? `"${guarded.replaceAll('"', '""')}"`
    : guarded
}

/** Serialize a dataset as RFC 4180 text (missing values leave as empty). */
export function serializeCsv(ds: ColumnarDataset, opts: CsvExportOptions = {}): string {
  const delimiter = opts.delimiter ?? ','
  const eol = opts.eol ?? '\r\n'
  const rows = datasetRowCount(ds)
  const out = [ds.columns.map((c) => quoteField(c.name, delimiter, eol)).join(delimiter)]
  for (let r = 0; r < rows; r++) {
    out.push(
      ds.columns
        .map((c) => {
          const v = ds.data[c.name][r]
          return quoteField(v === null ? '' : String(v), delimiter, eol)
        })
        .join(delimiter)
    )
  }
  return out.join(eol) + eol
}
