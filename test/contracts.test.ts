import assert from 'node:assert/strict'
import test from 'node:test'
import { parseScanResponse } from '../src/contracts.ts'
import { scanResponse } from './fixtures.ts'

test('accepts the public UI Backend response contract', () => {
  const response = scanResponse()
  const parsed = parseScanResponse({
    ...response,
    evaluation: {
      ...response.evaluation,
      evaluatedPolicies: [{ policyId: '10', name: 'Supported version' }],
      componentsFullyEvaluated: 1,
    },
  })
  assert.deepEqual(parsed, response)
})

test('ignores response details that do not affect Action behavior', () => {
  const response = scanResponse()
  assert.deepEqual(parseScanResponse({
    ...response,
    evaluation: {
      ...response.evaluation,
      evaluatedPolicies: 'changed unused shape',
      componentsFullyEvaluated: null,
    },
    coverage: {
      ...response.coverage,
      mergedResources: [{ changed: 'unused shape' }],
      skippedResources: [null],
    },
  }), {
    ...response,
    coverage: {
      ...response.coverage,
      mergedResources: [{ changed: 'unused shape' }],
      skippedResources: [null],
    },
  })
})

test('rejects an inconsistent violation summary', () => {
  const response = scanResponse({
    summary: { managedResourcesInPlan: 1, componentsMapped: 1, hasPolicyViolations: false },
  })
  assert.throws(() => parseScanResponse(response), /summary\.hasPolicyViolations/)
})

test('rejects malformed nested response data', () => {
  const response = scanResponse()
  response.evaluation.componentsWithGaps = [{
    address: 'aws_db_instance.primary',
    policyGaps: [{ policyName: 'Policy', reason: 'missing_data' }],
  }]
  const parsed = parseScanResponse(response)
  assert.equal(parsed.evaluation.componentsWithGaps[0]?.policyGaps[0]?.reason, 'missing_data')
  assert.throws(() => parseScanResponse({ ...response, coverage: null }), /coverage/)
})
