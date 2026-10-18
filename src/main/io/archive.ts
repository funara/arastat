/**
 * Project archive save/load (§10): one zip (jszip, MIT elected - already in
 * the tree as an audited transitive) with a stable entry layout:
 *   manifest            text: `name: ara-stats-project-archive` + `version: 1`
 *   meta.json           {columns, computedColumns}
 *   data.json           columnar {name: values}
 *   results/result-tree.json   result-model slot (engine-owned content)
 *   results/charts/     empty placeholder directory
 */
import JSZip from 'jszip'
import { IoError } from './errors.ts'
import { datasetRowCount, type ColumnarDataset, type ColumnMeta, type ColumnValues } from './types.ts'

export interface ProjectArchive {
  dataset: ColumnarDataset
  computedColumns: { formulas: string[] }
  /** Opaque result tree preserved verbatim; v1 default is `{"runs": []}`. */
  resultTree: unknown
}

const MANIFEST = 'name: ara-stats-project-archive\nversion: 1\n'

/** Serialize a project archive (§10 entry layout). */
export async function writeArchive(project: ProjectArchive): Promise<Buffer> {
  datasetRowCount(project.dataset) // ragged columns fail here, not at load
  const zip = new JSZip()
  zip.file('manifest', MANIFEST)
  zip.file('meta.json', JSON.stringify({ columns: project.dataset.columns, computedColumns: project.computedColumns }))
  zip.file('data.json', JSON.stringify(project.dataset.data))
  zip.file('results/result-tree.json', JSON.stringify(project.resultTree ?? { runs: [] }))
  zip.folder('results/charts')
  return zip.generateAsync({ type: 'nodebuffer' })
}

const invalid = (detail?: string): IoError =>
  new IoError('archive-invalid', 'This project archive can\'t be read. It may be damaged or not an ARAStat archive. Try opening the original file again, or import the data as .csv.', detail)

/** Load a project archive written by `writeArchive` (§10 entry layout). */
export async function readArchive(bytes: Uint8Array): Promise<ProjectArchive> {
  if (bytes.length === 0) {
    throw new IoError('io-empty', 'The file is empty. Pick a project archive with data in it.')
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(Uint8Array.from(bytes))
  } catch (err) {
    throw invalid(String(err))
  }
  const manifest = await zip.file('manifest')?.async('string').catch(() => null) ?? null
  if (manifest !== MANIFEST) throw invalid(`manifest: ${JSON.stringify(manifest)}`)
  const metaText = await zip.file('meta.json')?.async('string').catch(() => null) ?? null
  const dataText = await zip.file('data.json')?.async('string').catch(() => null) ?? null
  if (metaText === null || dataText === null) throw invalid('meta.json or data.json missing')
  let parsed: { columns?: ColumnMeta[]; computedColumns?: { formulas: string[] } }
  let data: Record<string, ColumnValues>
  try {
    parsed = JSON.parse(metaText)
    data = JSON.parse(dataText)
    if (!Array.isArray(parsed.columns)) throw new Error('columns missing')
  } catch (err) {
    throw invalid(String(err))
  }
  const resultText = await zip.file('results/result-tree.json')?.async('string').catch(() => null) ?? null
  let resultTree: unknown = { runs: [] }
  if (resultText !== null) {
    try {
      resultTree = JSON.parse(resultText)
    } catch (err) {
      throw invalid(String(err))
    }
  }
  const project: ProjectArchive = {
    dataset: { columns: parsed.columns, data },
    computedColumns: parsed.computedColumns ?? { formulas: [] },
    resultTree
  }
  datasetRowCount(project.dataset) // shape check at the trust boundary
  return project
}
