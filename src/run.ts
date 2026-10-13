import { isScansEndpoint } from './api.ts'
import type { ScanMode, ScanResponse } from './contracts.ts'
import { CHECK_NAME, FALLBACK_CHECK_NAME, type CheckAnnotation, type CheckConclusion } from './github-check.ts'
import { scanKeyFromTerraformRoot, type ActionInputs, type InputReader } from './inputs.ts'
import { fallbackConclusion, serverJobConclusion } from './outcome.ts'
import type { SanitizedPlan } from './plan.ts'
import type { ScanReport, SourceLocator } from './report.ts'
import type { GitHubScanContext, SourceMapEntry } from './request.ts'
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
const ROOT_SCAN_KEY = '.'
const NO_MODE = 'Draftt CI did not report a mode; update the Draftt CI service.'
const ADVISORY_DEPRECATION = 'fail-on-violations is ignored: Draftt CI is in advisory mode for this repository, so this check does not fail. A Draftt Admin can switch to blocking mode in the Draftt console.'
const DEPRECATION = 'fail-on-violations is ignored when Draftt CI publishes the check; a Draftt Admin sets the mode in the Draftt console (Integrations › Draftt CI).'
const PUBLISH_FAILURE = 'Draftt CI could not publish its check, so the required Draftt check will pass when it times out.'
const PUBLISH_FAILURE_FALLBACK = ` The "${FALLBACK_CHECK_NAME}" check shows the result.`

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
  finish(conclusion: CheckConclusion, title: string, summary: string): Promise<void>
  publishCompleted(conclusion: CheckConclusion, title: string, summary: string, annotations: CheckAnnotation[]): Promise<void>
}

export interface ActionDependencies {
  runtime: ActionRuntime
  isExternalFork(): boolean
  getHeadSha(): string
  createPublisher(token: string, headSha?: string, name?: string): CheckPublisherLike
  readInputs(runtime: InputReader): ActionInputs
  readAndSanitizePlan(planPath: string, workspaceRoot: string): Promise<SanitizedPlan>
  serializeScanRequest(plan: SanitizedPlan, policyIds: string[] | undefined, github?: GitHubScanContext): { body: string; sourceMapDropped: boolean }
  inspectWorkspaceForSourceMapping(workspaceRoot: string, expectedSha: string): Promise<WorkspaceSourceStatus>
  createSourceLocator(workspaceRoot: string, terraformRoot: string): Promise<SourceLocator>
  buildSourceMap(plan: SanitizedPlan, locator: SourceLocator): Promise<{ sourceMap: Record<string, SourceMapEntry>; capped: boolean }>
  buildGitHubContext(input: { payload: Record<string, unknown>; env: NodeJS.ProcessEnv; headSha: string; failOnViolations: boolean; scanKey: string; sourceMap?: Record<string, SourceMapEntry> }): GitHubScanContext | undefined
  eventPayload(): Record<string, unknown>
  env(): NodeJS.ProcessEnv
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
  setOutputs(dependencies.runtime, { status: 'error', violations: 0, warnings: 0, annotations: 0, checkRunUrl: '', publisher: 'none' })

  if (dependencies.isExternalFork()) {
    await skipExternalFork(dependencies)
    return
  }
  if (usesServerFlow(dependencies)) await runServerFlow(dependencies)
  else await runActionFlow(dependencies)
}

// Server publishing needs the draftt-ci route and a PR event. Everything else (action mode, the
// ui-backend api-url, push, merge_group, workflow_dispatch) is the v0.1.1 flow under the v0.1.1
// check name, so branch protection pinned to that check keeps working after an upgrade. Decided
// from the raw inputs, before readInputs, so the v0.1.1 flow still starts its check first.
function usesServerFlow(dependencies: ActionDependencies): boolean {
  const { runtime } = dependencies
  if (runtime.getInput('publish-mode') === 'action') return false
  if (!isScansEndpoint(runtime.getInput('api-url'))) return false
  let headSha: string
  try {
    headSha = dependencies.getHeadSha()
  } catch {
    return false
  }
  const probe = dependencies.buildGitHubContext({ payload: dependencies.eventPayload(), env: dependencies.env(), headSha, failOnViolations: false, scanKey: '.' })
  return probe !== undefined
}

// v0.1.1, unchanged apart from the check-run-url and publisher outputs.
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
    publisher = dependencies.createPublisher(githubToken, headSha, CHECK_NAME)
    await publisher.start()

    const inputs = dependencies.readInputs(runtime)
    failOnScanError = inputs.failOnScanError
    runtime.info(`Draftt scan: publish-mode action, endpoint ${endpointHost(inputs.apiUrl)}`)

    const workspaceRoot = dependencies.workspaceRoot()
    const plan = await dependencies.readAndSanitizePlan(inputs.planJson, workspaceRoot)
    const { body } = dependencies.serializeScanRequest(plan, inputs.policyIds)
    const locator = await sourceLocatorFor(dependencies, workspaceRoot, headSha, inputs.terraformRoot)

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

    if (shouldFail) runtime.setFailed(`Draftt found policy violations in ${report.violationCount} Terraform resources.`)
  } catch (error) {
    const message = safeErrorMessage(error)
    let concluded = false
    if (publisher) {
      try {
        await publisher.finish(dependencies.scanErrorConclusion(failOnScanError), ERROR_TITLE, errorSummary(message))
        concluded = true
        runtime.info(`Posted the error check: ${publisher.checkRunUrl ?? ''}`)
      } catch {
        runtime.warning('The Draftt GitHub Check could not be finalized.')
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

// publish-mode server on a PR event against /v1/scans: the Draftt CI App publishes. This Action
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
  let failOnViolationsRaw: ActionInputs['failOnViolationsRaw'] = ''
  let deprecationWarned = false

  try {
    const inputs = dependencies.readInputs(runtime)
    failOnScanError = inputs.failOnScanError
    failOnViolationsRaw = inputs.failOnViolationsRaw

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
    const github = dependencies.buildGitHubContext({
      payload: dependencies.eventPayload(),
      env,
      headSha,
      failOnViolations: inputs.failOnViolations,
      scanKey,
      ...(sourceMap ? { sourceMap } : {}),
    })
    if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
      runtime.info('publish-mode: server on pull_request_target exposes the Draftt key to the planned code; prefer pull_request.')
    }
    const { body, sourceMapDropped } = dependencies.serializeScanRequest(plan, inputs.policyIds, github)
    if (sourceMapDropped) runtime.warning('The source map was dropped to keep the upload under 50 MiB; findings will remain in the Check summary.')

    const response = await dependencies.scanTerraformPlan(inputs.apiUrl, inputs.apiKey, body)
    // The Draftt CI mode decides; without one (an older service) the scan is advisory.
    const mode = response.mode
    if (!mode && response.publishError?.code !== 'not_bound') runtime.info(NO_MODE)
    deprecationWarned = warnDeprecatedInput(runtime, inputs.failOnViolationsRaw, mode)
    const report = await dependencies.buildScanReport(
      response,
      locator,
      mode === 'blocking' ? 'failure' : 'warning',
      inputs.policyIds?.length === 0,
    )
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
          const fallback = dependencies.createPublisher(inputs.githubToken, headSha, FALLBACK_CHECK_NAME)
          await fallback.publishCompleted(fallbackConclusion(mode, report.violationCount), report.title, report.summary, report.annotations)
          outputs = { ...outputs, annotations: fallback.annotationCount, checkRunUrl: fallback.checkRunUrl ?? '', publisher: 'action' }
          runtime.info(`Posted the fallback check: ${outputs.checkRunUrl}`)
        } catch {
          runtime.warning('The Draftt fallback check could not be published.')
        }
      } else if (!response.publishError) {
        runtime.warning('No check was published: Draftt CI reported neither a published check nor a publish error, and no github-token is available for a fallback check.')
      }
      // Only the root key has a queued check, the one a ruleset can require, that times out and passes.
      if (mode === 'blocking' && scanKey === ROOT_SCAN_KEY) {
        runtime.warning(`${PUBLISH_FAILURE}${outputs.publisher === 'action' ? PUBLISH_FAILURE_FALLBACK : ''}`)
      }
    }

    await writeWorkflowSummary(runtime, report.summary)
    setOutputs(runtime, outputs)
    logCompletion(runtime, outputs, mode)
    if (serverJobConclusion(response, report.violationCount) === 'failure') {
      const count = report.violationCount
      const where = outputs.checkRunUrl ? ` See the check: ${outputs.checkRunUrl}` : ''
      runtime.setFailed(`Draftt CI is in blocking mode and found policy violations in ${count} Terraform ${plural(count, 'resource')}.${where}`)
    }
  } catch (error) {
    const message = safeErrorMessage(error)
    if (!deprecationWarned) warnDeprecatedInput(runtime, failOnViolationsRaw, undefined)
    let outputs: Outputs = { status: 'error', violations: violationCount, warnings: warningCount, annotations: 0, checkRunUrl: '', publisher: 'none' }
    if (githubToken) {
      try {
        const fallback = dependencies.createPublisher(githubToken, headSha, FALLBACK_CHECK_NAME)
        await fallback.publishCompleted(dependencies.scanErrorConclusion(failOnScanError), ERROR_TITLE, errorSummary(message), [])
        outputs = { ...outputs, checkRunUrl: fallback.checkRunUrl ?? '', publisher: 'action' }
        runtime.info(`Posted the error check: ${outputs.checkRunUrl}`)
      } catch {
        runtime.warning('The Draftt error check could not be published.')
      }
    }
    setOutputs(runtime, outputs)
    await writeWorkflowSummary(runtime, `## Draftt Terraform Policy Scan\n\nScan error: ${message}`)
    if (failOnScanError) runtime.setFailed(message)
    else runtime.warning(message)
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

function logCompletion(runtime: ActionRuntime, outputs: Outputs, mode?: ScanMode): void {
  const counts = `violations ${outputs.violations}, warnings ${outputs.warnings}, annotations ${outputs.annotations}`
  const check = outputs.publisher === 'none' ? 'no check was published' : `check published by ${outputs.publisher}: ${outputs.checkRunUrl}`
  const modeNote = mode ? `; mode ${mode} (set in the Draftt console: Integrations › Draftt CI)` : ''
  runtime.info(`Draftt scan completed (${counts}); ${check}${modeNote}`)
}

// The server flow only: fail-on-violations is a no-op there. Nothing when the input is absent.
function warnDeprecatedInput(runtime: ActionRuntime, raw: ActionInputs['failOnViolationsRaw'], mode: ScanMode | undefined): boolean {
  if (raw === '') return false
  runtime.warning(raw === 'true' && mode === 'advisory' ? ADVISORY_DEPRECATION : DEPRECATION)
  return true
}

// Same rule as the shared renderer's plural() in report.ts, whose shared block is hash-pinned and not exported.
function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
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
      const publisher = dependencies.createPublisher(githubToken)
      await publisher.start()
      await publisher.finish('skipped', 'Terraform policy scan skipped', summary)
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

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Terraform policy scan failed'
}
