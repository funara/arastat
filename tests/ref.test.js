import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * Minimal NDJSON-RPC 2.0 stdio client: one UTF-8 JSON object per line.
 * Inlined here so the golden-reference tests have no dependency on host code.
 */
class SeamClient {
  #stdin
  #pending = new Map()
  #nextId = 1
  #buf = ''

  constructor(stdin, stdout, onNotification) {
    this.#stdin = stdin
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk) => {
      this.#buf += chunk
      let nl
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, nl)
        this.#buf = this.#buf.slice(nl + 1)
        if (line.trim()) this.#dispatch(JSON.parse(line), onNotification)
      }
    })
    stdout.on('close', () => {
      for (const { reject } of this.#pending.values()) reject(new Error('engine stream closed'))
      this.#pending.clear()
    })
  }

  #dispatch(msg, onNotification) {
    if (typeof msg.method === 'string') return onNotification({ method: msg.method, params: msg.params })
    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)
    if (msg.error) {
      const err = new Error(msg.error.message ?? 'engine error')
      err.code = msg.error.code ?? -1
      err.data = msg.error.data
      pending.reject(err)
    } else {
      pending.resolve(msg.result)
    }
  }

  invoke(method, params) {
    const id = this.#nextId++
    const { promise, resolve, reject } = Promise.withResolvers()
    this.#pending.set(id, { resolve, reject })
    this.#stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return promise
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixturesRoot = join(root, 'tests', 'fixtures')

/** The 23 D2(c) analyses (fixture directory names), alphabetical. */
const ANALYSIS_IDS = [
  'anova_oneway',
  'binomial',
  'chisq_gof',
  'chisq_independence',
  'correlation',
  'descriptives',
  'factorial_anova_2way',
  'fisher_exact_2x2',
  'frequencies',
  'friedman',
  'kendall_tau',
  'kruskal_wallis',
  'linear_regression',
  'logistic_regression',
  'mannwhitney_u',
  'mcnemar',
  'ttest_independent',
  'ttest_onesample',
  'ttest_paired',
  'tukey_hsd',
  'welch_anova',
  'wilcoxon_one_sample',
  'wilcoxon_signedrank'
]

const REL = 1e-9
const ABS = 1e-12

/** Spawn the REAL Python engine child exactly like the Tauri host's `engine.rs` does. */
function startEngine() {
  const venvPython = join(root, 'engine', '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
  const interpreter = existsSync(venvPython) ? venvPython : 'python3.12'
  const child = spawn(interpreter, ['-m', 'ara_engine'], {
    cwd: join(root, 'engine'),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const notifications = []
  const seam = new SeamClient(child.stdin, child.stdout, (n) => notifications.push(n))
  return { child, seam, notifications }
}

const exitCode = (child) => {
  const { promise, resolve } = Promise.withResolvers()
  child.on('exit', resolve)
  return promise
}

let engine = null
const getEngine = () => (engine ??= startEngine())

after(async () => {
  if (!engine) return
  engine.child.stdin.end()
  assert.equal(await exitCode(engine.child), 0)
})

// --- fixture loading (mirror io datasetFromRows semantics) -------------------

/** RFC 4180 quoting-aware CSV parse → rows of string cells. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') {
      field += c
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const MISSING_TOKENS = new Set(['', 'NA', '.'])

/** Flat Record<name, (number|string|null)[]> like io's data.json columnar map. */
function datasetFromRows(header, rows) {
  const data = {}
  header.forEach((name, i) => {
    const cells = rows.map((r) => (MISSING_TOKENS.has(r[i] ?? '') ? null : r[i]))
    const nonMissing = cells.filter((v) => v !== null)
    const isNumeric = nonMissing.every((v) => Number.isFinite(Number(v)))
    data[name] = cells.map((v) => (v === null ? null : isNumeric ? Number(v) : v))
  })
  return data
}

function fixtureDir(id) {
  for (const tier of ['tier1', 'tier2']) {
    const dir = join(fixturesRoot, tier, id)
    if (existsSync(join(dir, 'spec.json'))) return dir
  }
  throw new Error(`missing fixture dir for analysis "${id}"`)
}

function loadFixture(id) {
  const dir = fixtureDir(id)
  const specFile = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'))
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'))
  delete expected.provenance
  delete expected.notes
  const rows = parseCsv(readFileSync(join(dir, 'input.csv'), 'utf8'))
  const data = datasetFromRows(rows[0], rows.slice(1))
  return { spec: specFile.options, missingPolicy: specFile.missingPolicy, expected, data }
}

// --- golden diff (rel=1e-9 / abs=1e-12) --------------------------------------

const close = (a, b) => Math.abs(a - b) <= Math.max(ABS, REL * Math.max(Math.abs(a), Math.abs(b)))

function diff(exp, act, path, out) {
  if (exp !== null && typeof exp === 'object') {
    if (Array.isArray(exp)) {
      if (!Array.isArray(act)) {
        out.push(`${path}: expected a list, got ${JSON.stringify(act)}`)
        return
      }
      if (exp.length !== act.length) {
        out.push(`${path}: list length ${exp.length} vs ${act.length}`)
        return
      }
      exp.forEach((v, i) => diff(v, act[i], `${path}[${i}]`, out))
      return
    }
    if (act === null || typeof act !== 'object' || Array.isArray(act)) {
      out.push(`${path}: expected an object, got ${JSON.stringify(act)}`)
      return
    }
    for (const k of [...new Set([...Object.keys(exp), ...Object.keys(act)])].sort()) {
      if (!(k in exp)) out.push(`${path}.${k}: unexpected key`)
      else if (!(k in act)) out.push(`${path}.${k}: missing key`)
      else diff(exp[k], act[k], `${path}.${k}`, out)
    }
    return
  }
  if (typeof exp === 'number' && typeof act === 'number') {
    if (!close(exp, act)) out.push(`${path}: expected ${exp}, got ${act}`)
    return
  }
  if (exp !== act) out.push(`${path}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`)
}

async function runFixture(id) {
  const { spec, missingPolicy, expected, data } = loadFixture(id)
  const { seam, notifications } = getEngine()
  const runId = `golden-${id}`
  notifications.length = 0
  const result = await seam.invoke('run_analysis', { runId, analysisId: id, spec, data, missingPolicy })
  return { runId, result, notifications, expected }
}

// --- tests -------------------------------------------------------------------

test('fixture dirs cover exactly the 23 registered analyses (no skips)', () => {
  const found = []
  for (const tier of ['tier1', 'tier2']) {
    for (const name of readdirSync(join(fixturesRoot, tier))) {
      if (existsSync(join(fixturesRoot, tier, name, 'spec.json'))) found.push(name)
    }
  }
  found.sort()
  assert.deepEqual(found, ANALYSIS_IDS)
})

for (const id of ANALYSIS_IDS) {
  test(`golden reference: ${id}`, async () => {
    const { runId, notifications, expected } = await runFixture(id)
    const updates = notifications.filter((n) => n.method === 'analysis/update')
    const dones = notifications.filter((n) => n.method === 'analysis/done')
    assert.ok(updates.length >= 1, `${id}: expected at least one analysis/update`)
    assert.equal(dones.length, 1, `${id}: expected exactly one analysis/done`)
    let seq = 0
    for (const u of updates) {
      assert.equal(u.params.runId, runId)
      assert.equal(u.params.seq, ++seq, `${id}: seq must count from 1`)
      assert.ok(u.params.patches.length >= 1)
      for (const patch of u.params.patches) {
        assert.equal(patch.op, 'upsert')
        assert.ok(typeof patch.address === 'string' && patch.address.startsWith(`${runId}/`))
        assert.ok(['table', 'chart', 'note', 'error'].includes(patch.element.kind))
        assert.equal(patch.element.status, 'ok')
      }
    }
    const done = dones[0]
    assert.equal(done.params.runId, runId)
    assert.equal(done.params.status, 'complete')
    assert.ok(done.params.stats, `${id}: done must carry the stats mirror`)
    const problems = []
    diff(expected, done.params.stats, id, problems)
    assert.equal(problems.length, 0, `${id}: golden mismatch\n${problems.join('\n')}`)
  })
}

// --- error paths -------------------------------------------------------------

test('error 1001: an unknown option key is rejected before running', async () => {
  const { seam } = getEngine()
  await assert.rejects(
    seam.invoke('run_analysis', {
      runId: 'err-1001',
      analysisId: 'ttest_onesample',
      spec: { dep: 'score', testValue: 0, bogus: true },
      data: { score: [1, 2, 3] },
      missingPolicy: 'listwise'
    }),
    (err) => {
      assert.equal(err.code, 1001)
      assert.ok(err.data.userMessage.length > 0)
      assert.match(err.data.userMessage, /bogus/)
      return true
    }
  )
})

test('error 1003: a missing column names the recovery action', async () => {
  const { seam } = getEngine()
  await assert.rejects(
    seam.invoke('run_analysis', {
      runId: 'err-1003',
      analysisId: 'ttest_onesample',
      spec: { dep: 'absent_score', testValue: 0 },
      data: { score: [1, 2, 3] },
      missingPolicy: 'listwise'
    }),
    (err) => {
      assert.equal(err.code, 1003)
      assert.match(err.data.userMessage, /absent_score/)
      return true
    }
  )
})

test('error 1004: one defined group and an all-missing column fail numerically', async () => {
  const { seam } = getEngine()
  await assert.rejects(
    seam.invoke('run_analysis', {
      runId: 'err-1004a',
      analysisId: 'ttest_independent',
      spec: { dep: 'score', group: 'region' },
      data: { score: [1, 2, 3], region: ['North', 'North', 'North'] },
      missingPolicy: 'listwise'
    }),
    (err) => {
      assert.equal(err.code, 1004)
      assert.match(err.data.userMessage, /region/)
      return true
    }
  )
  await assert.rejects(
    seam.invoke('run_analysis', {
      runId: 'err-1004b',
      analysisId: 'ttest_onesample',
      spec: { dep: 'score', testValue: 0 },
      data: { score: [null, null, null] },
      missingPolicy: 'listwise'
    }),
    (err) => {
      assert.equal(err.code, 1004)
      return true
    }
  )
})

test('error 1004: a three-level grouping variable is refused, not silently cut to two', async () => {
  const { seam } = getEngine()
  await assert.rejects(
    seam.invoke('run_analysis', {
      runId: 'err-1004c',
      analysisId: 'ttest_independent',
      spec: { dep: 'score', group: 'region' },
      data: { score: [1, 2, 3, 4, 5, 6], region: ['North', 'North', 'South', 'South', 'East', 'East'] },
      missingPolicy: 'listwise'
    }),
    (err) => {
      assert.equal(err.code, 1004)
      assert.match(err.data.userMessage, /region/)
      assert.match(err.data.userMessage, /3 groups/)
      // The recovery must name both real options: a two-group column or ANOVA.
      assert.match(err.data.userMessage, /ANOVA/)
      return true
    }
  )
})
