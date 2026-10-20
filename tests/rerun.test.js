// End-to-end proof that a re-run leaves no stale elements behind: the REAL
// Python engine streams its patches, the frontend result store consumes them,
// and a second run with fewer outputs must clear the leftovers.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Minimal NDJSON-RPC 2.0 stdio client (same shape as the Tauri host seam). */
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
  }

  #dispatch(msg, onNotification) {
    if (typeof msg.method === 'string') {
      onNotification({ method: msg.method, params: msg.params })
      return
    }
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

function startEngine() {
  const venvPython = join(
    root,
    'engine',
    '.venv',
    process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python'
  )
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

/** Three categorical columns: one run makes three frequency tables. */
const DATA = {
  a: ['x', 'y', 'x', 'z', 'y', 'x'],
  b: ['p', 'q', 'p', 'q', 'p', 'q'],
  c: ['m', 'm', 'n', 'n', 'm', 'n']
}

test('a re-run with fewer outputs leaves no stale elements on the card', async () => {
  const { runsState, startRun, markStale, applyNotification, findRun } =
    await import('../src/results.ts')
  const { seam, notifications } = getEngine()

  runsState.runs.splice(0)
  // The reveal timer needs a window; node has none.
  const prevWindow = globalThis.window
  globalThis.window = { setTimeout: () => 0 }
  try {
    const runId = 'rerun1'
    const spec = { variables: ['a', 'b', 'c'] }
    startRun(runId, 'frequencies', 'Frequency tables', spec, 'listwise', {
      type: 'bar',
      x: 'a'
    })

    notifications.length = 0
    await seam.invoke('run_analysis', {
      runId,
      analysisId: 'frequencies',
      spec,
      data: DATA,
      missingPolicy: 'listwise',
      chart: { type: 'bar', x: 'a' }
    })
    for (const n of notifications) applyNotification(n)

    const run = findRun(runId)
    const tables = run.elements.filter((el) => el.kind === 'table')
    const charts = run.elements.filter((el) => el.kind === 'chart')
    assert.equal(tables.length, 3, 'three variables make three frequency tables')
    assert.equal(charts.length, 1, 'the companion plot is part of the card')

    // The user edits the options: one variable, no companion plot.
    const spec2 = { variables: ['a'] }
    markStale(runId, undefined)
    notifications.length = 0
    await seam.invoke('run_analysis', {
      runId,
      analysisId: 'frequencies',
      spec: spec2,
      data: DATA,
      missingPolicy: 'listwise'
    })
    for (const n of notifications) applyNotification(n)

    assert.equal(run.status, 'done')
    assert.equal(
      run.elements.filter((el) => el.kind === 'table').length,
      1,
      'the two tables the new run did not produce must be gone'
    )
    assert.equal(
      run.elements.filter((el) => el.kind === 'chart').length,
      0,
      'the companion plot the new run did not ask for must be gone'
    )
    assert.ok(
      run.elements.every((el) => el.status !== 'stale'),
      'nothing may stay dimmed'
    )
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
    runsState.runs.splice(0)
  }
})
