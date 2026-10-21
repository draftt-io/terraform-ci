import assert from 'node:assert/strict'
import test from 'node:test'
import type { ScanResponse } from '../src/contracts.ts'
import { scanTerraformPlan } from '../src/api.ts'
import { CHECK_NAME, FALLBACK_CHECK_NAME } from '../src/github-check.ts'
import type { AnnotatedCheckCompletion, AnnotationLevel, CheckAnnotation, CheckCompletion, CheckConclusion } from '../src/github-check.ts'
import type { ActionInputs } from '../src/inputs.ts'
import { scanErrorConclusion, violationConclusion } from '../src/outcome.ts'
import type { SanitizedPlan } from '../src/plan.ts'
import { buildGitHubContext, type GitHubScanContext } from '../src/request.ts'
import type { ReportRepository, ScanReport } from '../src/report.ts'
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

  async start(): Promise<void> {
    this.starts += 1
    this.checkRunUrl = 'https://github.com/o/r/runs/8'
  }

  async publishAnnotations(annotations: CheckAnnotation[]): Promise<void> {
    this.annotationCount += annotations.length
  }

  async finish({ conclusion }: CheckCompletion): Promise<void> {
    if (this.failFinish) throw new Error('GitHub finish failed')
    this.conclusions.push(conclusion)
  }

  async publishCompleted({ conclusion, title, annotations }: AnnotatedCheckCompletion): Promise<void> {
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
  terraformRoot?: string
  report?: ScanReport
  planError?: Error
  workspaceStatus?: WorkspaceSourceStatus
  publishMode?: 'server' | 'action'
  apiUrl?: string
  githubToken?: string | null
  payload?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  response?: Partial<ScanResponse>
  scanError?: Error
  inputsError?: Error
}

function createHarness(options: HarnessOptions = {}): {
  dependencies: ActionDependencies
  runtime: FakeRuntime
  publisher: FakePublisher
  calls: { readInputs: number; readPlan: number; scan: number; serializedGithub: Array<GitHubScanContext | undefined>; levels: AnnotationLevel[]; repositories: Array<ReportRepository | undefined> }
} {
  const failOnScanError = options.failOnScanError ?? false
  const apiUrl = options.apiUrl ?? 'https://ci.example.test/ci/scans'
  const runtimeInputs: Record<string, string> = { 'api-key': 'draftt-key', 'api-url': apiUrl, 'fail-on-scan-error': String(failOnScanError) }
  if (options.githubToken !== null) runtimeInputs['github-token'] = options.githubToken ?? 'github-token'
  if (options.publishMode) runtimeInputs['publish-mode'] = options.publishMode
  const runtime = new FakeRuntime(runtimeInputs)
  const publisher = new FakePublisher()
  const calls = { readInputs: 0, readPlan: 0, scan: 0, serializedGithub: [] as Array<GitHubScanContext | undefined>, levels: [] as AnnotationLevel[], repositories: [] as Array<ReportRepository | undefined> }
  const inputs: ActionInputs = {
    planJson: 'plan.json',
    apiUrl,
    apiKey: 'draftt-key',
    ...(options.githubToken === null ? {} : { githubToken: options.githubToken ?? 'github-token' }),
    terraformRoot: options.terraformRoot ?? '.',
    failOnViolations: options.failOnViolations ?? false,
    failOnScanError,
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
      annotation_level: 'warning',
      message: 'Violation',
      title: 'Draftt policy violation',
    }],
    violationCount: 1,
    warningCount: 2,
  }

  return {
    runtime,
    publisher,
    calls,
    dependencies: {
      runtime,
      isExternalFork: () => options.externalFork ?? false,
      getHeadSha: () => '1111111111111111111111111111111111111111',
      createPublisher: ({ name }) => {
        publisher.names.push(name ?? 'default')
        return publisher
      },
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
      env: () => options.env ?? { GITHUB_RUN_ID: '1' },
      scanTerraformPlan: async () => {
        calls.scan += 1
        if (options.scanError) throw options.scanError
        return { ...response, ...options.response }
      },
      buildScanReport: async ({ annotationLevel, repository }) => {
        calls.levels.push(annotationLevel)
        calls.repositories.push(repository)
        return report
      },
      violationConclusion,
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
  assertOutputFields(harness.runtime, { 'check-run-url': '', publisher: 'none' })
})

test('completes a report-only scan without failing the workflow', async () => {
  const harness = createHarness()
  await run(harness.dependencies)

  assert.deepEqual(harness.runtime.secrets, ['draftt-key', 'github-token'])
  assert.deepEqual(harness.publisher.conclusions, ['neutral'])
  assert.equal(harness.runtime.failures.length, 0)
  assertOutputs(harness.runtime, 'completed', 1, 2, 1)
})

test('action mode, a push event and the ui-backend api-url run the v0.1.1 check flow and never fail on violations', async () => {
  const cases: HarnessOptions[] = [
    { publishMode: 'action', payload: { pull_request: { number: 1 } } },
    {},
    { apiUrl: 'https://api.draftt.io/ci/scanTerraformPlan', payload: { pull_request: { number: 1 } } },
  ]
  for (const options of cases) {
    const harness = createHarness({ ...options, failOnViolations: true })
    await run(harness.dependencies)

    assert.deepEqual(harness.calls.serializedGithub, [undefined])
    assert.deepEqual(harness.publisher.names, [CHECK_NAME])
    assert.deepEqual(harness.publisher.conclusions, ['neutral'])
    assert.deepEqual(harness.calls.levels, ['warning'])
    assert.deepEqual(harness.runtime.failures, [])
    assertOutputs(harness.runtime, 'completed', 1, 2, 1)
    assertOutputFields(harness.runtime, { 'check-run-url': 'https://github.com/o/r/runs/8', publisher: 'action' })
  }
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
  assert.ok(harness.runtime.warnings.includes('The Draftt GitHub Check could not be finalized: GitHub finish failed'))
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

const PR = { pull_request: { number: 1 }, repository: { id: 10, owner: { id: 20 } } }
const RUN_URL = 'https://github.com/o/r/runs/1'
const ERROR_TITLE = 'Terraform policy scan could not complete'
const errorSummary = (message: string): string => `## Draftt Terraform Policy Scan\n\nScan error: ${message}`

function assertOutputFields(runtime: FakeRuntime, expected: Record<string, string | number>): void {
  for (const [name, value] of Object.entries(expected)) assert.equal(runtime.outputs.get(name), value, name)
}

test('server mode with a published check posts nothing itself, even when the server reports a publish error', async () => {
  const h = createHarness({ response: { checkRunUrl: RUN_URL, annotationCount: 4, publishError: { code: 'comment', message: 'comment failed' } }, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.publisher.names, [])
  assert.equal(h.calls.serializedGithub[0]?.scanKey, '.')
  assert.deepEqual(h.calls.serializedGithub[0]?.sourceMap, { 'aws_db_instance.primary': { path: 'main.tf', startLine: 1 } })
  assertOutputFields(h.runtime, { 'scan-status': 'completed', 'violation-count': 1, 'warning-count': 2, 'annotation-count': 4, 'check-run-url': RUN_URL, publisher: 'server' })
  assert.deepEqual(h.runtime.failures, [])
})

test('server mode without a published check posts one completed (Action) fallback check: neutral with violations, success without', async () => {
  const clean: ScanReport = { title: 'No policy violations found', summary: 'S', annotations: [], violationCount: 0, warningCount: 0 }
  const cases: Array<[HarnessOptions, CheckConclusion, number]> = [
    [{ response: { publishError: { code: 'not_bound', message: 'no binding' } } }, 'neutral', 1],
    [{}, 'neutral', 1],
    [{ report: clean }, 'success', 0],
  ]
  for (const [options, conclusion, annotations] of cases) {
    const h = createHarness({ ...options, failOnViolations: true, payload: PR })
    await run(h.dependencies)
    assert.deepEqual(h.publisher.names, [FALLBACK_CHECK_NAME])
    assert.equal(h.publisher.starts, 0)
    assert.deepEqual(h.publisher.completed.map((c) => [c.conclusion, c.annotations]), [[conclusion, annotations]])
    assert.deepEqual(h.runtime.failures, [])
    assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'action', 'annotation-count': annotations, 'check-run-url': 'https://github.com/o/r/runs/9' })
  }
})

test('without a github-token, or when the fallback or error check cannot be published, the scan status stands and the job passes', async () => {
  const noToken = createHarness({ githubToken: null, failOnViolations: true, payload: PR })
  await run(noToken.dependencies)
  assert.deepEqual(noToken.publisher.names, [])
  assertOutputFields(noToken.runtime, { 'scan-status': 'completed', publisher: 'none', 'check-run-url': '', 'annotation-count': 0 })
  assert.deepEqual(noToken.runtime.failures, [])

  const fallback = createHarness({ payload: PR })
  fallback.publisher.failCompleted = true
  await run(fallback.dependencies)
  assertOutputFields(fallback.runtime, { 'scan-status': 'completed', publisher: 'none', 'check-run-url': '' })

  const errorCheck = createHarness({ scanError: new Error('Draftt could not complete the scan'), payload: PR })
  errorCheck.publisher.failCompleted = true
  await run(errorCheck.dependencies)
  assertOutputFields(errorCheck.runtime, { 'scan-status': 'error', publisher: 'none', 'check-run-url': '' })
  assert.deepEqual(errorCheck.runtime.failures, [])
  assert.deepEqual(errorCheck.runtime.summaries, [errorSummary('Draftt could not complete the scan')])
})

test('a bad input or a terraform-root outside the workspace is reported on the (Action) error check without scanning', async () => {
  const cases: Array<[HarnessOptions, string]> = [
    [{ inputsError: new Error('policy-ids must be a JSON array of decimal-string ids') }, 'policy-ids must be a JSON array of decimal-string ids'],
    [{ terraformRoot: '/elsewhere' }, 'terraform-root must be a relative path without ".." segments'],
  ]
  for (const [options, message] of cases) {
    const h = createHarness({ ...options, payload: PR })
    await run(h.dependencies)
    assert.equal(h.calls.scan, 0)
    assert.deepEqual(h.publisher.completed.map((c) => [c.conclusion, c.title]), [['neutral', ERROR_TITLE]])
    assertOutputFields(h.runtime, { 'scan-status': 'error', publisher: 'action', 'check-run-url': 'https://github.com/o/r/runs/9' })
    assert.deepEqual(h.runtime.summaries, [errorSummary(message)])
  }
})

test('action mode concludes its check on a bad input and refuses to run without github-token', async () => {
  const badInput = createHarness({ publishMode: 'action', payload: PR, inputsError: new Error('policy-ids must be a JSON array of decimal-string ids') })
  await run(badInput.dependencies)
  assert.deepEqual(badInput.publisher.conclusions, ['neutral'])
  assertOutputFields(badInput.runtime, { 'scan-status': 'error', publisher: 'action', 'check-run-url': 'https://github.com/o/r/runs/8' })

  const noToken = createHarness({ publishMode: 'action', githubToken: null })
  await run(noToken.dependencies)
  assert.equal(noToken.publisher.starts, 0)
  assertOutputFields(noToken.runtime, { 'scan-status': 'error', publisher: 'none' })
})

// The real client behind the scanTerraformPlan dependency, with fetch stubbed and no retry sleep.
function realScanClient(): ActionDependencies['scanTerraformPlan'] {
  return (apiUrl, apiKey, body) => scanTerraformPlan(apiUrl, apiKey, body, { sleep: async () => {} })
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

test('each HTTP failure posts the (Action) error check and, with fail-on-scan-error, fails the job with its user message; only 429 and 502 are retried', async (t) => {
  const cases = [
    { status: 403, body: { code: 'owner_mismatch', message: 'bound elsewhere' }, attempts: 1, message: 'Draftt CI is bound to a different GitHub organization' },
    { status: 408, body: { code: 'upload_timeout', message: 'The upload did not finish within 240 s; send the body gzip-compressed' }, attempts: 1, message: 'The upload did not finish within 240 s; send the body gzip-compressed' },
    { status: 422, body: { code: 'too_many_scan_keys', message: 'This commit already has 50 Draftt scan keys' }, attempts: 1, message: 'This commit already has 50 Draftt CI scans, the most Draftt CI accepts per commit (one per terraform-root).' },
    { status: 429, body: { code: 'rate_limited' }, attempts: 3, message: 'Draftt rate limited the scan request' },
    { status: 502, body: { code: 'dependency_failed' }, attempts: 3, message: 'Draftt could not complete the scan' },
  ]
  for (const item of cases) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(item.status, item.body, { 'retry-after': '0' }))
    const h = createHarness({ failOnScanError: true, payload: PR })
    h.dependencies.scanTerraformPlan = realScanClient()
    await run(h.dependencies)
    fetchMock.mock.restore()
    assert.equal(fetchMock.mock.callCount(), item.attempts, String(item.status))
    assert.deepEqual(h.publisher.completed.map((c) => [c.conclusion, c.title]), [['failure', ERROR_TITLE]])
    assertOutputFields(h.runtime, { 'scan-status': 'error', publisher: 'action', 'check-run-url': 'https://github.com/o/r/runs/9' })
    assert.deepEqual(h.runtime.failures, [item.message])
  }
})

const HEAD_SHA = '1111111111111111111111111111111111111111'
const REPOSITORY = { id: 10, owner: { id: 20, login: 'draftt-io' }, name: 'infra' }

test('path:line links point at the head commit of the payload repository, or of GITHUB_REPOSITORY on a push, in every flow', async () => {
  const linked = { owner: 'draftt-io', repo: 'infra', headSha: HEAD_SHA }
  const cases: Array<[HarnessOptions, ReportRepository | undefined]> = [
    [{ publishMode: 'action', payload: { ...PR, repository: REPOSITORY } }, linked],
    [{ payload: { ref: 'refs/heads/main' }, env: { GITHUB_REPOSITORY: 'draftt-io/infra' } }, linked],
    [{ payload: { ...PR, repository: REPOSITORY } }, linked],
    [{ publishMode: 'action', payload: PR }, undefined],
  ]
  for (const [options, repository] of cases) {
    const h = createHarness(options)
    await run(h.dependencies)
    assert.deepEqual(h.calls.repositories, [repository], JSON.stringify(options))
  }
})

test('the github block is built from a pull_request payload, and not for other events or a missing, zero or non-decimal id', () => {
  const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'draftt-io/infra' }
  const payload = { pull_request: { number: 7 }, repository: { id: 10, owner: { id: 20 } } }
  const base = { env, headSha: HEAD_SHA, scanKey: 'modules/eks' }
  assert.deepEqual(buildGitHubContext({ ...base, payload, sourceMap: { 'a.b': { path: 'a.tf', startLine: 1 } } }), {
    repositoryId: 10, repositoryOwnerId: 20, pullRequestNumber: 7, headSha: HEAD_SHA, scanKey: 'modules/eks', runId: 42, runAttempt: 2,
    workflowRunUrl: 'https://github.com/draftt-io/infra/actions/runs/42',
    sourceMap: { 'a.b': { path: 'a.tf', startLine: 1 } },
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
