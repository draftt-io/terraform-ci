import assert from 'node:assert/strict'
import test from 'node:test'
import type { ScanResponse } from '../src/contracts.ts'
import { ScanRequestFailure, scanTerraformPlan } from '../src/api.ts'
import { CHECK_NAME, FALLBACK_CHECK_NAME } from '../src/github-check.ts'
import type { CheckAnnotation, CheckConclusion } from '../src/github-check.ts'
import type { ActionInputs } from '../src/inputs.ts'
import { completedConclusion, scanErrorConclusion } from '../src/outcome.ts'
import type { SanitizedPlan } from '../src/plan.ts'
import type { GitHubScanContext } from '../src/request.ts'
import type { ScanReport } from '../src/report.ts'
import { run, type ActionDependencies, type ActionRuntime, type CheckPublisherLike } from '../src/run.ts'
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

class FakePublisher implements CheckPublisherLike {
  annotationCount = 0
  starts = 0
  checkRunUrl: string | undefined
  readonly conclusions: CheckConclusion[] = []
  readonly names: string[] = []
  readonly completed: Array<{ conclusion: CheckConclusion; title: string; annotations: number }> = []
  failFinish = false
  failCompleted = false
  readonly events: string[]

  constructor(events: string[]) {
    this.events = events
  }

  async start(): Promise<void> {
    this.events.push('start')
    this.starts += 1
    this.checkRunUrl = 'https://github.com/o/r/runs/8'
  }

  async publishAnnotations(annotations: CheckAnnotation[]): Promise<void> {
    this.annotationCount += annotations.length
  }

  async finish(conclusion: CheckConclusion): Promise<void> {
    if (this.failFinish) throw new Error('GitHub finish failed')
    this.conclusions.push(conclusion)
  }

  async publishCompleted(conclusion: CheckConclusion, title: string, _summary: string, annotations: CheckAnnotation[]): Promise<void> {
    if (this.failCompleted) throw new Error('GitHub create failed')
    this.completed.push({ conclusion, title, annotations: annotations.length })
    this.annotationCount += annotations.length
    this.checkRunUrl = 'https://github.com/o/r/runs/9'
  }
}

interface HarnessOptions {
  externalFork?: boolean
  failOnViolations?: boolean
  failOnScanError?: boolean
  report?: ScanReport
  planError?: Error
  workspaceStatus?: WorkspaceSourceStatus
  publishMode?: 'server' | 'action'
  apiUrl?: string
  githubToken?: string | null
  payload?: Record<string, unknown>
  response?: Partial<ScanResponse>
  scanError?: Error
  inputsError?: Error
  sourceMapCapped?: boolean
  sourceMapDropped?: boolean
}

function createHarness(options: HarnessOptions = {}): {
  dependencies: ActionDependencies
  runtime: FakeRuntime
  publisher: FakePublisher
  events: string[]
  calls: { readInputs: number; readPlan: number; scan: number; githubContext: number; sourceMap: number; serializedGithub: Array<GitHubScanContext | undefined> }
} {
  const failOnViolations = options.failOnViolations ?? false
  const failOnScanError = options.failOnScanError ?? false
  const apiUrl = options.apiUrl ?? 'https://draftt-ci.draftt.io/v1/scans'
  const runtimeInputs: Record<string, string> = { 'api-key': 'draftt-key', 'api-url': apiUrl, 'fail-on-scan-error': String(failOnScanError) }
  if (options.githubToken !== null) runtimeInputs['github-token'] = options.githubToken ?? 'github-token'
  if (options.publishMode) runtimeInputs['publish-mode'] = options.publishMode
  const runtime = new FakeRuntime(runtimeInputs)
  const events: string[] = []
  const publisher = new FakePublisher(events)
  const calls = { readInputs: 0, readPlan: 0, scan: 0, githubContext: 0, sourceMap: 0, serializedGithub: [] as Array<GitHubScanContext | undefined> }
  const inputs: ActionInputs = {
    planJson: 'plan.json',
    apiUrl,
    apiKey: 'draftt-key',
    ...(options.githubToken === null ? {} : { githubToken: options.githubToken ?? 'github-token' }),
    terraformRoot: '.',
    failOnViolations,
    failOnScanError,
    publishMode: options.publishMode ?? 'server',
  }
  const plan: SanitizedPlan = { format_version: '1.2', resource_changes: [] }
  const response: ScanResponse = scanResponse()
  const report = options.report ?? {
    title: 'One violation',
    summary: 'Summary',
    annotations: [{
      path: 'main.tf',
      start_line: 1,
      end_line: 1,
      annotation_level: failOnViolations ? 'failure' : 'warning',
      message: 'Violation',
      title: 'Draftt policy violation',
    }],
    violationCount: 1,
    warningCount: 2,
  }

  return {
    runtime,
    publisher,
    events,
    calls,
    dependencies: {
      runtime,
      isExternalFork: () => options.externalFork ?? false,
      getHeadSha: () => '1111111111111111111111111111111111111111',
      createPublisher: (_token, _headSha, name) => {
        publisher.names.push(name ?? 'default')
        return publisher
      },
      readInputs: () => {
        events.push('readInputs')
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
        return { body: '{"plan":{}}', sourceMapDropped: options.sourceMapDropped ?? false }
      },
      inspectWorkspaceForSourceMapping: async () => options.workspaceStatus ?? 'matched',
      createSourceLocator: async () => ({
        locate: async () => ({ kind: 'unresolved', reason: 'missing_declaration' }),
      }),
      buildSourceMap: async () => {
        calls.sourceMap += 1
        return { sourceMap: { 'aws_db_instance.primary': { path: 'main.tf', startLine: 1 } }, capped: options.sourceMapCapped ?? false }
      },
      buildGitHubContext: (input) => {
        calls.githubContext += 1
        if (!options.payload?.pull_request) return undefined
        return {
          repositoryId: 10,
          repositoryOwnerId: 20,
          pullRequestNumber: 1,
          headSha: input.headSha,
          scanKey: input.scanKey,
          runId: 1,
          runAttempt: 1,
          failOnViolations: input.failOnViolations,
          ...(input.sourceMap ? { sourceMap: input.sourceMap } : {}),
        }
      },
      eventPayload: () => options.payload ?? {},
      env: () => ({}),
      scanTerraformPlan: async () => {
        calls.scan += 1
        if (options.scanError) throw options.scanError
        return { ...response, ...options.response }
      },
      buildScanReport: async () => report,
      completedConclusion,
      scanErrorConclusion,
      workspaceRoot: () => '/workspace',
    },
  }
}

test('skips an external fork before reading the Draftt key or plan', async () => {
  const harness = createHarness({ externalFork: true })
  await run(harness.dependencies)

  assert.equal(harness.runtime.inputReads.includes('api-key'), false)
  assert.equal(harness.calls.readInputs, 0)
  assert.equal(harness.calls.readPlan, 0)
  assert.equal(harness.calls.scan, 0)
  assert.deepEqual(harness.publisher.conclusions, ['skipped'])
  assertOutputs(harness.runtime, 'skipped', 0, 0, 0)
})

test('completes a report-only scan without failing the workflow', async () => {
  const harness = createHarness()
  await run(harness.dependencies)

  assert.deepEqual(harness.runtime.secrets, ['draftt-key', 'github-token'])
  assert.deepEqual(harness.publisher.conclusions, ['neutral'])
  assert.equal(harness.runtime.failures.length, 0)
  assertOutputs(harness.runtime, 'completed', 1, 2, 1)
})

test('fails only when violation enforcement is enabled', async () => {
  const harness = createHarness({ failOnViolations: true })
  await run(harness.dependencies)

  assert.deepEqual(harness.publisher.conclusions, ['failure'])
  assert.deepEqual(harness.runtime.failures, ['Draftt found policy violations in 1 Terraform resources.'])
  assertOutputs(harness.runtime, 'completed', 1, 2, 1)
})

test('scan errors keep the real warning count and remain fail-open by default', async () => {
  const harness = createHarness({ planError: new Error('Invalid plan') })
  await run(harness.dependencies)

  assert.deepEqual(harness.publisher.conclusions, ['neutral'])
  assert.equal(harness.runtime.failures.length, 0)
  assert.ok(harness.runtime.warnings.includes('Invalid plan'))
  assertOutputs(harness.runtime, 'error', 0, 0, 0)
})

test('scan errors fail when scan-error enforcement is enabled', async () => {
  const harness = createHarness({ failOnScanError: true, planError: new Error('Invalid plan') })
  await run(harness.dependencies)

  assert.deepEqual(harness.publisher.conclusions, ['failure'])
  assert.deepEqual(harness.runtime.failures, ['Invalid plan'])
  assertOutputs(harness.runtime, 'error', 0, 0, 0)
})

test('reports a Check finalization failure through scan-error behavior', async () => {
  const harness = createHarness()
  harness.publisher.failFinish = true
  await run(harness.dependencies)

  assert.equal(harness.runtime.outputs.get('scan-status'), 'error')
  assert.ok(harness.runtime.warnings.includes('The Draftt GitHub Check could not be finalized.'))
  assert.ok(harness.runtime.warnings.includes('GitHub finish failed'))
})

test('explains why source annotations are suppressed', async () => {
  const cases = [
    ['head_mismatch', 'pull request head commit is not checked out'],
    ['dirty_terraform', 'Terraform source files differ from the checked-out commit'],
    ['git_unavailable', 'Git repository state could not be inspected'],
    ['nested_workspace', 'GITHUB_WORKSPACE is not the repository root'],
  ] as const

  for (const [workspaceStatus, message] of cases) {
    const harness = createHarness({ workspaceStatus })
    await run(harness.dependencies)
    assert.ok(harness.runtime.warnings.some((warning) => warning.includes(message)))
  }
})

function assertOutputs(
  runtime: FakeRuntime,
  status: 'completed' | 'skipped' | 'error',
  violations: number,
  warnings: number,
  annotations: number,
): void {
  assert.equal(runtime.outputs.get('scan-status'), status)
  assert.equal(runtime.outputs.get('violation-count'), violations)
  assert.equal(runtime.outputs.get('warning-count'), warnings)
  assert.equal(runtime.outputs.get('annotation-count'), annotations)
}

const PR = { pull_request: { number: 1 } }

function assertOutputFields(runtime: FakeRuntime, expected: Record<string, string | number>): void {
  for (const [name, value] of Object.entries(expected)) assert.equal(runtime.outputs.get(name), value, name)
}

test('server mode with checkRunUrl publishes nothing itself and reports the server publisher', async () => {
  const h = createHarness({ response: { checkRunUrl: 'https://github.com/o/r/runs/1', annotationCount: 4 }, payload: PR })
  await run(h.dependencies)
  assert.equal(h.publisher.starts, 0)
  assert.deepEqual(h.publisher.names, [])
  assert.equal(h.calls.serializedGithub[0]?.scanKey, '.')
  assert.deepEqual(h.calls.serializedGithub[0]?.sourceMap, { 'aws_db_instance.primary': { path: 'main.tf', startLine: 1 } })
  assertOutputFields(h.runtime, { 'scan-status': 'completed', 'violation-count': 1, 'warning-count': 2, 'annotation-count': 4, 'check-run-url': 'https://github.com/o/r/runs/1', publisher: 'server' })
  assert.deepEqual(h.runtime.failures, [])
})

test('server mode with checkRunUrl and publishError only warns with the code', async () => {
  const h = createHarness({ response: { checkRunUrl: 'https://github.com/o/r/runs/1', publishError: { code: 'comment', message: 'comment failed' } }, payload: PR })
  await run(h.dependencies)
  assert.ok(h.runtime.warnings.some((w) => w.includes('(comment)') && w.includes('comment failed')))
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'server', 'check-run-url': 'https://github.com/o/r/runs/1' })
  assert.deepEqual(h.publisher.names, [])
})

test('server mode with publishError only publishes one completed fallback check named (Action)', async () => {
  const h = createHarness({ response: { publishError: { code: 'not_bound', message: 'no binding' } }, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.publisher.names, [FALLBACK_CHECK_NAME])
  assert.equal(h.publisher.starts, 0)
  assert.deepEqual(h.publisher.completed, [{ conclusion: 'neutral', title: 'One violation', annotations: 1 }])
  assert.ok(h.runtime.warnings.some((w) => w.includes('(not_bound)')))
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'action', 'annotation-count': 1, 'check-run-url': 'https://github.com/o/r/runs/9' })
})

test('server mode with neither checkRunUrl nor publishError also publishes the fallback check', async () => {
  const h = createHarness({ payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.publisher.names, [FALLBACK_CHECK_NAME])
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'action' })
})

test('server mode without a token and without checkRunUrl reports publisher none', async () => {
  const h = createHarness({ githubToken: null, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.publisher.names, [])
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'none', 'check-run-url': '', 'annotation-count': 0 })
})

test('a fallback publish failure is a warning, not a scan error', async () => {
  const h = createHarness({ payload: PR })
  h.publisher.failCompleted = true
  await run(h.dependencies)
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'none' })
  assert.ok(h.runtime.warnings.includes('The Draftt fallback check could not be published.'))
})

test('server mode HTTP failure posts the (Action) error check when a token exists and honours fail-on-scan-error', async () => {
  const h = createHarness({ scanError: new Error('Draftt could not complete the scan'), failOnScanError: true, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.publisher.names, [FALLBACK_CHECK_NAME])
  assert.deepEqual(h.publisher.completed.map((c) => [c.conclusion, c.title]), [['failure', 'Terraform policy scan could not complete']])
  assertOutputFields(h.runtime, { 'scan-status': 'error', publisher: 'action' })
  assert.deepEqual(h.runtime.failures, ['Draftt could not complete the scan'])
})

test('owner_mismatch surfaces the binding message', async () => {
  const h = createHarness({ scanError: Object.assign(new Error('Draftt CI is bound to a different GitHub organization'), { code: 'owner_mismatch' }), payload: PR })
  await run(h.dependencies)
  assert.ok(h.runtime.warnings.includes('Draftt CI is bound to a different GitHub organization'))
  assertOutputFields(h.runtime, { 'scan-status': 'error' })
})

test('server mode fails the job only for violations with fail-on-violations', async () => {
  const h = createHarness({ failOnViolations: true, response: { checkRunUrl: 'https://github.com/o/r/runs/1' }, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.runtime.failures, ['Draftt found policy violations in 1 Terraform resources.'])
})

test('a trailing slash on api-url still selects the server flow', async () => {
  const h = createHarness({ apiUrl: 'https://draftt-ci.draftt.io/v1/scans/', response: { checkRunUrl: 'https://github.com/o/r/runs/1' }, payload: PR })
  await run(h.dependencies)
  assert.equal(h.publisher.starts, 0)
  assertOutputFields(h.runtime, { publisher: 'server' })
})

test('a push event against /v1/scans runs the v0.1.1 flow under the v0.1.1 check name with no github block', async () => {
  const h = createHarness()
  await run(h.dependencies)
  assert.equal(h.calls.githubContext, 1)
  assert.deepEqual(h.calls.serializedGithub, [undefined])
  assert.deepEqual(h.publisher.names, [CHECK_NAME])
  assert.equal(h.publisher.starts, 1)
  assert.deepEqual(h.publisher.conclusions, ['neutral'])
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'action', 'check-run-url': 'https://github.com/o/r/runs/8' })
})

test('the ui-backend api-url on a PR runs the v0.1.1 flow under the v0.1.1 check name', async () => {
  const h = createHarness({ apiUrl: 'https://api.draftt.io/ci/scanTerraformPlan', payload: PR })
  await run(h.dependencies)
  assert.equal(h.calls.githubContext, 0)
  assert.deepEqual(h.calls.serializedGithub, [undefined])
  assert.deepEqual(h.publisher.names, [CHECK_NAME])
  assert.equal(h.publisher.starts, 1)
})

test('action mode on a PR keeps the v0.1.1 flow: in_progress check first, annotations, finish', async () => {
  const h = createHarness({ publishMode: 'action', payload: PR })
  await run(h.dependencies)
  assert.equal(h.publisher.starts, 1)
  assert.deepEqual(h.publisher.conclusions, ['neutral'])
  assert.deepEqual(h.publisher.names, [CHECK_NAME])
  assert.deepEqual(h.calls.serializedGithub, [undefined])
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'action', 'annotation-count': 1 })
})

test('action mode starts the check before reading inputs, so a bad input still concludes it', async () => {
  const h = createHarness({ publishMode: 'action', payload: PR, inputsError: new Error('policy-ids must be a JSON array of decimal-string ids') })
  await run(h.dependencies)
  assert.deepEqual(h.events, ['start', 'readInputs'])
  assert.deepEqual(h.publisher.conclusions, ['neutral'])
  assertOutputFields(h.runtime, { 'scan-status': 'error', publisher: 'action' })
  assert.ok(h.runtime.warnings.includes('policy-ids must be a JSON array of decimal-string ids'))
})

test('action mode requires github-token', async () => {
  const h = createHarness({ publishMode: 'action', githubToken: null })
  await run(h.dependencies)
  assert.equal(h.publisher.starts, 0)
  assertOutputFields(h.runtime, { 'scan-status': 'error', publisher: 'none' })
})

test('server mode builds the source map only when the workspace matched, and warns when it is capped or dropped', async () => {
  const matched = createHarness({ workspaceStatus: 'matched', payload: PR })
  await run(matched.dependencies)
  assert.equal(matched.calls.sourceMap, 1)
  const nested = createHarness({ workspaceStatus: 'nested_workspace', payload: PR })
  await run(nested.dependencies)
  assert.equal(nested.calls.sourceMap, 0)
  assert.equal(nested.calls.serializedGithub[0]?.sourceMap, undefined)
  assert.ok(nested.runtime.warnings.some((w) => w.includes('not the repository root')))
  const capped = createHarness({ sourceMapCapped: true, payload: PR })
  await run(capped.dependencies)
  assert.ok(capped.runtime.warnings.some((w) => w.includes('capped at 100000')))
  const dropped = createHarness({ sourceMapDropped: true, payload: PR })
  await run(dropped.dependencies)
  assert.ok(dropped.runtime.warnings.some((w) => w.includes('dropped to keep the upload under 50 MiB')))
})

test('server mode resolves an absolute terraform-root against the workspace root for the scan key', async () => {
  const workspace = createHarness({ response: { checkRunUrl: 'https://github.com/o/r/runs/1' }, payload: PR })
  const readWorkspaceInputs = workspace.dependencies.readInputs
  workspace.dependencies.readInputs = (runtime) => ({ ...readWorkspaceInputs(runtime), terraformRoot: '/workspace' })
  await run(workspace.dependencies)
  assert.equal(workspace.calls.serializedGithub[0]?.scanKey, '.')
  assertOutputFields(workspace.runtime, { 'scan-status': 'completed', publisher: 'server' })

  const nested = createHarness({ response: { checkRunUrl: 'https://github.com/o/r/runs/1' }, payload: PR })
  const readNestedInputs = nested.dependencies.readInputs
  nested.dependencies.readInputs = (runtime) => ({ ...readNestedInputs(runtime), terraformRoot: '/workspace/modules//eks/' })
  await run(nested.dependencies)
  assert.equal(nested.calls.serializedGithub[0]?.scanKey, 'modules/eks')

  const outside = createHarness({ payload: PR })
  const readOutsideInputs = outside.dependencies.readInputs
  outside.dependencies.readInputs = (runtime) => ({ ...readOutsideInputs(runtime), terraformRoot: '/elsewhere' })
  await run(outside.dependencies)
  assert.equal(outside.calls.scan, 0)
  assert.deepEqual(outside.publisher.completed.map((c) => [c.conclusion, c.title]), [['neutral', 'Terraform policy scan could not complete']])
  assert.ok(outside.runtime.warnings.includes('terraform-root must be a relative path without ".." segments'))
  assertOutputFields(outside.runtime, { 'scan-status': 'error', publisher: 'action' })
})

// The real client behind the scanTerraformPlan dependency, with fetch stubbed and no retry sleep,
// so these tests pin the error shape the run receives, not just the run's reaction to it.
function realScanClient(captured: unknown[]): ActionDependencies['scanTerraformPlan'] {
  return async (apiUrl, apiKey, body) => {
    try {
      return await scanTerraformPlan(apiUrl, apiKey, body, { sleep: async () => {} })
    } catch (error) {
      captured.push(error)
      throw error
    }
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

test('a 403 owner_mismatch reaches the run as ScanRequestFailure 403/owner_mismatch and posts nothing without a token', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(403, { code: 'owner_mismatch', message: 'bound elsewhere' }))
  const captured: unknown[] = []
  const h = createHarness({ githubToken: null, payload: PR })
  h.dependencies.scanTerraformPlan = realScanClient(captured)
  await run(h.dependencies)
  const failure = captured[0]
  assert.ok(failure instanceof ScanRequestFailure)
  assert.deepEqual({ status: failure.status, code: failure.code }, { status: 403, code: 'owner_mismatch' })
  assert.deepEqual(h.publisher.names, [])
  assert.ok(h.runtime.warnings.includes('Draftt CI is bound to a different GitHub organization'))
  assertOutputFields(h.runtime, { 'scan-status': 'error', publisher: 'none', 'check-run-url': '' })
})

test('an exhausted 429 or a 502 reaches the run as ScanRequestFailure with its status and the run posts the (Action) error check', async (t) => {
  const cases = [
    { status: 429, headers: { 'retry-after': '0' }, body: { code: 'rate_limited' }, message: 'Draftt rate limited the scan request' },
    { status: 502, headers: {}, body: { code: 'dependency_failed' }, message: 'Draftt could not complete the scan' },
  ]
  for (const item of cases) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(item.status, item.body, item.headers))
    const captured: unknown[] = []
    const h = createHarness({ payload: PR })
    h.dependencies.scanTerraformPlan = realScanClient(captured)
    await run(h.dependencies)
    fetchMock.mock.restore()
    const failure = captured[0]
    assert.ok(failure instanceof ScanRequestFailure)
    assert.deepEqual({ status: failure.status, code: failure.code }, { status: item.status, code: undefined })
    assert.equal(fetchMock.mock.callCount(), 3)
    assert.deepEqual(h.publisher.names, [FALLBACK_CHECK_NAME])
    assert.deepEqual(h.publisher.completed.map((c) => [c.conclusion, c.title]), [['neutral', 'Terraform policy scan could not complete']])
    assert.ok(h.runtime.warnings.includes(item.message))
    assertOutputFields(h.runtime, { 'scan-status': 'error', publisher: 'action', 'check-run-url': 'https://github.com/o/r/runs/9' })
  }
})
