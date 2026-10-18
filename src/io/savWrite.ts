/**
 * Clean-room SPSS `.sav` writer (§10), built from the public PSPP
 * "System File Format" documentation only. Emits bytecode-compressed data
 * (compression=1, bias 100.0) so jsavvy and our own importer can read it.
 *
 * Pure Web: bytes are `Uint8Array` + `DataView` (no Node `Buffer`), so the same
 * writer runs in the WebView and in Node tests.
 *
 * Honest limits: `date` columns leave as their ISO text; `decimals` is
 * written in the print format but jsavvy does not expose it on read;
 * value labels and string missing rules only survive for strings ≤ 8 bytes;
 * strings wider than 255 bytes and names longer than 64 bytes are rejected.
 */
import { IoError } from './errors.ts'
import { datasetRowCount, type Align, type ColumnarDataset, type ColumnMeta, type Measure } from './types.ts'

const BIAS = 100
const SEG = 8
const MEASURE_CODE: Record<Measure, number> = { nominal: 1, ordinal: 2, scale: 3, ratio: 3 }
const ALIGN_CODE: Record<Align, number> = { left: 0, right: 1, center: 2 }
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const utf8 = new TextEncoder()

/** UTF-8 bytes of `text`, truncated or `fill`-padded to exactly `len` bytes. */
function field(text: string, len: number, fill = 0x20): Uint8Array {
  const out = new Uint8Array(len).fill(fill)
  out.set(utf8.encode(text).subarray(0, len))
  return out
}

const int32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setInt32(0, n, true)
  return b
}

const flt64 = (n: number): Uint8Array => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setFloat64(0, n, true)
  return b
}

/** One byte array holding `chunks` back to back (records are built piecewise). */
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** `dd mmm yy` and `hh:mm:ss` header stamps (lowercase month). */
function stamp(d: Date): { date: string; time: string } {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return {
    date: `${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${p2(d.getFullYear() % 100)}`,
    time: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  }
}

/** 176-byte file header (§10). */
function savHeader(elementCount: number, rows: number, d: Date, fileLabel: string): Uint8Array {
  const { date, time } = stamp(d)
  return concat([
    field('$FL2', 4),
    field('@(#) SPSS DATA FILE ARAStat clean-room writer', 60),
    int32(2),
    int32(elementCount),
    int32(1),
    int32(0),
    int32(rows),
    flt64(BIAS),
    field(date, 9),
    field(time, 8),
    field(fileLabel, 64),
    field('', 3, 0)
  ])
}

interface ColPlan {
  meta: ColumnMeta
  short: string
  dictIndex: number
  width: number // string byte width; 0 = numeric
  chunks: number // 8-byte elements per case
}

/** 8-char dictionary name in the legal charset, unique across `taken`. */
function shortName(name: string, taken: Set<string>): string {
  let s = name.toUpperCase().replace(/[^A-Z0-9#_$.]/g, '_')
  if (!s || !/^[A-Z@]/.test(s)) s = `V${s}`
  s = s.slice(0, 8)
  for (let i = 2; taken.has(s); i++) {
    const suffix = `_${i}`
    s = s.slice(0, 8 - suffix.length) + suffix
  }
  taken.add(s)
  return s
}

/** Widths, short names and 1-based dictionary indexes (dummies included). */
function planColumns(ds: ColumnarDataset): ColPlan[] {
  const taken = new Set<string>()
  const plans: ColPlan[] = []
  let dictIndex = 1
  for (const meta of ds.columns) {
    const values = ds.data[meta.name]
    if (!values) throw new IoError('io-shape', 'A column has no values. Re-import the data and try again.', meta.name)
    if (utf8.encode(meta.name).length > 64) {
      throw new IoError('sav-name', `The column name ${meta.name} is longer than 64 bytes, which .sav can't hold. Shorten the name and export again.`, meta.name)
    }
    let width = 0
    if (meta.type !== 'numeric') {
      for (const v of values) if (typeof v === 'string') width = Math.max(width, utf8.encode(v).length)
      width = Math.max(1, width)
      if (width > 255) {
        throw new IoError('sav-too-wide', `The column ${meta.name} holds text wider than 255 bytes, which .sav can't hold. Shorten the values or export as .csv or .xlsx.`, meta.name)
      }
    }
    const chunks = width === 0 ? 1 : Math.ceil(width / 8)
    plans.push({ meta, short: shortName(meta.name, taken), dictIndex, width, chunks })
    dictIndex += chunks
  }
  return plans
}

/** Type 2 records: one per 8-byte element, dummies (type -1) for string tails. */
function variableRecords(plans: ColPlan[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const p of plans) {
    const decimals = p.width === 0 ? Math.min(Math.max(p.meta.decimals, 0), 255) : 0
    const fw = p.width === 0 ? Math.min(Math.max(p.meta.width || 8, 1), 255) : p.width
    const format = decimals | (fw << 8) | ((p.width === 0 ? 5 : 1) << 16)
    const label = p.meta.label ? utf8.encode(p.meta.label) : new Uint8Array(0)
    const missing = missingSlots(p)
    const rec: Uint8Array[] = [
      int32(2),
      int32(p.width),
      int32(label.length > 0 ? 1 : 0),
      int32(missing.n),
      int32(format),
      int32(format),
      field(p.short, 8)
    ]
    if (label.length > 0) rec.push(int32(label.length), label, field('', (4 - (label.length % 4)) % 4))
    rec.push(...missing.slots)
    out.push(concat(rec))
    for (let i = 1; i < p.chunks; i++) {
      out.push(concat([int32(2), int32(-1), int32(0), int32(0), int32(0), int32(0), field('', 8)]))
    }
  }
  return out
}

/** `n_missing_values` code and 8-byte slots (§10: ≤3 discrete, 1 range + 1). */
function missingSlots(p: ColPlan): { n: number; slots: Uint8Array[] } {
  const { values, ranges } = p.meta.missing
  if (p.width === 0) {
    const nums = values.filter((v): v is number => typeof v === 'number')
    if (nums.length !== values.length) {
      throw new IoError('sav-write', `The numeric column ${p.meta.name} has text missing rules, which .sav can't hold. Remove them and export again.`, p.meta.name)
    }
    if (ranges.length === 0) {
      if (nums.length > 3) {
        throw new IoError('sav-write', `The column ${p.meta.name} has more than 3 missing values, which .sav can't hold. Trim the list and export again.`, p.meta.name)
      }
      return { n: nums.length, slots: nums.map(flt64) }
    }
    if (ranges.length > 1 || nums.length > 1) {
      throw new IoError('sav-write', `The column ${p.meta.name} has more missing rules than .sav can hold (one range plus one value). Trim the rules and export again.`, p.meta.name)
    }
    const [lo, hi] = ranges[0]
    return { n: nums.length === 1 ? -3 : -2, slots: [flt64(lo), flt64(hi), ...nums.map(flt64)] }
  }
  // String missing rules are discrete-only in .sav (ranges are numeric there)
  // and fit the width ≤ 8 records; wider strings need the long string missing
  // record, which this writer doesn't emit, so their rules are dropped.
  if (p.width > 8) return { n: 0, slots: [] }
  const strs = values.filter((v): v is string => typeof v === 'string')
  if (strs.length > 3) {
    throw new IoError('sav-write', `The column ${p.meta.name} has more than 3 missing values, which .sav can't hold. Trim the list and export again.`, p.meta.name)
  }
  return { n: strs.length, slots: strs.map((v) => field(v, 8)) }
}

/** Type 3+4 pairs: one per labeled column, numeric or ≤ 8-byte strings only. */
function valueLabelRecords(plans: ColPlan[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const p of plans) {
    const entries = Object.entries(p.meta.valueLabels)
    // Long string labels need record type 14, which this writer doesn't emit,
    // so their value labels are dropped.
    if (entries.length === 0 || p.width > 8) continue
    const rec3: Uint8Array[] = [int32(3), int32(entries.length)]
    for (const [key, text] of entries) {
      let value: Uint8Array
      if (p.width === 0) {
        const v = Number(key)
        if (!Number.isFinite(v)) {
          throw new IoError('sav-write', `The column ${p.meta.name} has a value label whose code ${key} is not a number. Fix the label codes and export again.`, key)
        }
        value = flt64(v)
      } else {
        value = field(key, 8) // labels on codes longer than 8 bytes are truncated
      }
      const label = utf8.encode(text)
      if (label.length > 255) {
        throw new IoError('sav-write', `A value label of ${p.meta.name} is longer than 255 bytes, which .sav can't hold. Shorten the label and export again.`, p.meta.name)
      }
      rec3.push(value, Uint8Array.from([label.length]), label, field('', (8 - ((1 + label.length) % 8)) % 8))
    }
    out.push(concat(rec3), concat([int32(4), int32(1), int32(p.dictIndex)]))
  }
  return out
}

/** Type 7 extension frame: `size*count` payload bytes (§10). */
function extRecord(subtype: number, size: number, count: number, data: Uint8Array): Uint8Array {
  return concat([int32(7), int32(subtype), int32(size), int32(count), data])
}

/** 7/3 + 7/4 + 7/11 + 7/13 + 7/20 in ascending subtype order. */
function extensionRecords(plans: ColPlan[]): Uint8Array[] {
  const machine = concat([
    int32(21), int32(0), int32(0), int32(-1),
    int32(1), int32(1), int32(2), int32(65001)
  ])
  const LOWEST = Uint8Array.from([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xef, 0xff])
  const specials = concat([flt64(-Number.MAX_VALUE), flt64(Number.MAX_VALUE), LOWEST])
  const display = concat(
    plans.flatMap((p) => [int32(MEASURE_CODE[p.meta.measure]), int32(p.meta.width), int32(ALIGN_CODE[p.meta.align])])
  )
  const names = utf8.encode(
    plans
      .filter((p) => p.meta.name !== p.short)
      .map((p) => `${p.short}=${p.meta.name}`)
      .join('\t')
  )
  return [
    extRecord(3, 4, 8, machine),
    extRecord(4, 8, 3, specials),
    extRecord(11, 4, plans.length * 3, display),
    ...(names.length > 0 ? [extRecord(13, 1, names.length, names)] : []),
    extRecord(20, 1, 5, utf8.encode('UTF-8'))
  ]
}

/** One 8-byte element: numeric null → 255; wholly blank text → 254 spaces. */
function element(v: number | string | null, padded: Uint8Array | null, blank: boolean, seg: number): { code: number; literal: Uint8Array | null } {
  if (padded === null) {
    if (v === null) return { code: 255, literal: null }
    const n = v as number
    const code = Math.round(n) + BIAS
    if (Number.isInteger(n) && n >= -99 && n <= 151) return { code, literal: null }
    return { code: 253, literal: flt64(n) }
  }
  // 254 only for wholly blank text: jsavvy drops 254s when concatenating the
  // chunks of a long string, so mid-value all-space chunks must stay literals.
  if (blank) return { code: 254, literal: null }
  return { code: 253, literal: padded.subarray(seg * SEG, seg * SEG + SEG) }
}

/** Bytecode-compressed data record (§10): 8 command bytes + 253 literals. */
function dataRecord(plans: ColPlan[], rows: number, get: (p: ColPlan, r: number) => number | string | null): Uint8Array {
  const out: number[] = []
  let cmds: number[] = []
  let lits: Uint8Array[] = []
  for (let r = 0; r < rows; r++) {
    for (const p of plans) {
      const v = get(p, r)
      // String nulls travel as 254 (8 spaces), how empty text is spelled in
      // string fields; readers see blank → missing either way (PLAN §6).
      const padded = p.width === 0 ? null : field(v === null ? '' : String(v), p.chunks * SEG)
      const blank = padded !== null && padded.every((b) => b === 0x20)
      for (let seg = 0; seg < p.chunks; seg++) {
        const { code, literal } = element(v, padded, blank, seg)
        cmds.push(code)
        if (literal) lits.push(literal)
        if (cmds.length === 8) {
          out.push(...cmds, ...concat(lits))
          cmds = []
          lits = []
        }
      }
    }
  }
  if (cmds.length > 0) {
    while (cmds.length < 8) cmds.push(0) // 0 = padding, ignored on read
    out.push(...cmds, ...concat(lits))
  }
  out.push(252) // end-of-file marker
  return Uint8Array.from(out)
}

/**
 * Serialize `ds` as a bytecode-compressed `.sav` (§10). `fileLabel` fills the
 * 64-byte header label; `now` is injectable for deterministic tests.
 */
export function writeSav(ds: ColumnarDataset, fileLabel = '', now: Date = new Date()): Uint8Array {
  const rows = datasetRowCount(ds)
  const plans = planColumns(ds)
  const get = (p: ColPlan, r: number): number | string | null => {
    const values = ds.data[p.meta.name]
    return values ? values[r] ?? null : null
  }
  return concat([
    savHeader(plans.reduce((n, p) => n + p.chunks, 0), rows, now, fileLabel),
    ...variableRecords(plans),
    ...valueLabelRecords(plans),
    ...extensionRecords(plans),
    int32(999),
    int32(0),
    dataRecord(plans, rows, get)
  ])
}
