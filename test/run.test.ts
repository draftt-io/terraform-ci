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
import type { ReportOptions, ScanReport } from '../src/report.ts'
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
  failOnViolationsRaw?: '' | 'true' | 'false'
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
  sourceMapCapped?: boolean
  sourceMapDropped?: boolean
}

function createHarness(options: HarnessOptions = {}): {
  dependencies: ActionDependencies
  runtime: FakeRuntime
  publisher: FakePublisher
  events: string[]
  calls: { readInputs: number; readPlan: number; scan: number; githubContext: number; sourceMap: number; serializedGithub: Array<GitHubScanContext | undefined>; levels: Array<'warning' | 'failure'>; reportOptions: Array<ReportOptions | undefined> }
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
  const calls = { readInputs: 0, readPlan: 0, scan: 0, githubContext: 0, sourceMap: 0, serializedGithub: [] as Array<GitHubScanContext | undefined>, levels: [] as Array<'warning' | 'failure'>, reportOptions: [] as Array<ReportOptions | undefined> }
  const inputs: ActionInputs = {
    planJson: 'plan.json',
    apiUrl,
    apiKey: 'draftt-key',
    ...(options.githubToken === null ? {} : { githubToken: options.githubToken ?? 'github-token' }),
    terraformRoot: options.terraformRoot ?? '.',
    failOnViolations,
    failOnViolationsRaw: options.failOnViolationsRaw ?? (options.failOnViolations === undefined ? '' : options.failOnViolations ? 'true' : 'false'),
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
      env: () => options.env ?? {},
      scanTerraformPlan: async () => {
        calls.scan += 1
        if (options.scanError) throw options.scanError
        return { ...response, ...options.response }
      },
      buildScanReport: async (_response, _locator, level, _noPoliciesSelected, reportOptions) => {
        calls.levels.push(level)
        calls.reportOptions.push(reportOptions)
        return report
      },
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
  // No explicit name: CheckPublisher's default, CHECK_NAME, as in v0.1.1.
  assert.deepEqual(harness.publisher.names, ['default'])
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

const NOTHING_PUBLISHED_WARNING = 'No check was published: Draftt CI reported neither a published check nor a publish error, and no github-token is available for a fallback check.'

test('server mode without a token and without checkRunUrl reports publisher none', async () => {
  const h = createHarness({ githubToken: null, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.publisher.names, [])
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'none', 'check-run-url': '', 'annotation-count': 0 })
  assert.deepEqual(h.runtime.warnings, [NOTHING_PUBLISHED_WARNING])
  assert.deepEqual(h.runtime.failures, [])
})

test('server mode without a token warns only about the publishError when the server reported one', async () => {
  const h = createHarness({ githubToken: null, response: { publishError: { code: 'not_bound', message: 'no binding' } }, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.runtime.warnings, ['Draftt CI could not publish the check (not_bound): no binding'])
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'none', 'check-run-url': '' })
})

test('server mode masks the Draftt key and the github token before any read, log or output', async () => {
  const h = createHarness({ response: { publishError: { code: 'not_bound', message: 'no binding' } }, sourceMapCapped: true, payload: PR })
  const order: string[] = []
  const runtime = h.runtime
  const record = <K extends 'setSecret' | 'setOutput' | 'warning' | 'info' | 'setFailed'>(name: K): void => {
    const original = runtime[name].bind(runtime) as (...args: unknown[]) => void
    ;(runtime as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      order.push(name === 'setSecret' ? `setSecret:${String(args[0])}` : name === 'setOutput' ? `setOutput:${String(args[0])}=${String(args[1])}` : name)
      original(...args)
    }
  }
  for (const name of ['setSecret', 'setOutput', 'warning', 'info', 'setFailed'] as const) record(name)
  const writeSummary = runtime.writeSummary.bind(runtime)
  runtime.writeSummary = async (markdown) => {
    order.push('writeSummary')
    await writeSummary(markdown)
  }
  const readInputs = h.dependencies.readInputs
  h.dependencies.readInputs = (r) => {
    order.push('readInputs')
    return readInputs(r)
  }
  const readPlan = h.dependencies.readAndSanitizePlan
  h.dependencies.readAndSanitizePlan = async (...args) => {
    order.push('readPlan')
    return readPlan(...args)
  }
  await run(h.dependencies)
  assert.deepEqual(runtime.secrets, ['draftt-key', 'github-token'])
  const firstSecret = order.indexOf('setSecret:draftt-key')
  // Only run()'s constant placeholder outputs precede masking; they carry no input-derived value.
  assert.deepEqual(order.slice(0, firstSecret), [
    'setOutput:scan-status=error',
    'setOutput:violation-count=0',
    'setOutput:warning-count=0',
    'setOutput:annotation-count=0',
    'setOutput:check-run-url=',
    'setOutput:publisher=none',
  ])
  assert.deepEqual(order.slice(firstSecret, firstSecret + 2), ['setSecret:draftt-key', 'setSecret:github-token'])
  assert.equal(order.filter((entry) => entry.startsWith('setSecret')).length, 2)
  // The run did read, log and output after masking, so the ordering above is meaningful.
  const after = order.slice(firstSecret + 2)
  for (const entry of ['readInputs', 'readPlan', 'warning', 'writeSummary', 'setOutput:publisher=action']) assert.ok(after.includes(entry), entry)
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

test('server mode ignores fail-on-violations for the verdict but still sends it in the github block', async () => {
  const h = createHarness({ failOnViolations: true, response: { checkRunUrl: 'https://github.com/o/r/runs/1' }, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.runtime.failures, [])
  assert.equal(h.calls.serializedGithub[0]?.failOnViolations, true)
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
function realScanClient(captured: unknown[], info: (message: string) => void = () => {}): ActionDependencies['scanTerraformPlan'] {
  return async (apiUrl, apiKey, body) => {
    try {
      return await scanTerraformPlan(apiUrl, apiKey, body, { sleep: async () => {}, info })
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

test('server mode sends failOnViolations false in the github block when enforcement is off', async () => {
  const h = createHarness({ response: { checkRunUrl: 'https://github.com/o/r/runs/1' }, payload: PR })
  await run(h.dependencies)
  assert.equal(h.calls.serializedGithub[0]?.failOnViolations, false)
  assert.deepEqual(h.runtime.failures, [])
})

test('the fallback check concludes failure for violations in blocking mode and the job fails', async () => {
  const h = createHarness({ response: { mode: 'blocking', publishError: { code: 'github_unavailable', message: 'm' } }, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.publisher.names, [FALLBACK_CHECK_NAME])
  assert.deepEqual(h.publisher.completed, [{ conclusion: 'failure', title: 'One violation', annotations: 1 }])
  assert.deepEqual(h.runtime.failures, ['Draftt CI is in blocking mode and found policy violations in 1 Terraform resource. See the check: https://github.com/o/r/runs/9'])
  assertOutputFields(h.runtime, { 'scan-status': 'completed', publisher: 'action' })
  assert.deepEqual(h.runtime.summaries, ['Summary'])
})

test('an error check that cannot be posted is a warning and stays fail-open', async () => {
  const h = createHarness({ scanError: new Error('Draftt could not complete the scan'), payload: PR })
  h.publisher.failCompleted = true
  await run(h.dependencies)
  assert.ok(h.runtime.warnings.includes('The Draftt error check could not be published.'))
  assert.ok(h.runtime.warnings.includes('Draftt could not complete the scan'))
  assertOutputFields(h.runtime, { 'scan-status': 'error', publisher: 'none', 'check-run-url': '' })
  assert.deepEqual(h.runtime.failures, [])
  assert.deepEqual(h.runtime.summaries, ['## Draftt Terraform Policy Scan\n\nScan error: Draftt could not complete the scan'])
})

test('server mode on pull_request_target notes that the Draftt key is exposed to the planned code', async () => {
  const target = createHarness({ response: { checkRunUrl: 'https://github.com/o/r/runs/1' }, payload: PR })
  target.dependencies.env = () => ({ GITHUB_EVENT_NAME: 'pull_request_target' })
  await run(target.dependencies)
  assert.ok(target.runtime.infos.some((line) => line.includes('pull_request_target')))
  assert.deepEqual(target.runtime.summaries, ['Summary'])

  const pullRequest = createHarness({ response: { checkRunUrl: 'https://github.com/o/r/runs/1' }, payload: PR })
  pullRequest.dependencies.env = () => ({ GITHUB_EVENT_NAME: 'pull_request' })
  await run(pullRequest.dependencies)
  assert.equal(pullRequest.runtime.infos.some((line) => line.includes('pull_request_target')), false)
})

test('server mode logs the start and the completion', async () => {
  const h = createHarness({ response: { checkRunUrl: 'https://github.com/o/r/runs/1', annotationCount: 4 }, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.runtime.infos, [
    'Draftt scan: publish-mode server, endpoint draftt-ci.draftt.io, scan key .',
    NO_MODE_LINE,
    'Draftt scan completed (violations 1, warnings 2, annotations 4); check published by server: https://github.com/o/r/runs/1',
  ])

  const none = createHarness({ githubToken: null, payload: PR })
  await run(none.dependencies)
  assert.equal(none.runtime.infos.at(-1), 'Draftt scan completed (violations 1, warnings 2, annotations 0); no check was published')
})

test('logs the fallback check and the error check it posts', async () => {
  const fallback = createHarness({ response: { publishError: { code: 'not_bound', message: 'no binding' } }, payload: PR })
  await run(fallback.dependencies)
  assert.deepEqual(fallback.runtime.infos.slice(1), [
    'Posted the fallback check: https://github.com/o/r/runs/9',
    'Draftt scan completed (violations 1, warnings 2, annotations 1); check published by action: https://github.com/o/r/runs/9',
  ])

  const error = createHarness({ scanError: new Error('Draftt could not complete the scan'), payload: PR })
  await run(error.dependencies)
  assert.deepEqual(error.runtime.infos.slice(1), ['Posted the error check: https://github.com/o/r/runs/9'])

  const unposted = createHarness({ scanError: new Error('Draftt could not complete the scan'), payload: PR })
  unposted.publisher.failCompleted = true
  await run(unposted.dependencies)
  assert.equal(unposted.runtime.infos.some((line) => line.startsWith('Posted')), false)
})

test('action mode logs the start, the completion and a concluded error check', async () => {
  const h = createHarness({ publishMode: 'action', payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.runtime.infos, [
    'Draftt scan: publish-mode action, endpoint draftt-ci.draftt.io',
    'Draftt scan completed (violations 1, warnings 2, annotations 1); check published by action: https://github.com/o/r/runs/8',
  ])

  const error = createHarness({ publishMode: 'action', payload: PR, planError: new Error('Invalid plan') })
  await run(error.dependencies)
  assert.deepEqual(error.runtime.infos.slice(1), ['Posted the error check: https://github.com/o/r/runs/8'])
})

test('no logged line carries the Draftt key, the token, a plan value, the api-url query or a backend body', async (t) => {
  const scenarios: Array<{ options: HarnessOptions; status: number }> = [
    { options: { response: { checkRunUrl: 'https://github.com/o/r/runs/1' }, payload: PR }, status: 200 },
    { options: { payload: PR }, status: 200 },
    { options: { payload: PR }, status: 502 },
    { options: { publishMode: 'action', payload: PR }, status: 429 },
  ]
  for (const scenario of scenarios) {
    const h = createHarness({ ...scenario.options, apiUrl: 'https://draftt-ci.draftt.io/v1/scans?tenant=planted-query' })
    const plan: SanitizedPlan = { format_version: '1.2', resource_changes: [{ address: 'aws_s3_bucket.b', change: { after: { bucket: 'planted-plan-value' } } }] }
    h.dependencies.readAndSanitizePlan = async () => plan
    h.dependencies.serializeScanRequest = () => ({ body: JSON.stringify({ plan }), sourceMapDropped: false })
    const serverResponse = { ...scanResponse(), ...scenario.options.response }
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => (
      scenario.status === 200
        ? jsonResponse(200, serverResponse)
        : jsonResponse(scenario.status, { message: 'planted-backend-body' }, { 'retry-after': '0' })
    ))
    h.dependencies.scanTerraformPlan = realScanClient([], (line) => h.runtime.info(line))
    await run(h.dependencies)
    fetchMock.mock.restore()
    const lines = [...h.runtime.infos, ...h.runtime.warnings]
    assert.ok(h.runtime.infos.length >= 2, 'the run logged progress')
    for (const planted of ['draftt-key', 'github-token', 'planted-plan-value', 'planted-query', 'planted-backend-body']) {
      assert.equal(lines.some((line) => line.includes(planted)), false, `${planted} in ${JSON.stringify(lines)}`)
    }
  }
})

// ---- Verdict from the Draftt CI mode (M3b/c)

const NO_MODE_LINE = 'Draftt CI did not report a mode; update the Draftt CI service.'
const ADVISORY_DEPRECATION = 'fail-on-violations is ignored: Draftt CI is in advisory mode for this repository, so this check does not fail. A Draftt Admin can switch to blocking mode in the Draftt console.'
const GENERIC_DEPRECATION = 'fail-on-violations is ignored when Draftt CI publishes the check; a Draftt Admin sets the mode in the Draftt console (Integrations › Draftt CI).'
const PUBLISH_FAILURE = 'Draftt CI could not publish its check, so the required Draftt check will pass when it times out.'
const PUBLISH_FAILURE_WITH_FALLBACK = `${PUBLISH_FAILURE} The "Draftt Terraform Policy Scan (Action)" check shows the result.`
const RUN_URL = 'https://github.com/o/r/runs/1'
const MODE_SUFFIX = (mode: string): string => `; mode ${mode} (set in the Draftt console: Integrations › Draftt CI)`

function twoViolationReport(): ScanReport {
  return { title: 'Two violations', summary: 'Summary', annotations: [], violationCount: 2, warningCount: 0 }
}

test('server mode takes the annotation level from the mode, never from fail-on-violations', async () => {
  const cases: Array<[Partial<ScanResponse>, boolean, 'warning' | 'failure']> = [
    [{ mode: 'blocking' }, false, 'failure'],
    [{ mode: 'advisory' }, true, 'warning'],
    [{}, true, 'warning'],
    [{ mode: 'blocking', checkRunUrl: RUN_URL }, false, 'failure'],
  ]
  for (const [response, failOnViolations, level] of cases) {
    const h = createHarness({ response, failOnViolations, payload: PR })
    await run(h.dependencies)
    assert.deepEqual(h.calls.levels, [level], JSON.stringify(response))
  }
})

test('server mode prints the fail-on-violations deprecation once, worded by the input and the mode', async () => {
  const cases: Array<[ActionInputs['failOnViolationsRaw'], Partial<ScanResponse>, string | undefined]> = [
    ['true', { mode: 'advisory', checkRunUrl: RUN_URL, conclusion: 'neutral' }, ADVISORY_DEPRECATION],
    ['true', { mode: 'blocking', checkRunUrl: RUN_URL, conclusion: 'failure' }, GENERIC_DEPRECATION],
    ['true', { checkRunUrl: RUN_URL }, GENERIC_DEPRECATION],
    ['false', { mode: 'advisory', checkRunUrl: RUN_URL, conclusion: 'neutral' }, GENERIC_DEPRECATION],
    ['false', { mode: 'blocking', checkRunUrl: RUN_URL, conclusion: 'failure' }, GENERIC_DEPRECATION],
    ['', { mode: 'advisory', checkRunUrl: RUN_URL, conclusion: 'neutral' }, undefined],
    ['', { mode: 'blocking', checkRunUrl: RUN_URL, conclusion: 'failure' }, undefined],
  ]
  for (const [raw, response, expected] of cases) {
    const h = createHarness({ failOnViolationsRaw: raw, failOnViolations: raw === 'true', response, payload: PR })
    await run(h.dependencies)
    const deprecations = h.runtime.warnings.filter((w) => w.startsWith('fail-on-violations is ignored'))
    assert.deepEqual(deprecations, expected ? [expected] : [], `${raw} ${JSON.stringify(response)}`)
  }
})

test('server mode prints the generic deprecation when the scan errors before an answer', async () => {
  const h = createHarness({ failOnViolationsRaw: 'true', failOnViolations: true, scanError: new Error('Draftt could not complete the scan'), payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.runtime.warnings.filter((w) => w.startsWith('fail-on-violations')), [GENERIC_DEPRECATION])
})

test('the v0.1.1 flow prints no deprecation and keeps honouring fail-on-violations', async () => {
  const action = createHarness({ publishMode: 'action', failOnViolations: true, response: { mode: 'advisory', conclusion: 'neutral' }, payload: PR })
  await run(action.dependencies)
  assert.equal(action.runtime.warnings.some((w) => w.startsWith('fail-on-violations')), false)
  assert.deepEqual(action.publisher.conclusions, ['failure'])
  assert.deepEqual(action.calls.levels, ['failure'])
  assert.deepEqual(action.runtime.failures, ['Draftt found policy violations in 1 Terraform resources.'])

  const quiet = createHarness({ publishMode: 'action', response: { mode: 'blocking', conclusion: 'failure' }, payload: PR })
  await run(quiet.dependencies)
  assert.deepEqual(quiet.publisher.conclusions, ['neutral'])
  assert.deepEqual(quiet.calls.levels, ['warning'])
  assert.deepEqual(quiet.runtime.failures, [])
  assert.equal(quiet.runtime.infos.some((line) => line.includes('mode blocking') || line === NO_MODE_LINE), false)

  const push = createHarness({ failOnViolations: true, response: { mode: 'advisory' } })
  await run(push.dependencies)
  assert.equal(push.runtime.warnings.some((w) => w.startsWith('fail-on-violations')), false)
  assert.deepEqual(push.runtime.failures, ['Draftt found policy violations in 1 Terraform resources.'])
})

test('server mode fails the job when the server conclusion is failure, in either mode', async () => {
  const blocking = createHarness({ response: { mode: 'blocking', conclusion: 'failure', checkRunUrl: RUN_URL }, payload: PR })
  await run(blocking.dependencies)
  assert.deepEqual(blocking.runtime.failures, [`Draftt CI is in blocking mode and found policy violations in 1 Terraform resource. See the check: ${RUN_URL}`])

  // Review Focus 5: the server is the authority.
  const advisory = createHarness({ response: { mode: 'advisory', conclusion: 'failure', checkRunUrl: RUN_URL }, payload: PR, report: twoViolationReport() })
  await run(advisory.dependencies)
  assert.deepEqual(advisory.runtime.failures, [`Draftt CI is in blocking mode and found policy violations in 2 Terraform resources. See the check: ${RUN_URL}`])

  for (const conclusion of ['success', 'neutral'] as const) {
    const passing = createHarness({ failOnViolations: true, response: { mode: 'blocking', conclusion, checkRunUrl: RUN_URL }, payload: PR })
    await run(passing.dependencies)
    assert.deepEqual(passing.runtime.failures, [], conclusion)
  }
})

test('a checkRunUrl without conclusion (an older service) does not fail the job', async () => {
  const h = createHarness({ failOnViolations: true, response: { mode: 'blocking', checkRunUrl: RUN_URL }, payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.runtime.failures, [])
})

test('without a published check the fallback rule decides: blocking and violations fail, advisory and no mode never do', async () => {
  const blocking = createHarness({ response: { mode: 'blocking' }, payload: PR, report: twoViolationReport() })
  await run(blocking.dependencies)
  assert.deepEqual(blocking.publisher.completed.map((c) => c.conclusion), ['failure'])
  assert.deepEqual(blocking.runtime.failures, ['Draftt CI is in blocking mode and found policy violations in 2 Terraform resources. See the check: https://github.com/o/r/runs/9'])

  const noToken = createHarness({ githubToken: null, response: { mode: 'blocking' }, payload: PR })
  await run(noToken.dependencies)
  assert.deepEqual(noToken.runtime.failures, ['Draftt CI is in blocking mode and found policy violations in 1 Terraform resource.'])

  const advisory = createHarness({ failOnViolations: true, response: { mode: 'advisory', publishError: { code: 'github_unavailable', message: 'm' } }, payload: PR })
  await run(advisory.dependencies)
  assert.deepEqual(advisory.publisher.completed.map((c) => c.conclusion), ['neutral'])
  assert.deepEqual(advisory.runtime.failures, [])

  const noMode = createHarness({ failOnViolations: true, payload: PR })
  await run(noMode.dependencies)
  assert.deepEqual(noMode.publisher.completed.map((c) => c.conclusion), ['neutral'])
  assert.deepEqual(noMode.runtime.failures, [])

  const clean = createHarness({ response: { mode: 'blocking' }, payload: PR, report: { title: 'No policy violations found', summary: 'S', annotations: [], violationCount: 0, warningCount: 0 } })
  await run(clean.dependencies)
  assert.deepEqual(clean.publisher.completed.map((c) => c.conclusion), ['success'])
  assert.deepEqual(clean.runtime.failures, [])
})

test('blocking without a published check warns for the root scan key only, naming the fallback check when it was posted', async () => {
  const withToken = createHarness({ response: { mode: 'blocking', publishError: { code: 'github_unavailable', message: 'm' } }, payload: PR })
  await run(withToken.dependencies)
  assert.deepEqual(withToken.runtime.warnings.filter((w) => w.startsWith(PUBLISH_FAILURE)), [PUBLISH_FAILURE_WITH_FALLBACK])

  const withoutToken = createHarness({ githubToken: null, response: { mode: 'blocking', publishError: { code: 'github_unavailable', message: 'm' } }, payload: PR })
  await run(withoutToken.dependencies)
  assert.deepEqual(withoutToken.runtime.warnings.filter((w) => w.startsWith(PUBLISH_FAILURE)), [PUBLISH_FAILURE])

  const unposted = createHarness({ response: { mode: 'blocking' }, payload: PR })
  unposted.publisher.failCompleted = true
  await run(unposted.dependencies)
  assert.deepEqual(unposted.runtime.warnings.filter((w) => w.startsWith(PUBLISH_FAILURE)), [PUBLISH_FAILURE])

  const nonRoot = createHarness({ terraformRoot: 'modules/eks', response: { mode: 'blocking' }, payload: PR })
  await run(nonRoot.dependencies)
  assert.equal(nonRoot.calls.serializedGithub[0]?.scanKey, 'modules/eks')
  assert.equal(nonRoot.runtime.warnings.some((w) => w.startsWith(PUBLISH_FAILURE)), false)

  for (const response of [{ mode: 'advisory' as const }, { mode: 'blocking' as const, checkRunUrl: RUN_URL, conclusion: 'failure' as const }, {}]) {
    const h = createHarness({ response, payload: PR })
    await run(h.dependencies)
    assert.equal(h.runtime.warnings.some((w) => w.startsWith(PUBLISH_FAILURE)), false, JSON.stringify(response))
  }
})

test('a response without mode logs the no-mode line, except for not_bound', async () => {
  const published = createHarness({ response: { checkRunUrl: RUN_URL }, payload: PR })
  await run(published.dependencies)
  assert.equal(published.runtime.infos.filter((line) => line === NO_MODE_LINE).length, 1)

  const neither = createHarness({ payload: PR })
  await run(neither.dependencies)
  assert.equal(neither.runtime.infos.filter((line) => line === NO_MODE_LINE).length, 1)

  const notBound = createHarness({ response: { publishError: { code: 'not_bound', message: 'no binding' } }, payload: PR })
  await run(notBound.dependencies)
  assert.equal(notBound.runtime.infos.includes(NO_MODE_LINE), false)

  const withMode = createHarness({ response: { mode: 'advisory', checkRunUrl: RUN_URL, conclusion: 'neutral' }, payload: PR })
  await run(withMode.dependencies)
  assert.equal(withMode.runtime.infos.includes(NO_MODE_LINE), false)
})

test('the completion line carries the mode when the response did', async () => {
  for (const mode of ['advisory', 'blocking'] as const) {
    const h = createHarness({ response: { mode, checkRunUrl: RUN_URL, annotationCount: 4, conclusion: 'neutral' }, payload: PR })
    await run(h.dependencies)
    assert.equal(h.runtime.infos.at(-1), `Draftt scan completed (violations 1, warnings 2, annotations 4); check published by server: ${RUN_URL}${MODE_SUFFIX(mode)}`)
  }
  const fallback = createHarness({ response: { mode: 'advisory' }, payload: PR })
  await run(fallback.dependencies)
  assert.equal(fallback.runtime.infos.at(-1), `Draftt scan completed (violations 1, warnings 2, annotations 1); check published by action: https://github.com/o/r/runs/9${MODE_SUFFIX('advisory')}`)
  const old = createHarness({ response: { checkRunUrl: RUN_URL }, payload: PR })
  await run(old.dependencies)
  assert.equal(old.runtime.infos.at(-1)?.includes('; mode '), false)
})

test('a 408 upload_timeout and a 422 too_many_scan_keys reach the run as scan errors with their messages, not retried', async (t) => {
  const cases = [
    { status: 408, body: { code: 'upload_timeout', message: 'The upload did not finish within 240 s; send the body gzip-compressed' }, message: 'The upload did not finish within 240 s; send the body gzip-compressed' },
    { status: 422, body: { code: 'too_many_scan_keys', message: 'This commit already has 50 Draftt scan keys' }, message: 'This commit already has 50 Draftt CI scans, the most Draftt CI accepts per commit (one per terraform-root).' },
  ]
  for (const item of cases) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(item.status, item.body))
    const h = createHarness({ payload: PR })
    h.dependencies.scanTerraformPlan = realScanClient([])
    await run(h.dependencies)
    fetchMock.mock.restore()
    assert.equal(fetchMock.mock.callCount(), 1)
    assert.ok(h.runtime.warnings.includes(item.message), JSON.stringify(h.runtime.warnings))
    assert.deepEqual(h.publisher.completed.map((c) => [c.conclusion, c.title]), [['neutral', 'Terraform policy scan could not complete']])
    assertOutputFields(h.runtime, { 'scan-status': 'error', publisher: 'action' })
  }
})

const HEAD_SHA = '1111111111111111111111111111111111111111'
const REPOSITORY = { owner: { login: 'draftt-io' }, name: 'infra' }

test('action mode links path:line to the head commit of the payload repository', async () => {
  const h = createHarness({ publishMode: 'action', payload: { ...PR, repository: REPOSITORY } })
  await run(h.dependencies)
  assert.deepEqual(h.calls.reportOptions, [{ repository: { owner: 'draftt-io', repo: 'infra', headSha: HEAD_SHA } }])
})

test('a push event in action mode still links files, from GITHUB_REPOSITORY', async () => {
  const h = createHarness({ payload: { ref: 'refs/heads/main' }, env: { GITHUB_REPOSITORY: 'draftt-io/infra' } })
  await run(h.dependencies)
  assert.deepEqual(h.publisher.names, [CHECK_NAME])
  assert.deepEqual(h.calls.reportOptions, [{ repository: { owner: 'draftt-io', repo: 'infra', headSha: HEAD_SHA } }])
})

test('the server flow report, and so the fallback check, links files too', async () => {
  const h = createHarness({ payload: { ...PR, repository: REPOSITORY } })
  await run(h.dependencies)
  assert.deepEqual(h.publisher.names, [FALLBACK_CHECK_NAME])
  assert.equal(h.publisher.completed.length, 1)
  assert.deepEqual(h.calls.reportOptions, [{ repository: { owner: 'draftt-io', repo: 'infra', headSha: HEAD_SHA } }])
})

test('without a repository the report gets no file links', async () => {
  const h = createHarness({ publishMode: 'action', payload: PR })
  await run(h.dependencies)
  assert.deepEqual(h.calls.reportOptions, [{}])
})
