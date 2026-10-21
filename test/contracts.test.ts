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
    // Earlier servers also sent mode and conclusion.
    mode: 'blocking',
    conclusion: 'failure',
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

test('parses the v2 publish fields', () => {
  const parsed = parseScanResponse({ ...scanResponse(), checkRunUrl: 'https://github.com/o/r/runs/1', annotationCount: 3, publishError: { code: 'comment', message: 'm' } })
  assert.equal(parsed.checkRunUrl, 'https://github.com/o/r/runs/1')
  assert.equal(parsed.annotationCount, 3)
  assert.deepEqual(parsed.publishError, { code: 'comment', message: 'm' })
  assert.equal('publishError' in parseScanResponse({ ...scanResponse(), publishError: null }), false)
})

test('drops an off-host check run url and malformed optional values, keeping the rest of the response', () => {
  const parsed = parseScanResponse({
    ...scanResponse(),
    checkRunUrl: 'https://evil.test/x',
    annotationCount: -1,
    publishError: { code: 1 },
    evaluation: {
      evaluatedPolicies: [{ policyId: '10', name: 'Supported version' }, { policyId: 7 }],
      unevaluatedPolicies: [],
      componentsWithGaps: [{ address: 'aws_db_instance.replica', policyGaps: [{ policyName: 'Version', reason: 'missing_data', missingAttributes: ['engine_version', 3] }] }],
      excludedPolicyCount: 1.5,
      excludedEvaluatedPolicyCount: -1,
    },
  })
  for (const field of ['checkRunUrl', 'annotationCount', 'publishError'] as const) assert.equal(parsed[field], undefined, field)
  assert.deepEqual(parsed.evaluation.evaluatedPolicies, [{ policyId: '10', name: 'Supported version' }])
  assert.deepEqual(parsed.evaluation.componentsWithGaps[0]?.policyGaps[0]?.missingAttributes, ['engine_version'])
  assert.equal('excludedPolicyCount' in parsed.evaluation || 'excludedEvaluatedPolicyCount' in parsed.evaluation, false)
})

test('keeps an https policyUrl on a Draftt console policy page and drops any other, keeping the policy', () => {
  const policyUrlOf = (policyUrl: unknown) =>
    parseScanResponse({ ...scanResponse(), evaluation: { ...scanResponse().evaluation, evaluatedPolicies: [{ policyId: '10', name: 'Supported', policyUrl }] } })
      .evaluation.evaluatedPolicies?.[0]
  for (const url of ['https://app.draftt.io/policy/1', 'https://draftt.io/policy/1234567890123456789']) {
    assert.deepEqual(policyUrlOf(url), { policyId: '10', name: 'Supported', policyUrl: url }, url)
  }
  for (const url of [
    'https://draftt.io.evil.com/policy/1',
    'https://user@app.draftt.io/policy/1',
    'http://app.draftt.io/policy/1',
    'https://app.draftt.io/policy/1?)](https://evil.com)',
    ' https://app.draftt.io/po\nlicy/1\n',
    7,
  ]) {
    assert.deepEqual(policyUrlOf(url), { policyId: '10', name: 'Supported' }, JSON.stringify(url))
  }
})
