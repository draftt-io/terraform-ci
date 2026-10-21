import assert from 'node:assert/strict'
import test from 'node:test'
import { parseScanResponse } from '../src/contracts.ts'
import { scanResponse } from './fixtures.ts'

test('reads the counted parts of the Draftt CI answer and ignores the rest', () => {
  const response = scanResponse()
  const parsed = parseScanResponse({
    ...response,
    summary: { managedResourcesInPlan: 1, componentsMapped: 1, hasPolicyViolations: true },
    evaluation: {
      ...response.evaluation,
      evaluatedPolicies: [{ policyId: '10', name: 'Supported version' }],
      componentsWithGaps: [{ address: 'aws_db_instance.primary', policyGaps: [{ policyName: 'Policy', reason: 'missing_data' }] }],
    },
    coverage: { ...response.coverage, mergedResources: [], skippedResources: [] },
  })
  assert.deepEqual(parsed, {
    ...response,
    evaluation: { ...response.evaluation, componentsWithGaps: [{ policyGaps: [{ policyName: 'Policy', reason: 'missing_data' }] }] },
  })
})

test('rejects malformed response data', () => {
  assert.throws(() => parseScanResponse({ ...scanResponse(), coverage: null }), /coverage/)
  assert.throws(() => parseScanResponse({ ...scanResponse(), evaluation: { unevaluatedPolicies: [], componentsWithGaps: [{ policyGaps: 'none' }] } }), /componentsWithGaps\.0\.policyGaps/)
})

test('parses the publish fields', () => {
  const parsed = parseScanResponse({ ...scanResponse(), checkRunUrl: 'https://github.com/o/r/runs/1', annotationCount: 3, publishError: { code: 'comment', message: 'm' } })
  assert.equal(parsed.checkRunUrl, 'https://github.com/o/r/runs/1')
  assert.equal(parsed.annotationCount, 3)
  assert.deepEqual(parsed.publishError, { code: 'comment', message: 'm' })
  assert.equal('publishError' in parseScanResponse({ ...scanResponse(), publishError: null }), false)
})

test('drops an off-host check run url and malformed optional values, keeping the rest of the response', () => {
  const parsed = parseScanResponse({ ...scanResponse(), checkRunUrl: 'https://evil.test/x', annotationCount: -1, publishError: { code: 1 } })
  for (const field of ['checkRunUrl', 'annotationCount', 'publishError'] as const) assert.equal(parsed[field], undefined, field)
  assert.equal(parsed.components.length, 1)
})
