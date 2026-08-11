import assert from 'node:assert/strict'
import test from 'node:test'
import { parseScanResponse } from '../src/contracts.ts'
import { scanResponse } from './fixtures.ts'

test('accepts the public UI Backend response contract', () => {
  assert.deepEqual(parseScanResponse(scanResponse()), scanResponse())
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
    tfType: 'aws_db_instance',
    tfName: 'primary',
    policyGaps: [{ policyId: '10', policyName: 'Policy', reason: 'missing_data', fields: ['engine'] }],
  }]
  const parsed = parseScanResponse(response)
  assert.deepEqual(parsed.evaluation.componentsWithGaps[0]?.policyGaps[0]?.fields, ['engine'])
  assert.throws(() => parseScanResponse({ ...response, coverage: null }), /coverage/)
})
