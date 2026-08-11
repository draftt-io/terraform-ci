import assert from 'node:assert/strict'
import test from 'node:test'
import { annotationBatches, isExternalForkPayload, type CheckAnnotation } from '../src/github-check.ts'

function annotations(count: number): CheckAnnotation[] {
  return Array.from({ length: count }, (_, index) => ({
    path: 'main.tf',
    start_line: index + 1,
    end_line: index + 1,
    annotation_level: 'warning',
    message: `Finding ${index}`,
    title: 'Draftt policy violation',
  }))
}

test('batches Check annotations at the GitHub limit', () => {
  assert.deepEqual(annotationBatches(annotations(0)).map((batch) => batch.length), [])
  assert.deepEqual(annotationBatches(annotations(1)).map((batch) => batch.length), [1])
  assert.deepEqual(annotationBatches(annotations(50)).map((batch) => batch.length), [50])
  assert.deepEqual(annotationBatches(annotations(51)).map((batch) => batch.length), [50, 1])
  assert.deepEqual(annotationBatches(annotations(237)).map((batch) => batch.length), [50, 50, 50, 50, 37])
})

test('detects only pull requests whose head repository differs from the base', () => {
  const pullRequest = (head: string, base: string): Record<string, unknown> => ({
    pull_request: {
      head: { repo: { full_name: head } },
      base: { repo: { full_name: base } },
    },
  })
  assert.equal(isExternalForkPayload(pullRequest('fork/repository', 'draftt/repository')), true)
  assert.equal(isExternalForkPayload(pullRequest('draftt/repository', 'draftt/repository')), false)
  assert.equal(isExternalForkPayload({}), false)
})
