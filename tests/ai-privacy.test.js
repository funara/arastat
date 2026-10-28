import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExplanationGate, createSessionGuard, explanationPrompt } from '../src/aiPrivacy.ts'

const table = { kind: 'table', caption: 'Results', columns: ['Category', 'Count'], rows: [['private-id-123', 1]] }

test('frequency explanation omits potentially identifying category values', () => {
  const prompt = explanationPrompt({ analysisId: 'frequencies', title: 'Frequencies', spec: {}, elements: [table] })
  assert.match(prompt, /generic category labels/)
  assert.match(prompt, /Category 1 \| 1/)
  assert.doesNotMatch(prompt, /private-id-123/)
})

test('other result values are included in the exact preview text', () => {
  const prompt = explanationPrompt({ analysisId: 'chisq_independence', title: 'Chi-square', spec: {}, elements: [table] })
  assert.match(prompt, /private-id-123/)
})

test('explanation consent sends nothing on cancel and sends the preview once on approval', async () => {
  const sent = []
  const gate = createExplanationGate(async (request) => { sent.push(request.prompt) })
  const run = { analysisId: 'chisq_independence', title: 'Chi-square', spec: {}, elements: [table] }
  gate.show(run)
  gate.cancel()
  await gate.approve()
  assert.deepEqual(sent, [])
  gate.show(run)
  const preview = gate.pending.value.prompt
  await Promise.all([gate.approve(), gate.approve()])
  assert.deepEqual(sent, [preview])
})

test('session guard invalidates an outstanding reply on new chat or dataset replacement', async () => {
  const session = createSessionGuard()
  const token = session.snapshot()
  let resolve
  const response = new Promise((r) => { resolve = r })
  const accepted = []
  const request = response.then((value) => { if (session.isCurrent(token)) accepted.push(value) })
  session.invalidate()
  resolve('old proposal')
  await request
  assert.deepEqual(accepted, [])
  assert.equal(session.isCurrent(session.snapshot()), true)
})
