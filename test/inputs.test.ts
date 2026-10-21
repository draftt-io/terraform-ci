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

function reader(values: Record<string, string>): { getInput(name: string): string } {
  return { getInput: (name: string) => values[name] ?? '' }
}

test('github-token and fail-on-violations are optional; an unknown publish-mode or a non-boolean fail-on-violations is rejected', () => {
  const base = { 'plan-json': 'p', 'api-url': 'https://x/ci/scans', 'api-key': 'k', 'terraform-root': '.', 'fail-on-scan-error': 'false' }
  const inputs = readInputs(reader(base))
  assert.equal(inputs.githubToken, undefined)
  assert.equal(inputs.failOnViolations, false)
  assert.throws(() => readInputs(reader({ ...base, 'publish-mode': 'both' })), /publish-mode must be "server" or "action"/)
  assert.throws(() => readInputs(reader({ ...base, 'fail-on-violations': 'yes' })), /fail-on-violations must be true or false/)
})

test('terraform-root becomes a canonical scan key relative to the workspace, and a root outside it is rejected', () => {
  const workspace = '/home/runner/work/infra/infra'
  for (const root of ['./modules/eks/', 'modules//eks', 'modules/x/../eks', `${workspace}/modules/eks/`]) assert.equal(scanKeyFromTerraformRoot(root, workspace), 'modules/eks', root)
  for (const root of ['.', './/', 'modules/..', workspace]) assert.equal(scanKeyFromTerraformRoot(root, workspace), '.', root)
  for (const root of ['../other', 'modules/../..', 'bad key', '/etc']) assert.throws(() => scanKeyFromTerraformRoot(root, workspace), /terraform-root/, root)
  assert.throws(() => scanKeyFromTerraformRoot(workspace), /terraform-root must be a relative path/)
})
