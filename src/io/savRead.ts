/**
 * `.sav` importer (§10). jsavvy parses the dictionary and the bytecode data;
 * the variable-record window at each `headers[i].start` is re-read straight
 * from the spec layout to recover missing rules and print formats (jsavvy
 * 0.0.6 decodes missing-value doubles big-endian and exposes no print format,
 * so decimals would otherwise be lost).
 *
 * [NEW-DECISION: importSavBytes is the whole importer boundary; a future
 * decompressing reader (uncompressed/ZLIB `.sav`) drops in behind it with no
 * UI change. v1 reads bytecode-compressed files only and errors clearly on
 * the rest.]
 *
 * Honest limits: `.sav` has no date type here - date columns re-import as
 * string; trailing spaces of string values are padding and don't survive;
 * value labels and missing rules for strings wider than 8 bytes are not
 * written by us (spec record types 14 / long string missing not emitted).
 */
import { Feeder, SavParser, type Parsed } from 'jsavvy'
import { IoError } from './errors.ts'
import { defaultMeta, type Align, type ColumnMeta, type ColumnValues, type ColumnarDataset, type Measure, type MissingRules } from './types.ts'

const MEASURE: Record<number, Measure> = { 1: 'nominal', 2: 'ordinal', 3: 'scale' }
const ALIGN: Record<number, Align> = { 0: 'left', 1: 'right', 2: 'center' }

/** String value-label codes are 8 LE bytes of the double; decoded as UTF-8. */
const utf8 = new TextDecoder('utf-8')

/** Magic + compression sniff before jsavvy sees the bytes. */
function sniff(dv: DataView): void {
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (magic !== '$FL2' && magic !== '$FL3') {
    throw new IoError('sav-invalid', 'This file is not a readable SPSS .sav file. It may be damaged or in an old format. Try re-saving it from SPSS, or import as .csv.', magic)
  }
  const compression = dv.getInt32(72, true)
  if (compression === 0) {
    throw new IoError('sav-uncompressed', 'This .sav file is uncompressed, which this version can\'t read yet. Re-save it from SPSS with compression on, or import as .csv.')
  }
  if (compression !== 1) {
    throw new IoError('sav-zlib', 'This .sav file is zlib-compressed, which this version can\'t read yet. Re-save it from SPSS with bytecode compression, or import as .csv.', `compression=${compression}`)
  }
}

/**
 * Missing rules + decimals/width from one spec variable-record window at
 * `start` (body layout: type@0, has_label@4, n_missing@8, print@12, write@16,
 * name@20-27, then optional label_len+label padded to 4, then 8-byte slots).
 */
function recordWindow(dv: DataView, start: number, stringWidth: number): { decimals: number; width: number; missing: MissingRules } {
  const nMissing = dv.getInt32(start + 8, true)
  const print = dv.getInt32(start + 12, true)
  let off = 28
  if (dv.getInt32(start + 4, true)) {
    const labelLen = dv.getInt32(start + 28, true)
    off += 4 + Math.ceil(labelLen / 4) * 4
  }
  const missing: MissingRules = { values: [], ranges: [] }
  const n = Math.abs(nMissing)
  const nums: number[] = []
  for (let i = 0; i < n; i++) {
    const at = start + off + i * 8
    if (stringWidth === 0) {
      nums.push(dv.getFloat64(at, true))
    } else {
      let s = ''
      for (let b = 0; b < 8; b++) s += String.fromCharCode(dv.getUint8(at + b))
      missing.values.push(s.replace(/[\u0000 ]+$/, ''))
    }
  }
  if (stringWidth === 0) {
    if (nMissing < 0) {
      missing.ranges.push([nums[0], nums[1]])
      if (nMissing === -3) missing.values.push(nums[2])
    } else {
      missing.values.push(...nums)
    }
  }
  return { decimals: print & 0xff, width: (print >> 8) & 0xffff, missing }
}

/** Value labels of dictionary index `dictIndex`; string codes ride 8 LE bytes. */
function labelsFor(levels: Parsed['internal']['levels'], dictIndex: number, stringWidth: number): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const level of levels) {
    if (!level.indices.has(dictIndex)) continue
    for (const [code, text] of level.map) {
      if (stringWidth === 0) {
        labels[String(code)] = text
      } else {
        // String codes are the 8 LE bytes of the double, read back as UTF-8.
        const raw = new ArrayBuffer(8)
        new DataView(raw).setFloat64(0, code, true)
        labels[utf8.decode(raw).replace(/[\u0000 ]+$/, '')] = text
      }
    }
  }
  return labels
}

/**
 * Import one bytecode-compressed `.sav` (§10) into the §6 dataset contract.
 * All user-missing values, SYSMIS and blanks arrive as null (PLAN §6); the
 * rules themselves survive in `ColumnMeta.missing`.
 */
export async function importSavBytes(bytes: Uint8Array): Promise<ColumnarDataset> {
  if (bytes.length === 0) {
    throw new IoError('io-empty', 'The file is empty. Pick a .csv, .sav, or .xlsx file with data in it.')
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  sniff(dv)
  let parsed: Parsed
  try {
    // SAFETY: jsavvy's Feeder reads the whole buffer from offset 0; bytes comes
    // from a fresh Uint8Array view, so copy unless it already owns its buffer.
    const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes)
    parsed = await new SavParser().all(new Feeder(owned.buffer as ArrayBuffer))
  } catch (err) {
    throw new IoError('sav-invalid', 'This .sav file could not be read. It may be damaged. Try re-saving it from SPSS, or import as .csv.', String(err))
  }
  const columns: ColumnMeta[] = []
  const data: Record<string, ColumnValues> = {}
  let dictIndex = 1
  for (let i = 0; i < parsed.headers.length; i++) {
    const h = parsed.headers[i]
    // Dummies (type -1) never surface here; `trailers` counts them (§10).
    const chunks = h.trailers + 1
    // Long names come back via 7/13; files without it keep their short names.
    const name = parsed.internal.names.get(h.name) ?? h.name
    const win = recordWindow(dv, h.start, h.code)
    const disp = parsed.internal.display[i]
    const meta = defaultMeta(name, h.code === 0 ? 'numeric' : 'string')
    meta.label = h.label.replace(/[\u0000 ]+$/, '') // label[] is up to 3 pad bytes
    meta.decimals = win.decimals
    meta.width = disp?.width ?? win.width
    meta.measure = MEASURE[disp?.type ?? 3] ?? 'scale'
    meta.align = ALIGN[disp?.align ?? (h.code === 0 ? 1 : 0)] ?? 'left'
    meta.missing = win.missing
    meta.valueLabels = labelsFor(parsed.internal.levels, dictIndex, h.code)
    dictIndex += chunks
    const raws = parsed.rows.map((row) => row.get(h.name) ?? null)
    if (h.code === 0) {
      data[name] = raws.map((x) => {
        const v = typeof x === 'number' ? x : null
        return v === null || win.missing.values.includes(v) || win.missing.ranges.some(([lo, hi]) => v >= lo && v <= hi) ? null : v
      })
    } else {
      data[name] = raws.map((x) => {
        const s = typeof x === 'string' ? x.replace(/[\u0000 ]+$/, '') : ''
        return s === '' || win.missing.values.includes(s) ? null : s
      })
    }
    columns.push(meta)
  }
  return { columns, data }
}
