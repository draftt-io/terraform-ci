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
  assert.deepEqual(parsed, { ...response, evaluation: { ...response.evaluation, evaluatedPolicies: [{ policyId: '10', name: 'Supported version' }] } })
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

test('parses the v2 publish fields and keeps a github.com check run url', () => {
  const parsed = parseScanResponse({ ...scanResponse(), checkRunUrl: 'https://github.com/o/r/runs/1', annotationCount: 3, publishError: { code: 'comment', message: 'm' } })
  assert.equal(parsed.checkRunUrl, 'https://github.com/o/r/runs/1')
  assert.equal(parsed.annotationCount, 3)
  assert.deepEqual(parsed.publishError, { code: 'comment', message: 'm' })
})

test('drops a check run url that is not https on github.com or the server host, and still accepts a v0.1.1 body', () => {
  assert.equal(parseScanResponse({ ...scanResponse(), checkRunUrl: 'http://github.com/x' }).checkRunUrl, undefined)
  assert.equal(parseScanResponse({ ...scanResponse(), checkRunUrl: 'https://evil.test/x' }).checkRunUrl, undefined)
  assert.equal(parseScanResponse({ ...scanResponse(), checkRunUrl: 'https://ghe.corp/x' }, { serverUrl: 'https://ghe.corp' }).checkRunUrl, 'https://ghe.corp/x')
  assert.equal(parseScanResponse({ ...scanResponse(), annotationCount: -1, publishError: { code: 1 } }).annotationCount, undefined)
  assert.equal(parseScanResponse(scanResponse()).publishError, undefined)
})

test('treats a null publishError from the server as no publish error', () => {
  const parsed = parseScanResponse({ ...scanResponse(), checkRunUrl: 'https://github.com/o/r/runs/1', annotationCount: 0, publishError: null })
  assert.equal(parsed.publishError, undefined)
  assert.equal('publishError' in parsed, false)
  assert.equal(parsed.annotationCount, 0)
})

test('keeps the fields the report renders and drops malformed entries of the optional ones', () => {
  const response = scanResponse()
  const parsed = parseScanResponse({
    ...response,
    components: [{ ...response.components[0], policyComponents: [{ policyId: '10', policyName: 'Supported version', name: 'primary', status: 'outdated', currentVersion: '14' }] }],
    evaluation: {
      evaluatedPolicies: [{ policyId: '10', name: 'Supported version' }, { policyId: 7 }],
      unevaluatedPolicies: [],
      componentsWithGaps: [{ address: 'aws_db_instance.replica', policyGaps: [{ policyName: 'Version', reason: 'missing_data', missingAttributes: ['engine_version', 3] }] }],
    },
  })
  assert.deepEqual(parsed.components[0]?.policyComponents[0], { policyId: '10', policyName: 'Supported version', name: 'primary', status: 'outdated', currentVersion: '14' })
  assert.deepEqual(parsed.evaluation.evaluatedPolicies, [{ policyId: '10', name: 'Supported version' }])
  assert.deepEqual(parsed.evaluation.componentsWithGaps[0]?.policyGaps[0]?.missingAttributes, ['engine_version'])
})
