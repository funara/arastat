// splitTrailingProse + splitLeadingBullet: jammed bullets split naturally.
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitLeadingBullet, splitTrailingProse } from '../src/aiText.ts'

const COLS = ['emp_name', 'department', 'join_date', 'city', 'remote_work', 'salary', 'age', 'performance_rating']

test('splits trailing prose after the last column name', () => {
  const item = 'Variables: 8 - Nominal (string): emp_name, department, join_date, city, remote_work - Scale (numeric): salary, age, performance_rating To get started, I recommend descriptives.'
  const [list, prose] = splitTrailingProse(item, COLS)
  assert.equal(list, 'Variables: 8 - Nominal (string): emp_name, department, join_date, city, remote_work - Scale (numeric): salary, age, performance_rating')
  assert.equal(prose, 'To get started, I recommend descriptives.')
})

test('leaves clean bullets untouched', () => {
  const item = 'Variables: salary, age'
  assert.deepEqual(splitTrailingProse(item, COLS), [item, null])
})

test('no cut without a known column name before prose', () => {
  const item = 'Variables: 8 - Summary To get started now'
  assert.deepEqual(splitTrailingProse(item, COLS), [item, null])
})

test('detaches first bullet jammed onto its intro line', () => {
  const line = 'Here are the viable tests: - **Compare groups on salary:** `ttest_independent` (2 groups)'
  assert.deepEqual(splitLeadingBullet(line), [
    'Here are the viable tests:',
    '- **Compare groups on salary:** `ttest_independent` (2 groups)'
  ])
})

test('leaves prose, bullets, and tables untouched', () => {
  assert.deepEqual(splitLeadingBullet('Scores went up - down across weeks'), ['Scores went up - down across weeks'])
  assert.deepEqual(splitLeadingBullet('- Point one'), ['- Point one'])
  assert.deepEqual(splitLeadingBullet('| a | b |'), ['| a | b |'])
})
