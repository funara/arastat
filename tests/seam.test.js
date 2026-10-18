import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SeamClient } from '../src/main/seamClient.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Spawn the REAL Python engine child exactly like src/main/index.ts does. */
function startEngine() {
  const venvPython = join(root, 'engine', '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
  const interpreter = existsSync(venvPython) ? venvPython : 'python3.12'
  const child = spawn(interpreter, ['-m', 'ara_engine'], {
    cwd: join(root, 'engine'),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const seam = new SeamClient(child.stdin, child.stdout, () => {})
  return { child, seam }
}

const exitCode = (child) => {
  const { promise, resolve } = Promise.withResolvers()
  child.on('exit', resolve)
  return promise
}

test('capabilities round-trips through the live engine', async () => {
  const { child, seam } = startEngine()
  const caps = await seam.invoke('capabilities')
  assert.deepEqual(caps, {
    engine: 'ara-stats-engine',
    version: '0.1.0',
    analyses: [
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
      'shapiro_wilk',
      'spearman_correlation',
      'ttest_independent',
      'ttest_onesample',
      'ttest_paired',
      'tukey_hsd',
      'welch_anova',
      'wilcoxon_one_sample',
      'wilcoxon_signedrank',
    ]
  })
  child.stdin.end()
  assert.equal(await exitCode(child), 0)
})
test('run_analysis computes Shapiro-Wilk through the live engine', async () => {
  const { child, seam } = startEngine()
  await seam.invoke('run_analysis', {
    runId: 'shapiro-live', analysisId: 'shapiro_wilk', spec: { dep: 'score' },
    data: { score: [1, 2, 3, 4, 5, 6] }, missingPolicy: 'listwise'
  })
  child.stdin.end()
  assert.equal(await exitCode(child), 0)
})

test('run_analysis of an unregistered id returns error 1002 with userMessage', async () => {
  const { child, seam } = startEngine()
  await assert.rejects(
    seam.invoke('run_analysis', { runId: 'r1', analysisId: 'no_such_analysis', spec: {}, data: {}, missingPolicy: 'omit' }),
    (err) => {
      assert.equal(err.code, 1002)
      assert.equal(typeof err.data?.userMessage, 'string')
      assert.ok(err.data.userMessage.length > 0)
      return true
    }
  )
  child.stdin.end()
  assert.equal(await exitCode(child), 0)
})

test('a malformed JSON line yields -32700', async () => {
  const { child, seam } = startEngine()
  // One well-formed request first (proves the pipe is live), then garbage on
  // the raw stdin: the parse-error reply must not disturb the valid request.
  const parseErr = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no parse-error reply')), 5000)
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (msg.error?.code === -32700) {
          clearTimeout(timer)
          resolve(msg.error)
        }
      }
    })
  })
  const capsPromise = seam.invoke('capabilities')
  child.stdin.write('this is not json\n')
  assert.ok(await capsPromise)
  const error = await parseErr
  assert.equal(error.code, -32700)
  assert.equal(typeof error.data?.userMessage, 'string')
  child.stdin.end()
  assert.equal(await exitCode(child), 0)
})

test('the engine shuts down cleanly (exit 0) on stdin EOF', async () => {
  const { child } = startEngine()
  child.stdin.end()
  assert.equal(await exitCode(child), 0)
})
