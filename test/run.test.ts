import assert from 'node:assert/strict'
import test from 'node:test'
import type { ScanResponse } from '../src/contracts.ts'
import type { CheckAnnotation, CheckConclusion } from '../src/github-check.ts'
import type { ActionInputs } from '../src/inputs.ts'
import { completedConclusion, scanErrorConclusion } from '../src/outcome.ts'
import type { SanitizedPlan } from '../src/plan.ts'
import type { ScanReport } from '../src/report.ts'
import { run, type ActionDependencies, type ActionRuntime, type CheckPublisherLike } from '../src/run.ts'
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
  readonly conclusions: CheckConclusion[] = []
  failFinish = false

  async start(): Promise<void> {
    this.starts += 1
  }

  async publishAnnotations(annotations: CheckAnnotation[]): Promise<void> {
    this.annotationCount += annotations.length
  }

  async finish(conclusion: CheckConclusion): Promise<void> {
    if (this.failFinish) throw new Error('GitHub finish failed')
    this.conclusions.push(conclusion)
  }
}

interface HarnessOptions {
  externalFork?: boolean
  failOnViolations?: boolean
  failOnScanError?: boolean
  report?: ScanReport
  planError?: Error
  workspaceStatus?: 'matched' | 'head_mismatch' | 'dirty_terraform' | 'git_unavailable'
}

function createHarness(options: HarnessOptions = {}): {
  dependencies: ActionDependencies
  runtime: FakeRuntime
  publisher: FakePublisher
  calls: { readInputs: number; readPlan: number; scan: number }
} {
  const failOnViolations = options.failOnViolations ?? false
  const failOnScanError = options.failOnScanError ?? false
  const runtime = new FakeRuntime({
    'api-key': 'draftt-key',
    'github-token': 'github-token',
    'fail-on-scan-error': String(failOnScanError),
  })
  const publisher = new FakePublisher()
  const calls = { readInputs: 0, readPlan: 0, scan: 0 }
  const inputs: ActionInputs = {
    planJson: 'plan.json',
    apiUrl: 'https://api.draftt.io/api/v1/ci/scanTerraformPlan',
    apiKey: 'draftt-key',
    githubToken: 'github-token',
    terraformRoot: '.',
    failOnViolations,
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
    calls,
    dependencies: {
      runtime,
      isExternalFork: () => options.externalFork ?? false,
      getHeadSha: () => '1111111111111111111111111111111111111111',
      createPublisher: () => publisher,
      readInputs: () => {
        calls.readInputs += 1
        return inputs
      },
      readAndSanitizePlan: async () => {
        calls.readPlan += 1
        if (options.planError) throw options.planError
        return plan
      },
      serializeScanRequest: () => '{"plan":{}}',
      inspectWorkspaceForSourceMapping: async () => options.workspaceStatus ?? 'matched',
      createSourceLocator: async () => ({
        locate: async () => ({ kind: 'unresolved', reason: 'missing_declaration' }),
      }),
      scanTerraformPlan: async () => {
        calls.scan += 1
        return response
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
