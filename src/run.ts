import type { ScanResponse } from './contracts.ts'
import type { CheckAnnotation, CheckConclusion } from './github-check.ts'
import type { ActionInputs, InputReader } from './inputs.ts'
import type { SanitizedPlan } from './plan.ts'
import type { ScanReport, SourceLocator } from './report.ts'
import type { WorkspaceSourceStatus } from './workspace.ts'

type ScanStatus = 'completed' | 'skipped' | 'error'

export interface ActionRuntime extends InputReader {
  setSecret(value: string): void
  setOutput(name: string, value: string | number): void
  setFailed(message: string): void
  warning(message: string): void
  info(message: string): void
  writeSummary(markdown: string): Promise<void>
}

export interface CheckPublisherLike {
  readonly annotationCount: number
  start(): Promise<void>
  publishAnnotations(annotations: CheckAnnotation[]): Promise<void>
  finish(conclusion: CheckConclusion, title: string, summary: string): Promise<void>
}

export interface ActionDependencies {
  runtime: ActionRuntime
  isExternalFork(): boolean
  getHeadSha(): string
  createPublisher(token: string, headSha?: string): CheckPublisherLike
  readInputs(runtime: InputReader): ActionInputs
  readAndSanitizePlan(planPath: string, workspaceRoot: string): Promise<SanitizedPlan>
  serializeScanRequest(plan: SanitizedPlan, policyIds: string[] | undefined): string
  inspectWorkspaceForSourceMapping(workspaceRoot: string, expectedSha: string): Promise<WorkspaceSourceStatus>
  createSourceLocator(workspaceRoot: string, terraformRoot: string): Promise<SourceLocator>
  scanTerraformPlan(apiUrl: string, apiKey: string, body: string): Promise<ScanResponse>
  buildScanReport(
    response: ScanResponse,
    locator: SourceLocator | undefined,
    annotationLevel: 'warning' | 'failure',
    noPoliciesSelected: boolean,
  ): Promise<ScanReport>
  completedConclusion(violationCount: number, failOnViolations: boolean): CheckConclusion
  scanErrorConclusion(failOnScanError: boolean): CheckConclusion
  workspaceRoot(): string
}

export async function run(dependencies: ActionDependencies): Promise<void> {
  const { runtime } = dependencies
  setOutputs(runtime, 'error', 0, 0, 0)

  if (dependencies.isExternalFork()) {
    await skipExternalFork(dependencies)
    return
  }

  const apiKey = runtime.getInput('api-key')
  if (apiKey) runtime.setSecret(apiKey)
  let failOnScanError = runtime.getInput('fail-on-scan-error') === 'true'
  let publisher: CheckPublisherLike | undefined
  let violationCount = 0
  let warningCount = 0

  try {
    const githubToken = runtime.getInput('github-token', { required: true })
    runtime.setSecret(githubToken)
    const headSha = dependencies.getHeadSha()
    publisher = dependencies.createPublisher(githubToken, headSha)
    await publisher.start()

    const inputs = dependencies.readInputs(runtime)
    failOnScanError = inputs.failOnScanError

    const workspaceRoot = dependencies.workspaceRoot()
    const plan = await dependencies.readAndSanitizePlan(inputs.planJson, workspaceRoot)
    const body = dependencies.serializeScanRequest(plan, inputs.policyIds)

    let locator: SourceLocator | undefined
    const workspaceStatus = await dependencies.inspectWorkspaceForSourceMapping(workspaceRoot, headSha)
    if (workspaceStatus === 'matched') {
      try {
        locator = await dependencies.createSourceLocator(workspaceRoot, inputs.terraformRoot)
      } catch {
        runtime.warning('Terraform source mapping is unavailable; findings will remain in the Check summary.')
      }
    } else {
      runtime.warning(sourceMappingWarning(workspaceStatus))
    }

    const response = await dependencies.scanTerraformPlan(inputs.apiUrl, inputs.apiKey, body)
    const report = await dependencies.buildScanReport(
      response,
      locator,
      inputs.failOnViolations ? 'failure' : 'warning',
      inputs.policyIds?.length === 0,
    )
    violationCount = report.violationCount
    warningCount = report.warningCount

    await publisher.publishAnnotations(report.annotations)
    const shouldFail = report.violationCount > 0 && inputs.failOnViolations
    const conclusion = dependencies.completedConclusion(report.violationCount, inputs.failOnViolations)
    await publisher.finish(conclusion, report.title, report.summary)
    await writeWorkflowSummary(runtime, report.summary)
    setOutputs(runtime, 'completed', report.violationCount, report.warningCount, publisher.annotationCount)

    if (shouldFail) runtime.setFailed(`Draftt found policy violations in ${report.violationCount} Terraform resources.`)
  } catch (error) {
    const message = safeErrorMessage(error)
    const annotationCount = publisher?.annotationCount ?? 0
    setOutputs(runtime, 'error', violationCount, warningCount, annotationCount)
    if (publisher) {
      try {
        await publisher.finish(
          dependencies.scanErrorConclusion(failOnScanError),
          'Terraform policy scan could not complete',
          `Draftt could not produce a reliable policy result.\n\n${message}`,
        )
      } catch {
        runtime.warning('The Draftt GitHub Check could not be finalized.')
      }
    }
    await writeWorkflowSummary(runtime, `## Draftt Terraform Policy Scan\n\nScan error: ${message}`)
    if (failOnScanError) runtime.setFailed(message)
    else runtime.warning(message)
  }
}

function sourceMappingWarning(status: Exclude<WorkspaceSourceStatus, 'matched'>): string {
  switch (status) {
    case 'head_mismatch':
      return 'The pull request head commit is not checked out. Configure actions/checkout with ref: ${{ github.event.pull_request.head.sha }}; findings will remain in the Check summary.'
    case 'dirty_terraform':
      return 'Terraform source files differ from the checked-out commit; findings will remain in the Check summary.'
    case 'git_unavailable':
      return 'Git repository state could not be inspected; findings will remain in the Check summary.'
  }
}

async function skipExternalFork(dependencies: ActionDependencies): Promise<void> {
  const { runtime } = dependencies
  const summary = 'Draftt skipped this scan because repository secrets are unavailable to pull requests from external forks.'
  const githubToken = runtime.getInput('github-token')
  if (githubToken) {
    try {
      const publisher = dependencies.createPublisher(githubToken)
      await publisher.start()
      await publisher.finish('skipped', 'Terraform policy scan skipped', summary)
    } catch {
      runtime.info('A skipped Check Run could not be published for this fork pull request.')
    }
  }
  await writeWorkflowSummary(runtime, `## Draftt Terraform Policy Scan\n\n${summary}`)
  setOutputs(runtime, 'skipped', 0, 0, 0)
}

async function writeWorkflowSummary(runtime: ActionRuntime, markdown: string): Promise<void> {
  try {
    await runtime.writeSummary(markdown)
  } catch {
    runtime.info('The workflow summary could not be written.')
  }
}

function setOutputs(
  runtime: ActionRuntime,
  status: ScanStatus,
  violations: number,
  warnings: number,
  annotations: number,
): void {
  runtime.setOutput('scan-status', status)
  runtime.setOutput('violation-count', violations)
  runtime.setOutput('warning-count', warnings)
  runtime.setOutput('annotation-count', annotations)
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Terraform policy scan failed'
}
