import assert from 'node:assert/strict'
import test from 'node:test'
import { completedConclusion, scanErrorConclusion } from '../src/outcome.ts'

test('completed scans fail only for opted-in clear violations', () => {
  assert.equal(completedConclusion(0, false), 'success')
  assert.equal(completedConclusion(0, true), 'success')
  assert.equal(completedConclusion(1, false), 'neutral')
  assert.equal(completedConclusion(1, true), 'failure')
})

test('scan errors fail only when opted in', () => {
  assert.equal(scanErrorConclusion(false), 'neutral')
  assert.equal(scanErrorConclusion(true), 'failure')
})
