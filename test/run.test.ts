import assert from 'node:assert/strict'
import test from 'node:test'
import type { ScanResponse } from '../src/contracts.ts'
import { scanTerraformPlan } from '../src/api.ts'
import type { ActionInputs } from '../src/inputs.ts'
import type { SanitizedPlan } from '../src/plan.ts'
import { buildGitHubContext, isExternalFork, type GitHubScanContext } from '../src/request.ts'
import { run, type ActionDependencies, type ActionRuntime } from '../src/run.ts'
import type { WorkspaceSourceStatus } from '../src/workspace.ts'
import { scanResponse } from './fixtures.ts'

class FakeRuntime implements ActionRuntime {
  readonly inputs: Record<string, string>
  readonly inputReads: string[] = []
  readonly outputs = new Map<string, string | number>()
  readonly secrets: string[] = []
  readonly failures: string[] = []
  readonly warnings: string[] = []
  readonly infos: string[] = []
  readonly summaries: string[] = []

  constructor(inputs: Record<string, string>) {
    this.inputs = inputs
  }

  getInput(name: string, options?: { required?: boolean }): string {
    this.inputReads.push(name)
    const value = this.inputs[name] ?? ''
    if (options?.required && value === '') throw new Error(`Input required and not supplied: ${name}`)
    return value
  }

  setSecret(value: string): void {
    this.secrets.push(value)
  }

  setOutput(name: string, value: string | number): void {
    this.outputs.set(name, value)
  }

  setFailed(message: string): void {
    this.failures.push(message)
  }

  warning(message: string): void {
    this.warnings.push(message)
  }

  info(message: string): void {
    this.infos.push(message)
  }

  async writeSummary(markdown: string): Promise<void> {
    this.summaries.push(markdown)
  }
}

interface HarnessOptions {
  failOnScanError?: boolean
  terraformRoot?: string
  planError?: Error
  workspaceStatus?: WorkspaceSourceStatus
  payload?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  response?: Partial<ScanResponse>
  scanError?: Error
  inputsError?: Error
}

const HEAD_SHA = '1111111111111111111111111111111111111111'

function createHarness(options: HarnessOptions = {}): {
  dependencies: ActionDependencies
  runtime: FakeRuntime
  calls: { readInputs: number; readPlan: number; scan: number; serializedGithub: Array<GitHubScanContext | undefined> }
} {
  const failOnScanError = options.failOnScanError ?? false
  const apiUrl = 'https://ci.example.test/ci/scans'
  const runtime = new FakeRuntime({ 'api-key': 'draftt-key', 'api-url': apiUrl, 'fail-on-scan-error': String(failOnScanError) })
  const calls = { readInputs: 0, readPlan: 0, scan: 0, serializedGithub: [] as Array<GitHubScanContext | undefined> }
  const inputs: ActionInputs = {
    planJson: 'plan.json',
    apiUrl,
    apiKey: 'draftt-key',
    terraformRoot: options.terraformRoot ?? '.',
    failOnScanError,
  }
  const plan: SanitizedPlan = { format_version: '1.2', resource_changes: [] }

  return {
    runtime,
    calls,
    dependencies: {
      runtime,
      readInputs: () => {
        calls.readInputs += 1
        if (options.inputsError) throw options.inputsError
        return inputs
      },
      readAndSanitizePlan: async () => {
        calls.readPlan += 1
        if (options.planError) throw options.planError
        return plan
      },
      serializeScanRequest: (_plan, _policyIds, github) => {
        calls.serializedGithub.push(github)
        return { body: '{"plan":{}}', sourceMapDropped: false }
      },
      inspectWorkspaceForSourceMapping: async () => options.workspaceStatus ?? 'matched',
      createSourceLocator: async () => ({
        locate: async () => ({ kind: 'unresolved', reason: 'missing_declaration' }),
      }),
      buildSourceMap: async () => ({ sourceMap: { 'aws_db_instance.primary': { path: 'main.tf', startLine: 1 } }, capped: false }),
      buildGitHubContext,
      eventPayload: () => options.payload ?? {},
      env: () => options.env ?? { GITHUB_RUN_ID: '1', GITHUB_SHA: HEAD_SHA },
      scanTerraformPlan: async () => {
        calls.scan += 1
        if (options.scanError) throw options.scanError
        return { ...scanResponse(), ...options.response }
      },
      workspaceRoot: () => '/workspace',
    },
  }
}

const PR = { pull_request: { number: 1, head: { sha: HEAD_SHA } }, repository: { id: 10, owner: { id: 20 } } }
const RUN_URL = 'https://github.com/o/r/runs/1'
const errorSummary = (message: string): string => `## Draftt Terraform Policy Scan\n\nScan error: ${message}`

function assertOutputFields(runtime: FakeRuntime, expected: Record<string, string | number>): void {
  for (const [name, value] of Object.entries(expected)) assert.equal(runtime.outputs.get(name), value, name)
}

test('skips a pull request from an external fork before reading the Draftt key or plan', async () => {
  const fork = { pull_request: { number: 1, head: { repo: { full_name: 'fork/infra' } }, base: { repo: { full_name: 'draftt-io/infra' } } } }
  const sameRepository = { pull_request: { number: 1, head: { repo: { full_name: 'draftt-io/infra' } }, base: { repo: { full_name: 'draftt-io/infra' } } } }
  assert.equal(isExternalFork(sameRepository), false)
  assert.equal(isExternalFork({}), false)

  const harness = createHarness({ payload: fork })
  await run(harness.dependencies)

  assert.equal(harness.runtime.inputReads.includes('api-key'), false)
  assert.equal(harness.calls.readInputs, 0)
  assert.equal(harness.calls.readPlan, 0)
  assert.equal(harness.calls.scan, 0)
  assertOutputFields(harness.runtime, { 'scan-status': 'skipped', 'violation-count': 0, 'warning-count': 0, 'annotation-count': 0, 'check-run-url': '' })
})

test('a pull request upload carries the scan key and source map and reports the check the Draftt CI App published, warning on its publish error', async () => {
  const response: Partial<ScanResponse> = {
    evaluation: { unevaluatedPolicies: [{ policyId: '10', reason: 'inactive' }], componentsWithGaps: [{ policyGaps: [{}, {}] }] },
    checkRunUrl: RUN_URL,
    annotationCount: 4,
    publishError: { code: 'comment', message: 'comment failed' },
  }
  const h = createHarness({ response, payload: PR })
  await run(h.dependencies)

  assert.deepEqual(h.runtime.secrets, ['draftt-key'])
  assert.equal(h.calls.serializedGithub[0]?.scanKey, '.')
  assert.deepEqual(h.calls.serializedGithub[0]?.sourceMap, { 'aws_db_instance.primary': { path: 'main.tf', startLine: 1 } })
  assert.ok(h.runtime.warnings.includes('Draftt CI published the check but could not finish (comment): comment failed'))
  assertOutputFields(h.runtime, { 'scan-status': 'completed', 'violation-count': 1, 'warning-count': 3, 'annotation-count': 4, 'check-run-url': RUN_URL })
  assert.ok(h.runtime.summaries[0]?.includes(`- Check run: ${RUN_URL}`))
  assert.deepEqual(h.runtime.failures, [])
})

test('a push event, or a pull request the App did not publish, completes with counts and no check, and never fails on violations', async () => {
  const cases: Array<[HarnessOptions, boolean]> = [
    [{ payload: { ref: 'refs/heads/main' } }, false],
    [{ payload: PR, response: { publishError: { code: 'not_bound', message: 'no binding' } } }, true],
  ]
  for (const [options, pullRequest] of cases) {
    const h = createHarness(options)
    await run(h.dependencies)
    assert.equal(h.calls.serializedGithub[0] !== undefined, pullRequest)
    assertOutputFields(h.runtime, { 'scan-status': 'completed', 'violation-count': 1, 'annotation-count': 0, 'check-run-url': '' })
    assert.ok(h.runtime.summaries[0]?.includes('- Check run: none published'))
    assert.deepEqual(h.runtime.failures, [])
  }
})

test('scan errors are reported in the job summary and fail the job only with fail-on-scan-error', async () => {
  const failOpen = createHarness({ planError: new Error('Invalid plan') })
  await run(failOpen.dependencies)
  assert.deepEqual(failOpen.runtime.failures, [])
  assert.ok(failOpen.runtime.warnings.includes('Invalid plan'))
  assertOutputFields(failOpen.runtime, { 'scan-status': 'error', 'violation-count': 0, 'warning-count': 0, 'annotation-count': 0, 'check-run-url': '' })

  const enforced = createHarness({ failOnScanError: true, planError: new Error('Invalid plan') })
  await run(enforced.dependencies)
  assert.deepEqual(enforced.runtime.failures, ['Invalid plan'])
  assert.deepEqual(enforced.runtime.summaries, [errorSummary('Invalid plan')])
})

test('explains why the source map is not sent', async () => {
  const cases = [
    ['head_mismatch', 'pull request head commit is not checked out'],
    ['dirty_terraform', 'Terraform source files differ from the checked-out commit'],
    ['git_unavailable', 'Git repository state could not be inspected'],
    ['nested_workspace', 'GITHUB_WORKSPACE is not the repository root'],
  ] as const

  for (const [workspaceStatus, message] of cases) {
    const harness = createHarness({ workspaceStatus, payload: PR })
    await run(harness.dependencies)
    assert.ok(harness.runtime.warnings.some((warning) => warning.includes(message)))
    assert.equal(harness.calls.serializedGithub[0]?.sourceMap, undefined)
  }
})

test('a bad input or a terraform-root outside the workspace is a scan error without scanning', async () => {
  const cases: Array<[HarnessOptions, string]> = [
    [{ inputsError: new Error('policy-ids must be a JSON array of decimal-string ids') }, 'policy-ids must be a JSON array of decimal-string ids'],
    [{ terraformRoot: '/elsewhere' }, 'terraform-root must be a relative path without ".." segments'],
  ]
  for (const [options, message] of cases) {
    const h = createHarness({ ...options, payload: PR })
    await run(h.dependencies)
    assert.equal(h.calls.scan, 0)
    assertOutputFields(h.runtime, { 'scan-status': 'error', 'check-run-url': '' })
    assert.deepEqual(h.runtime.summaries, [errorSummary(message)])
  }
})

// The real client behind the scanTerraformPlan dependency, with fetch stubbed and no retry sleep.
function realScanClient(): ActionDependencies['scanTerraformPlan'] {
  return (apiUrl, apiKey, body) => scanTerraformPlan(apiUrl, apiKey, body, { sleep: async () => {} })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('each HTTP failure, with fail-on-scan-error, fails the job with its user message; only 5xx is retried', async (t) => {
  const cases = [
    { status: 403, body: { status: 403, message: 'owner_mismatch' }, attempts: 1, message: 'Draftt answered 403: owner_mismatch' },
    { status: 413, body: { status: 413, message: 'payload_too_large: plan' }, attempts: 1, message: 'Draftt answered 413: payload_too_large: plan' },
    { status: 422, body: { status: 422, message: 'too_many_scan_keys' }, attempts: 1, message: 'Draftt answered 422: too_many_scan_keys' },
    { status: 500, body: { status: 500, message: 'internal error' }, attempts: 3, message: 'Draftt could not complete the scan' },
  ]
  for (const item of cases) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(item.status, item.body))
    const h = createHarness({ failOnScanError: true, payload: PR })
    h.dependencies.scanTerraformPlan = realScanClient()
    await run(h.dependencies)
    fetchMock.mock.restore()
    assert.equal(fetchMock.mock.callCount(), item.attempts, String(item.status))
    assertOutputFields(h.runtime, { 'scan-status': 'error', 'check-run-url': '' })
    assert.deepEqual(h.runtime.failures, [item.message])
  }
})

test('the github block is built from a pull_request payload, and not for other events or a missing, zero or non-decimal id', () => {
  const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'draftt-io/infra' }
  const payload = { pull_request: { number: 7 }, repository: { id: 10, owner: { id: 20 } } }
  const base = { env, headSha: HEAD_SHA, scanKey: 'modules/eks' }
  assert.deepEqual(buildGitHubContext({ ...base, payload }), {
    repositoryId: 10, repositoryOwnerId: 20, pullRequestNumber: 7, headSha: HEAD_SHA, scanKey: 'modules/eks', runId: 42, runAttempt: 2,
    workflowRunUrl: 'https://github.com/draftt-io/infra/actions/runs/42',
  })
  const invalid = [
    { repository: payload.repository },
    { merge_group: { head_sha: HEAD_SHA }, repository: payload.repository },
    { pull_request: { number: 7 } },
    { ...payload, pull_request: { number: 0 } },
    { ...payload, repository: { id: 0, owner: { id: 20 } } },
  ]
  for (const bad of invalid) assert.equal(buildGitHubContext({ ...base, payload: bad }), undefined, JSON.stringify(bad))
  for (const runId of ['0', ' 42 ', '0x2a', '42.0', '']) assert.equal(buildGitHubContext({ ...base, env: { ...env, GITHUB_RUN_ID: runId }, payload }), undefined, runId)
})
