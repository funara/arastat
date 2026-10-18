// profileDataset / profileText: aggregates, missing %, complete rows, card text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { profileDataset, profileText } from '../src/profile.ts'

const isNull = (col, v) => v === null
const withCode = (col, v) => v === null || (col === 'a' && v === 99)

test('numeric profile reports range mean and missing', () => {
  const p = profileDataset(
    [{ name: 'a', type: 'numeric' }],
    { a: [1, 2, null, 4] },
    isNull
  )
  assert.equal(p.rows, 4)
  assert.equal(p.profiles[0].missing, 1)
  assert.match(p.profiles[0].detail, /range 1–4, mean 2\.33/)
})

test('user-missing codes excluded from aggregates', () => {
  const p = profileDataset(
    [{ name: 'a', type: 'numeric' }],
    { a: [10, 20, 99, null] },
    withCode
  )
  assert.equal(p.profiles[0].missing, 2)
  assert.match(p.profiles[0].detail, /mean 15/)
})

test('string profile counts distinct, complete rows need all columns', () => {
  const p = profileDataset(
    [
      { name: 'a', type: 'numeric' },
      { name: 'g', type: 'string' }
    ],
    { a: [1, null, 3], g: ['x', 'y', null] },
    isNull
  )
  assert.equal(p.completeRows, 1)
  assert.equal(p.profiles[1].detail, '2 distinct')
})

test('profileText renders the card', () => {
  const p = profileDataset([{ name: 'a', type: 'numeric' }], { a: [1, null] }, isNull)
  const text = profileText(p, 'test.csv')
  assert.match(text, /test\.csv - 1 columns, 2 rows, 1 complete rows/)
  assert.match(text, /- a \(numeric\): 1 missing \(50%\), range 1–1, mean 1/)
})
