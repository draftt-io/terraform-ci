import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePolicyIds, readInputs, scanKeyFromTerraformRoot } from '../src/inputs.ts'

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

function reader(values: Record<string, string>): { getInput(name: string): string } {
  return { getInput: (name: string) => values[name] ?? '' }
}

test('reads the public Action interface and accepts only an https /ci/scans api-url', () => {
  const base = { 'plan-json': 'plan.json', 'api-url': 'https://api.draftt.io/ci/scans/', 'api-key': 'masked', 'terraform-root': '.', 'policy-ids': '[]', 'fail-on-scan-error': 'true' }
  const inputs = readInputs(reader(base))
  assert.deepEqual(inputs.policyIds, [])
  assert.equal(inputs.failOnScanError, true)
  const invalid: Array<[string, RegExp]> = [
    ['https://api.draftt.io/ci/scanTerraformPlan', /api-url must be the Draftt CI scans endpoint, ending in \/ci\/scans/],
    ['http://api.draftt.io/ci/scans', /must use HTTPS/],
    ['https://user:password@api.draftt.io/ci/scans', /must not contain credentials/],
  ]
  for (const [apiUrl, message] of invalid) assert.throws(() => readInputs(reader({ ...base, 'api-url': apiUrl })), message, apiUrl)
  assert.throws(() => readInputs(reader({ ...base, 'fail-on-scan-error': 'yes' })), /fail-on-scan-error must be true or false/)
})

test('terraform-root becomes a canonical scan key relative to the workspace, and a root outside it is rejected', () => {
  const workspace = '/home/runner/work/infra/infra'
  for (const root of ['./modules/eks/', 'modules//eks', 'modules/x/../eks', `${workspace}/modules/eks/`]) assert.equal(scanKeyFromTerraformRoot(root, workspace), 'modules/eks', root)
  for (const root of ['.', './/', 'modules/..', workspace]) assert.equal(scanKeyFromTerraformRoot(root, workspace), '.', root)
  for (const root of ['../other', 'modules/../..', 'bad key', '/etc']) assert.throws(() => scanKeyFromTerraformRoot(root, workspace), /terraform-root/, root)
  assert.throws(() => scanKeyFromTerraformRoot(workspace), /terraform-root must be a relative path/)
})
