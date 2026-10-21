import assert from 'node:assert/strict'
import test from 'node:test'
import * as outcome from '../src/outcome.ts'
import { scanErrorConclusion, violationConclusion } from '../src/outcome.ts'

test('completed scans are success at zero violations and neutral otherwise, never failure', () => {
  assert.equal(violationConclusion(0), 'success')
  assert.equal(violationConclusion(1), 'neutral')
  assert.equal(violationConclusion(7), 'neutral')
})

test('scan errors fail only when opted in', () => {
  assert.equal(scanErrorConclusion(false), 'neutral')
  assert.equal(scanErrorConclusion(true), 'failure')
})

test('no server-mode verdict is derived from the response any more', () => {
  assert.equal('serverJobConclusion' in outcome, false)
})
