import assert from 'node:assert/strict'
import test from 'node:test'
import { completedConclusion, fallbackConclusion, scanErrorConclusion, serverJobConclusion } from '../src/outcome.ts'

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

test('the fallback conclusion is failure exactly when the mode is blocking and there are violations', () => {
  assert.equal(fallbackConclusion('blocking', 0), 'success')
  assert.equal(fallbackConclusion('blocking', 2), 'failure')
  assert.equal(fallbackConclusion('advisory', 0), 'success')
  assert.equal(fallbackConclusion('advisory', 2), 'neutral')
  assert.equal(fallbackConclusion(undefined, 0), 'success')
  assert.equal(fallbackConclusion(undefined, 2), 'neutral')
})

const URL = 'https://github.com/o/r/runs/1'

test('with checkRunUrl the job takes the server conclusion, and a failure fails it even in advisory mode', () => {
  assert.equal(serverJobConclusion({ checkRunUrl: URL, mode: 'blocking', conclusion: 'failure' }, 1), 'failure')
  // Review Focus 5: the server is the authority, so a failure with mode advisory still fails the job.
  assert.equal(serverJobConclusion({ checkRunUrl: URL, mode: 'advisory', conclusion: 'failure' }, 1), 'failure')
  assert.equal(serverJobConclusion({ checkRunUrl: URL, conclusion: 'failure' }, 1), 'failure')
  assert.equal(serverJobConclusion({ checkRunUrl: URL, mode: 'blocking', conclusion: 'neutral' }, 1), 'neutral')
  assert.equal(serverJobConclusion({ checkRunUrl: URL, mode: 'blocking', conclusion: 'success' }, 0), 'success')
})

test('a checkRunUrl without conclusion (an older service) never yields failure', () => {
  assert.equal(serverJobConclusion({ checkRunUrl: URL }, 3), undefined)
  assert.equal(serverJobConclusion({ checkRunUrl: URL, mode: 'blocking' }, 3), undefined)
})

test('without checkRunUrl the job takes the fallback conclusion and ignores a stray conclusion', () => {
  assert.equal(serverJobConclusion({ mode: 'blocking' }, 1), 'failure')
  assert.equal(serverJobConclusion({ mode: 'blocking' }, 0), 'success')
  assert.equal(serverJobConclusion({ mode: 'advisory' }, 1), 'neutral')
  assert.equal(serverJobConclusion({}, 1), 'neutral')
  assert.equal(serverJobConclusion({ mode: 'advisory', conclusion: 'failure' }, 1), 'neutral')
})
