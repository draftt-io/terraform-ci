import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePolicyIds, readInputs } from '../src/inputs.ts'

test('parses omitted, selected, and explicitly empty policy ids', () => {
  assert.equal(parsePolicyIds(''), undefined)
  assert.deepEqual(parsePolicyIds('["10","20"]'), ['10', '20'])
  assert.deepEqual(parsePolicyIds('[]'), [])
})

test('rejects malformed or non-decimal policy ids', () => {
  for (const input of ['not-json', '{}', '[1]', '["-1"]', '["01"]']) {
    assert.throws(() => parsePolicyIds(input), /JSON array of decimal-string ids/)
  }
})

test('reads the public Action interface', () => {
  const values: Record<string, string> = {
    'plan-json': 'plan.json',
    'api-url': 'https://api.draftt.io/ci/scanTerraformPlan',
    'api-key': 'masked',
    'github-token': 'github',
    'terraform-root': '.',
    'policy-ids': '[]',
    'fail-on-violations': 'false',
    'fail-on-scan-error': 'true',
  }
  const inputs = readInputs({
    getInput(name: string): string {
      return values[name] ?? ''
    },
  })
  assert.deepEqual(inputs.policyIds, [])
  assert.equal(inputs.failOnViolations, false)
  assert.equal(inputs.failOnScanError, true)
})
