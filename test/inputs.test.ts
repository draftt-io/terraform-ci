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

test('publish-mode defaults to server, accepts action, rejects others; github-token is optional', () => {
  const base = { 'plan-json': 'p', 'api-url': 'https://x/v1/scans', 'api-key': 'k', 'terraform-root': '.', 'fail-on-violations': 'false', 'fail-on-scan-error': 'false' }
  assert.equal(readInputs(reader(base)).publishMode, 'server')
  assert.equal(readInputs(reader(base)).githubToken, undefined)
  assert.equal(readInputs(reader({ ...base, 'publish-mode': 'action', 'github-token': 't' })).publishMode, 'action')
  assert.throws(() => readInputs(reader({ ...base, 'publish-mode': 'both' })), /publish-mode must be "server" or "action"/)
})

test('scanKeyFromTerraformRoot normalises and validates', () => {
  assert.equal(scanKeyFromTerraformRoot('.'), '.')
  assert.equal(scanKeyFromTerraformRoot('./'), '.')
  assert.equal(scanKeyFromTerraformRoot('./modules/eks/'), 'modules/eks')
  assert.equal(scanKeyFromTerraformRoot('modules/eks'), 'modules/eks')
  assert.throws(() => scanKeyFromTerraformRoot('../other'), /terraform-root/)
  assert.throws(() => scanKeyFromTerraformRoot('bad key'), /terraform-root/)
})

test('scanKeyFromTerraformRoot canonicalises equivalent relative spellings', () => {
  for (const root of ['modules//eks', 'modules/./eks', 'modules/eks/.', './modules/eks', 'modules/eks//', 'modules/x/../eks']) {
    assert.equal(scanKeyFromTerraformRoot(root), 'modules/eks', root)
  }
  for (const root of ['./.', './/', '././', 'modules/..']) assert.equal(scanKeyFromTerraformRoot(root), '.', root)
  for (const root of ['..', 'modules/../..', './../x']) assert.throws(() => scanKeyFromTerraformRoot(root), /terraform-root/, root)
})

test('scanKeyFromTerraformRoot relativises an absolute root inside the workspace and rejects one outside it', () => {
  const workspace = '/home/runner/work/infra/infra'
  assert.equal(scanKeyFromTerraformRoot(workspace, workspace), '.')
  assert.equal(scanKeyFromTerraformRoot(`${workspace}/`, workspace), '.')
  assert.equal(scanKeyFromTerraformRoot(`${workspace}/modules/eks/`, `${workspace}/`), 'modules/eks')
  assert.equal(scanKeyFromTerraformRoot('modules/eks', workspace), 'modules/eks')
  assert.throws(() => scanKeyFromTerraformRoot('/home/runner/work/infra/other', workspace), /terraform-root must be a relative path/)
  assert.throws(() => scanKeyFromTerraformRoot('/etc', workspace), /terraform-root must be a relative path/)
  assert.throws(() => scanKeyFromTerraformRoot(workspace), /terraform-root must be a relative path/)
  assert.throws(() => scanKeyFromTerraformRoot('/'), /terraform-root must be a relative path/)
})

test('fail-on-violations: an empty value is unset (false) and anything but true or false is rejected', () => {
  const base = { 'plan-json': 'p', 'api-url': 'https://x/v1/scans', 'api-key': 'k', 'terraform-root': '.', 'fail-on-scan-error': 'false' }
  assert.equal(readInputs(reader(base)).failOnViolations, false)
  assert.equal(readInputs(reader({ ...base, 'fail-on-violations': 'true' })).failOnViolations, true)
  assert.equal(readInputs(reader({ ...base, 'fail-on-violations': 'false' })).failOnViolations, false)
  assert.throws(() => readInputs(reader({ ...base, 'fail-on-violations': 'yes' })), /fail-on-violations must be true or false/)
})
