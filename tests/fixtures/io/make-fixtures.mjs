// Generates the binary fixtures node can't diff: uncompressed.sav, built BY
// HAND from the public PSPP "System File Format" layout (header compression=0
// + two numeric variable records + 999 + raw 8-byte elements). jsavvy cannot
// read it on purpose - tests/fixtures/io/uncompressed.sav exercises our
// clear-error path. Re-run: node tests/fixtures/io/make-fixtures.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b }
const flt64 = (n) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b }
const field = (text, len) => { const b = Buffer.alloc(len, 0x20); Buffer.from(text, 'utf8').copy(b); return b }

const FMT = 2 | (8 << 8) | (5 << 16) // decimals 2, width 8, type 5 = F

const header = Buffer.concat([
  field('$FL2', 4),
  field('@(#) SPSS DATA FILE uncompressed fixture', 60),
  int32(2), // layout_code
  int32(2), // nominal_case_size: two numeric elements per case
  int32(0), // compression: 0 = uncompressed (the point of this fixture)
  int32(0), // weight_index
  int32(2), // ncases
  flt64(100), // bias
  field('24 sep 26', 9),
  field('12:00:00', 8),
  field('', 64),
  Buffer.alloc(3)
])

const variable = (name) =>
  Buffer.concat([int32(2), int32(0), int32(0), int32(0), int32(FMT), int32(FMT), field(name, 8)])

// Two cases, uncompressed 8-byte elements in dictionary order.
const data = Buffer.concat([flt64(1.5), flt64(2.25), flt64(-Number.MAX_VALUE), flt64(4)])

writeFileSync(join(here, 'uncompressed.sav'), Buffer.concat([header, variable('V1'), variable('V2'), int32(999), int32(0), data]))
console.log('wrote uncompressed.sav')
