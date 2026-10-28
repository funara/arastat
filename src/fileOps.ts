// File operations: import (.sav/.csv/.xlsx), project archive open/save,
// results export (HTML string via file:save + file:writeBytes). The renderer
// coordinates; bytes cross the IPC bridge.
import { state, setDataset } from './store.ts'
import { importCsvBytes, serializeCsv } from './io/csv.ts'
import { IoError } from './io/errors.ts'
import { isRecord } from './guard.ts'

function extOf(path: string): string {
  const i = path.toLowerCase().lastIndexOf('.')
  return i >= 0 ? path.toLowerCase().slice(i) : ''
}

function ioMessage(err: unknown): string {
  if (err instanceof IoError) return err.userMessage
  if (isRecord(err) && typeof err['message'] === 'string' && err['message']) return err['message'] as string
  if (err instanceof Error && err.message) return err.message
  return 'The file could not be read. Try a .sav, .csv, or .xlsx file with data in it.'
}

/** Import a data file by extension. Throws IoError-shaped errors for the caller to toast. */
export async function importFile(path: string, bytes: ArrayBuffer): Promise<void> {
  const ext = extOf(path)
  const raw = new Uint8Array(bytes)
  if (ext === '.csv') {
    setDataset(importCsvBytes(raw))
    state.sample = false
    return
  }
  if (ext === '.sav') {
    const { importSavBytes } = await import('./io/savRead.ts')
    setDataset(await importSavBytes(raw))
    state.sample = false
    return
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const { importXlsxBytes } = await import('./io/xlsx.ts')
    setDataset(await importXlsxBytes(raw))
    state.sample = false
    return
  }
  throw new IoError('io-ext', 'This file type is not supported. Import a .sav, .csv, or .xlsx file.')
}

/** Open dialog: project archives (.ara.zip) restore dataset + results, data files import. */
export async function openWithDialog(restore: (tree: unknown) => void, confirmReplace: () => Promise<boolean>): Promise<{ kind: 'dataset' | 'project' | 'cancel' }> {
  const path = await window.ara.file.open()
  if (!path || !(await confirmReplace())) return { kind: 'cancel' }
  const bytes = await window.ara.file.readBytes(path)
  if (!bytes) throw new IoError('io-read', 'The file could not be read. Try again.')
  if (path.toLowerCase().endsWith('.ara.zip')) {
    const { readArchive } = await import('./io/archive.ts')
    const project = await readArchive(new Uint8Array(bytes))
    setDataset(project.dataset)
    state.computedFormulas = [...project.computedColumns.formulas]
    state.sample = false
    state.filename = path.split(/[\\/]/).pop() || path
    restore(project.resultTree)
    return { kind: 'project' }
  }
  await importFile(path, bytes)
  state.filename = path.split(/[\\/]/).pop() || path
  return { kind: 'dataset' }
}

/** Save dialog: project archive by default, raw .csv when the name says so. */
export async function saveWithDialog(resultTree: unknown, defaultName = 'analysis.ara.zip'): Promise<boolean> {
  const path = await window.ara.file.save(defaultName)
  if (!path) return false
  if (path.toLowerCase().endsWith('.csv')) {
    const text = serializeCsv(state.ds)
    const ok = await window.ara.file.writeBytes(path, new TextEncoder().encode(text).buffer as ArrayBuffer)
    if (!ok) throw new IoError('io-write', 'The file could not be saved. Try a different location.')
    state.filename = path.split(/[\\/]/).pop() || path
    return true
  }
  const { writeArchive } = await import('./io/archive.ts')
  const buf = await writeArchive({ dataset: state.ds, computedColumns: { formulas: [...state.computedFormulas] }, resultTree })
  const ok = await window.ara.file.writeBytes(path, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
  if (!ok) throw new IoError('io-write', 'The file could not be saved. Try a different location.')
  state.filename = path.split(/[\\/]/).pop() || path
  return true
}

export { ioMessage }
