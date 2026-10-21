import { isScansEndpoint } from './api.ts'
import type { ScanResponse } from './contracts.ts'
import { CHECK_NAME, FALLBACK_CHECK_NAME, type AnnotatedCheckCompletion, type CheckAnnotation, type CheckCompletion, type CheckConclusion, type CheckPublisherInput } from './github-check.ts'
import { parsePublishMode, scanKeyFromTerraformRoot, type ActionInputs, type InputReader } from './inputs.ts'
import { safeErrorMessage } from './objects.ts'
import type { SanitizedPlan } from './plan.ts'
import type { BuildScanReportInput, ReportRepository, ScanReport, SourceLocator } from './report.ts'
import { repositoryFromPayload, type GitHubScanContext, type SourceMapEntry } from './request.ts'
import { MAX_SOURCE_MAP_ENTRIES } from './source-map.ts'
import type { WorkspaceSourceStatus } from './workspace.ts'

type ScanStatus = 'completed' | 'skipped' | 'error'
type Publisher = 'server' | 'action' | 'none'

interface Outputs {
  status: ScanStatus
  violations: number
  warnings: number
  annotations: number
  checkRunUrl: string
  publisher: Publisher
}

const ERROR_TITLE = 'Terraform policy scan could not complete'
const DEPRECATION = 'fail-on-violations is ignored: Draftt CI checks never fail; violations are reported in the check and PR comment.'

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
  readonly checkRunUrl: string | undefined
  start(): Promise<void>
  publishAnnotations(annotations: CheckAnnotation[]): Promise<void>
  finish(input: CheckCompletion): Promise<void>
  publishCompleted(input: AnnotatedCheckCompletion): Promise<void>
}

export interface ActionDependencies {
  runtime: ActionRuntime
  isExternalFork(): boolean
  getHeadSha(): string
  createPublisher(input: CheckPublisherInput): CheckPublisherLike
  readInputs(runtime: InputReader): ActionInputs
  readAndSanitizePlan(planPath: string, workspaceRoot: string): Promise<SanitizedPlan>
  serializeScanRequest(plan: SanitizedPlan, policyIds: string[] | undefined, github?: GitHubScanContext): { body: string; sourceMapDropped: boolean }
  inspectWorkspaceForSourceMapping(workspaceRoot: string, expectedSha: string): Promise<WorkspaceSourceStatus>
  createSourceLocator(workspaceRoot: string, terraformRoot: string): Promise<SourceLocator>
  buildSourceMap(plan: SanitizedPlan, locator: SourceLocator): Promise<{ sourceMap: Record<string, SourceMapEntry>; capped: boolean }>
  buildGitHubContext(input: { payload: Record<string, unknown>; env: NodeJS.ProcessEnv; headSha: string; scanKey: string; sourceMap?: Record<string, SourceMapEntry> }): GitHubScanContext | undefined
  eventPayload(): Record<string, unknown>
  env(): NodeJS.ProcessEnv
  scanTerraformPlan(apiUrl: string, apiKey: string, body: string): Promise<ScanResponse>
  buildScanReport(input: BuildScanReportInput): Promise<ScanReport>
  violationConclusion(violationCount: number): CheckConclusion
  scanErrorConclusion(failOnScanError: boolean): CheckConclusion
  workspaceRoot(): string
}

export async function run(dependencies: ActionDependencies): Promise<void> {
  setOutputs(dependencies.runtime, { status: 'error', violations: 0, warnings: 0, annotations: 0, checkRunUrl: '', publisher: 'none' })

  if (dependencies.isExternalFork()) {
    await skipExternalFork(dependencies)
    return
  }
  if (usesServerFlow(dependencies)) await runServerFlow(dependencies)
  else await runActionFlow(dependencies)
}

// Server publishing needs a /ci/scans api-url and a PR event. Everything else (action mode, the
// default /ci/scanTerraformPlan api-url, push, merge_group, workflow_dispatch) is the v0.1.1 flow under the v0.1.1
// check name, so branch protection pinned to that check keeps working after an upgrade. Decided
// from the raw inputs, before readInputs, so the v0.1.1 flow still starts its check first.
function usesServerFlow(dependencies: ActionDependencies): boolean {
  const { runtime } = dependencies
  if (isActionMode(runtime.getInput('publish-mode'))) return false
  if (!isScansEndpoint(runtime.getInput('api-url'))) return false
  let headSha: string
  try {
    headSha = dependencies.getHeadSha()
  } catch {
    return false
  }
  const probe = dependencies.buildGitHubContext({ payload: dependencies.eventPayload(), env: dependencies.env(), headSha, scanKey: '.' })
  return probe !== undefined
}

// An invalid publish-mode is not action mode: readInputs reports it inside the flow, like any other invalid input.
function isActionMode(value: string): boolean {
  try {
    return parsePublishMode(value) === 'action'
  } catch {
    return false
  }
}

// v0.1.1, apart from the check-run-url and publisher outputs and fail-on-violations, which no
// longer fails the check or the job.
async function runActionFlow(dependencies: ActionDependencies): Promise<void> {
  const { runtime } = dependencies
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
    publisher = dependencies.createPublisher({ token: githubToken, headSha, name: CHECK_NAME })
    await publisher.start()

    const inputs = dependencies.readInputs(runtime)
    failOnScanError = inputs.failOnScanError
    warnDeprecatedInput(runtime, inputs.failOnViolations)
    runtime.info(`Draftt scan: publish-mode action, endpoint ${endpointHost(inputs.apiUrl)}`)

    const workspaceRoot = dependencies.workspaceRoot()
    const plan = await dependencies.readAndSanitizePlan(inputs.planJson, workspaceRoot)
    const { body } = dependencies.serializeScanRequest(plan, inputs.policyIds)
    const locator = await sourceLocatorFor(dependencies, workspaceRoot, headSha, inputs.terraformRoot)

    const response = await dependencies.scanTerraformPlan(inputs.apiUrl, inputs.apiKey, body)
    const report = await dependencies.buildScanReport(reportInput({
      response,
      locator,
      policyIds: inputs.policyIds,
      repository: repositoryFromPayload({ payload: dependencies.eventPayload(), env: dependencies.env(), headSha }),
    }))
    violationCount = report.violationCount
    warningCount = report.warningCount

    await publisher.publishAnnotations(report.annotations)
    await publisher.finish({ conclusion: dependencies.violationConclusion(report.violationCount), title: report.title, summary: report.summary })
    await writeWorkflowSummary(runtime, report.summary)
    const outputs: Outputs = {
      status: 'completed',
      violations: report.violationCount,
      warnings: report.warningCount,
      annotations: publisher.annotationCount,
      checkRunUrl: publisher.checkRunUrl ?? '',
      publisher: 'action',
    }
    setOutputs(runtime, outputs)
    logCompletion(runtime, outputs)
  } catch (error) {
    const message = safeErrorMessage(error)
    let concluded = false
    if (publisher) {
      try {
        await publisher.finish({ conclusion: dependencies.scanErrorConclusion(failOnScanError), title: ERROR_TITLE, summary: errorSummary(message) })
        concluded = true
        runtime.info(`Posted the error check: ${publisher.checkRunUrl ?? ''}`)
      } catch (finishError) {
        runtime.warning(`The Draftt GitHub Check could not be finalized: ${safeErrorMessage(finishError)}`)
      }
    }
    setOutputs(runtime, {
      status: 'error',
      violations: violationCount,
      warnings: warningCount,
      annotations: publisher?.annotationCount ?? 0,
      checkRunUrl: concluded ? (publisher?.checkRunUrl ?? '') : '',
      publisher: concluded ? 'action' : 'none',
    })
    await writeWorkflowSummary(runtime, `## Draftt Terraform Policy Scan\n\nScan error: ${message}`)
    if (failOnScanError) runtime.setFailed(message)
    else runtime.warning(message)
  }
}

// publish-mode server on a PR event against /ci/scans: the Draftt CI App publishes. This Action
// creates no check before or during the request, and posts one completed (Action) check only when
// the server did not publish, or when the request itself failed.
async function runServerFlow(dependencies: ActionDependencies): Promise<void> {
  const { runtime } = dependencies
  const apiKey = runtime.getInput('api-key')
  if (apiKey) runtime.setSecret(apiKey)
  const githubToken = runtime.getInput('github-token') || undefined
  if (githubToken) runtime.setSecret(githubToken)
  let failOnScanError = runtime.getInput('fail-on-scan-error') === 'true'
  const headSha = dependencies.getHeadSha()
  let violationCount = 0
  let warningCount = 0

  try {
    const inputs = dependencies.readInputs(runtime)
    failOnScanError = inputs.failOnScanError
    warnDeprecatedInput(runtime, inputs.failOnViolations)

    const workspaceRoot = dependencies.workspaceRoot()
    // An absolute terraform-root (e.g. ${{ github.workspace }}) is keyed relative to the same
    // workspace root the plan and source locator use (GITHUB_WORKSPACE, via workspaceRoot()).
    const scanKey = scanKeyFromTerraformRoot(inputs.terraformRoot, workspaceRoot)
    runtime.info(`Draftt scan: publish-mode server, endpoint ${endpointHost(inputs.apiUrl)}, scan key ${scanKey}`)
    const plan = await dependencies.readAndSanitizePlan(inputs.planJson, workspaceRoot)
    const locator = await sourceLocatorFor(dependencies, workspaceRoot, headSha, inputs.terraformRoot)

    let sourceMap: Record<string, SourceMapEntry> | undefined
    if (locator) {
      const built = await dependencies.buildSourceMap(plan, locator)
      sourceMap = built.sourceMap
      if (built.capped) runtime.warning(`The source map was capped at ${MAX_SOURCE_MAP_ENTRIES} resources; findings for the rest will remain in the Check summary.`)
    }
    const env = dependencies.env()
    const payload = dependencies.eventPayload()
    const github = dependencies.buildGitHubContext({
      payload,
      env,
      headSha,
      scanKey,
      ...(sourceMap ? { sourceMap } : {}),
    })
    if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
      runtime.info('publish-mode: server on pull_request_target exposes the Draftt key to the planned code; prefer pull_request.')
    }
    const { body, sourceMapDropped } = dependencies.serializeScanRequest(plan, inputs.policyIds, github)
    if (sourceMapDropped) runtime.warning('The source map was dropped to keep the upload under 50 MiB; findings will remain in the Check summary.')

    const response = await dependencies.scanTerraformPlan(inputs.apiUrl, inputs.apiKey, body)
    const report = await dependencies.buildScanReport(reportInput({
      response,
      locator,
      policyIds: inputs.policyIds,
      repository: repositoryFromPayload({ payload, env, headSha }),
    }))
    violationCount = report.violationCount
    warningCount = report.warningCount

    let outputs: Outputs = { status: 'completed', violations: report.violationCount, warnings: report.warningCount, annotations: 0, checkRunUrl: '', publisher: 'none' }
    if (response.checkRunUrl) {
      if (response.publishError) runtime.warning(`Draftt CI published the check but could not finish (${response.publishError.code}): ${response.publishError.message}`)
      outputs = { ...outputs, annotations: response.annotationCount ?? 0, checkRunUrl: response.checkRunUrl, publisher: 'server' }
    } else {
      if (response.publishError) runtime.warning(`Draftt CI could not publish the check (${response.publishError.code}): ${response.publishError.message}`)
      if (inputs.githubToken) {
        try {
          const fallback = dependencies.createPublisher({ token: inputs.githubToken, headSha, name: FALLBACK_CHECK_NAME })
          await fallback.publishCompleted({
            conclusion: dependencies.violationConclusion(report.violationCount),
            title: report.title,
            summary: report.summary,
            annotations: report.annotations,
          })
          outputs = { ...outputs, annotations: fallback.annotationCount, checkRunUrl: fallback.checkRunUrl ?? '', publisher: 'action' }
          runtime.info(`Posted the fallback check: ${outputs.checkRunUrl}`)
        } catch (publishError) {
          runtime.warning(`The Draftt fallback check could not be published: ${safeErrorMessage(publishError)}`)
        }
      } else if (!response.publishError) {
        runtime.warning('No check was published: Draftt CI reported neither a published check nor a publish error, and no github-token is available for a fallback check.')
      }
    }

    await writeWorkflowSummary(runtime, report.summary)
    setOutputs(runtime, outputs)
    logCompletion(runtime, outputs)
  } catch (error) {
    const message = safeErrorMessage(error)
    let outputs: Outputs = { status: 'error', violations: violationCount, warnings: warningCount, annotations: 0, checkRunUrl: '', publisher: 'none' }
    if (githubToken) {
      try {
        const fallback = dependencies.createPublisher({ token: githubToken, headSha, name: FALLBACK_CHECK_NAME })
        await fallback.publishCompleted({ conclusion: dependencies.scanErrorConclusion(failOnScanError), title: ERROR_TITLE, summary: errorSummary(message), annotations: [] })
        outputs = { ...outputs, checkRunUrl: fallback.checkRunUrl ?? '', publisher: 'action' }
        runtime.info(`Posted the error check: ${outputs.checkRunUrl}`)
      } catch (publishError) {
        runtime.warning(`The Draftt error check could not be published: ${safeErrorMessage(publishError)}`)
      }
    }
    setOutputs(runtime, outputs)
    await writeWorkflowSummary(runtime, `## Draftt Terraform Policy Scan\n\nScan error: ${message}`)
    if (failOnScanError) runtime.setFailed(message)
    else runtime.warning(message)
  }
}

// Every flow annotates at 'warning'; without a repository the renderer prints path:line unlinked.
function reportInput(input: {
  response: ScanResponse
  locator: SourceLocator | undefined
  policyIds: string[] | undefined
  repository: ReportRepository | undefined
}): BuildScanReportInput {
  const { response, locator, policyIds, repository } = input
  return {
    response,
    annotationLevel: 'warning',
    noPoliciesSelected: policyIds?.length === 0,
    ...(locator ? { locator } : {}),
    ...(repository ? { repository } : {}),
  }
}

async function sourceLocatorFor(
  dependencies: ActionDependencies,
  workspaceRoot: string,
  headSha: string,
  terraformRoot: string,
): Promise<SourceLocator | undefined> {
  const workspaceStatus = await dependencies.inspectWorkspaceForSourceMapping(workspaceRoot, headSha)
  if (workspaceStatus !== 'matched') {
    dependencies.runtime.warning(sourceMappingWarning(workspaceStatus))
    return undefined
  }
  try {
    return await dependencies.createSourceLocator(workspaceRoot, terraformRoot)
  } catch {
    dependencies.runtime.warning('Terraform source mapping is unavailable; findings will remain in the Check summary.')
    return undefined
  }
}

// Only the host: a path or query string could carry a tenant value or a credential.
function endpointHost(apiUrl: string): string {
  try {
    return new URL(apiUrl).host
  } catch {
    return '(invalid api-url)'
  }
}

function logCompletion(runtime: ActionRuntime, outputs: Outputs): void {
  const counts = `violations ${outputs.violations}, warnings ${outputs.warnings}, annotations ${outputs.annotations}`
  const check = outputs.publisher === 'none' ? 'no check was published' : `check published by ${outputs.publisher}: ${outputs.checkRunUrl}`
  runtime.info(`Draftt scan completed (${counts}); ${check}`)
}

// fail-on-violations is a no-op in every flow. Printed once per run, and only when the input is true:
// false or unset changes nothing, so it says nothing.
function warnDeprecatedInput(runtime: ActionRuntime, failOnViolations: boolean): void {
  if (failOnViolations) runtime.warning(DEPRECATION)
}

function errorSummary(message: string): string {
  return `Draftt could not produce a reliable policy result.\n\n${message}`
}

function sourceMappingWarning(status: Exclude<WorkspaceSourceStatus, 'matched'>): string {
  switch (status) {
    case 'head_mismatch':
      return 'The pull request head commit is not checked out. Configure actions/checkout with ref: ${{ github.event.pull_request.head.sha }}; findings will remain in the Check summary.'
    case 'nested_workspace':
      return 'GITHUB_WORKSPACE is not the repository root; findings will remain in the Check summary.'
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
      const publisher = dependencies.createPublisher({ token: githubToken })
      await publisher.start()
      await publisher.finish({ conclusion: 'skipped', title: 'Terraform policy scan skipped', summary })
    } catch {
      runtime.info('A skipped Check Run could not be published for this fork pull request.')
    }
  }
  await writeWorkflowSummary(runtime, `## Draftt Terraform Policy Scan\n\n${summary}`)
  setOutputs(runtime, { status: 'skipped', violations: 0, warnings: 0, annotations: 0, checkRunUrl: '', publisher: 'none' })
}

async function writeWorkflowSummary(runtime: ActionRuntime, markdown: string): Promise<void> {
  try {
    await runtime.writeSummary(markdown)
  } catch {
    runtime.info('The workflow summary could not be written.')
  }
}

function setOutputs(runtime: ActionRuntime, outputs: Outputs): void {
  runtime.setOutput('scan-status', outputs.status)
  runtime.setOutput('violation-count', outputs.violations)
  runtime.setOutput('warning-count', outputs.warnings)
  runtime.setOutput('annotation-count', outputs.annotations)
  runtime.setOutput('check-run-url', outputs.checkRunUrl)
  runtime.setOutput('publisher', outputs.publisher)
}
