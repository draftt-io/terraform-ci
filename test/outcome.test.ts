import assert from 'node:assert/strict'
import test from 'node:test'
import * as outcome from '../src/outcome.ts'
import { completedConclusion, fallbackConclusion, scanErrorConclusion } from '../src/outcome.ts'

test('completed scans never fail on violations', () => {
  assert.equal(completedConclusion(0), 'success')
  assert.equal(completedConclusion(1), 'neutral')
  assert.equal(completedConclusion(7), 'neutral')
})

test('scan errors fail only when opted in', () => {
  assert.equal(scanErrorConclusion(false), 'neutral')
  assert.equal(scanErrorConclusion(true), 'failure')
})

test('fallback conclusion is success at zero violations and neutral otherwise', () => {
  assert.equal(fallbackConclusion(0), 'success')
  assert.equal(fallbackConclusion(1), 'neutral')
  assert.equal(fallbackConclusion(2), 'neutral')
})

test('no server-mode verdict is derived from the response any more', () => {
  assert.equal('serverJobConclusion' in outcome, false)
})
