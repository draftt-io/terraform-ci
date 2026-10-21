import type { ScanResponse } from './contracts.ts'
import { scanKeyFromTerraformRoot, type ActionInputs, type InputReader } from './inputs.ts'
import { safeErrorMessage } from './objects.ts'
import type { SanitizedPlan } from './plan.ts'
import { headShaOf, isExternalFork, type GitHubScanContext, type SourceMapEntry } from './request.ts'
import type { SourceLocator } from './source-locator.ts'
import { MAX_SOURCE_MAP_ENTRIES } from './source-map.ts'
import type { WorkspaceSourceStatus } from './workspace.ts'

interface Outputs {
  status: 'completed' | 'skipped' | 'error'
  violations: number
  warnings: number
  annotations: number
  checkRunUrl: string
}

const SUMMARY_HEADING = '## Draftt Terraform Policy Scan'
const FORK_SKIPPED = 'Draftt skipped this scan because repository secrets are unavailable to pull requests from external forks.'

export interface ActionRuntime extends InputReader {
  setSecret(value: string): void
  setOutput(name: string, value: string | number): void
  setFailed(message: string): void
  warning(message: string): void
  info(message: string): void
  writeSummary(markdown: string): Promise<void>
}

export interface ActionDependencies {
  runtime: ActionRuntime
  readInputs(runtime: InputReader): ActionInputs
  readAndSanitizePlan(planPath: string, workspaceRoot: string): Promise<SanitizedPlan>
  serializeScanRequest(plan: SanitizedPlan, policyIds: string[] | undefined, github?: GitHubScanContext): { body: string; sourceMapDropped: boolean }
  inspectWorkspaceForSourceMapping(workspaceRoot: string, expectedSha: string): Promise<WorkspaceSourceStatus>
  createSourceLocator(workspaceRoot: string, terraformRoot: string): Promise<SourceLocator>
  buildSourceMap(plan: SanitizedPlan, locator: SourceLocator): Promise<{ sourceMap: Record<string, SourceMapEntry>; capped: boolean }>
  buildGitHubContext(input: { payload: Record<string, unknown>; env: NodeJS.ProcessEnv; headSha: string; scanKey: string }): GitHubScanContext | undefined
  eventPayload(): Record<string, unknown>
  env(): NodeJS.ProcessEnv
  scanTerraformPlan(apiUrl: string, apiKey: string, body: string): Promise<ScanResponse>
  workspaceRoot(): string
}

// Uploads the scrubbed plan to Draftt CI and reports its answer in the outputs, the job log and the job summary.
// On a pull request the Draftt CI App publishes the check and the PR comment; this Action never writes to GitHub.
export async function run(dependencies: ActionDependencies): Promise<void> {
  const { runtime } = dependencies
  setOutputs(runtime, { status: 'error', violations: 0, warnings: 0, annotations: 0, checkRunUrl: '' })
  const payload = dependencies.eventPayload()
  if (isExternalFork(payload)) {
    await writeWorkflowSummary(runtime, `${SUMMARY_HEADING}\n\n${FORK_SKIPPED}`)
    setOutputs(runtime, { status: 'skipped', violations: 0, warnings: 0, annotations: 0, checkRunUrl: '' })
    return
  }

  const apiKey = runtime.getInput('api-key')
  if (apiKey) runtime.setSecret(apiKey)
  let failOnScanError = runtime.getInput('fail-on-scan-error') === 'true'
  try {
    const inputs = dependencies.readInputs(runtime)
    failOnScanError = inputs.failOnScanError
    const env = dependencies.env()
    const headSha = headShaOf({ payload, env })
    const workspaceRoot = dependencies.workspaceRoot()
    // An absolute terraform-root (e.g. ${{ github.workspace }}) is keyed relative to the same
    // workspace root the plan and source locator use (GITHUB_WORKSPACE, via workspaceRoot()).
    const scanKey = scanKeyFromTerraformRoot(inputs.terraformRoot, workspaceRoot)
    runtime.info(`Draftt scan: endpoint ${new URL(inputs.apiUrl).host}, scan key ${scanKey}`)
    const plan = await dependencies.readAndSanitizePlan(inputs.planJson, workspaceRoot)

    const github = dependencies.buildGitHubContext({ payload, env, headSha, scanKey })
    if (github) {
      const sourceMap = await sourceMapFor(dependencies, { plan, workspaceRoot, headSha, terraformRoot: inputs.terraformRoot })
      if (sourceMap) github.sourceMap = sourceMap
    } else {
      runtime.info('Not a pull request event: Draftt CI scans the plan and publishes no check or PR comment.')
    }
    if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
      runtime.info('On pull_request_target the planned code runs with access to the Draftt key; prefer pull_request.')
    }
    const { body, sourceMapDropped } = dependencies.serializeScanRequest(plan, inputs.policyIds, github)
    if (sourceMapDropped) runtime.warning('The source map was dropped to keep the upload under 50 MiB; findings will remain in the Check summary.')

    const response = await dependencies.scanTerraformPlan(inputs.apiUrl, inputs.apiKey, body)
    if (response.publishError) {
      const outcome = response.checkRunUrl ? 'published the check but could not finish' : 'could not publish the check'
      runtime.warning(`Draftt CI ${outcome} (${response.publishError.code}): ${response.publishError.message}`)
    } else if (github && !response.checkRunUrl) {
      runtime.warning('No check was published: Draftt CI reported neither a published check nor a publish error.')
    }
    const outputs: Outputs = {
      status: 'completed',
      violations: response.components.length,
      warnings: warningCount(response, inputs.policyIds),
      annotations: response.annotationCount ?? 0,
      checkRunUrl: response.checkRunUrl ?? '',
    }
    await writeWorkflowSummary(runtime, completedSummary(outputs))
    setOutputs(runtime, outputs)
    const check = outputs.checkRunUrl ? `check published by Draftt CI: ${outputs.checkRunUrl}` : 'no check was published'
    runtime.info(`Draftt scan completed (violations ${outputs.violations}, warnings ${outputs.warnings}, annotations ${outputs.annotations}); ${check}`)
  } catch (error) {
    const message = safeErrorMessage(error)
    await writeWorkflowSummary(runtime, `${SUMMARY_HEADING}\n\nScan error: ${message}`)
    if (failOnScanError) runtime.setFailed(message)
    else runtime.warning(message)
  }
}

// Address to file and line for the App's annotations; undefined, with a warning, when the checkout cannot be mapped.
async function sourceMapFor(
  dependencies: ActionDependencies,
  input: { plan: SanitizedPlan; workspaceRoot: string; headSha: string; terraformRoot: string },
): Promise<Record<string, SourceMapEntry> | undefined> {
  const { runtime } = dependencies
  const workspaceStatus = await dependencies.inspectWorkspaceForSourceMapping(input.workspaceRoot, input.headSha)
  if (workspaceStatus !== 'matched') {
    runtime.warning(sourceMappingWarning(workspaceStatus))
    return undefined
  }
  let locator: SourceLocator
  try {
    locator = await dependencies.createSourceLocator(input.workspaceRoot, input.terraformRoot)
  } catch {
    runtime.warning('Terraform source mapping is unavailable; findings will remain in the Check summary.')
    return undefined
  }
  const { sourceMap, capped } = await dependencies.buildSourceMap(input.plan, locator)
  if (capped) runtime.warning(`The source map was capped at ${MAX_SOURCE_MAP_ENTRIES} resources; findings for the rest will remain in the Check summary.`)
  return sourceMap
}

// Policies Draftt could not evaluate, per-resource evaluation gaps and unmapped resources, plus one for an empty
// policy-ids list, under which no policy is evaluated.
function warningCount(response: ScanResponse, policyIds: string[] | undefined): number {
  const gapCount = response.evaluation.componentsWithGaps.reduce((count, component) => count + component.policyGaps.length, 0)
  const noPoliciesSelected = policyIds?.length === 0 ? 1 : 0
  return response.evaluation.unevaluatedPolicies.length + gapCount + response.coverage.unmappedResources.length + noPoliciesSelected
}

function completedSummary(outputs: Outputs): string {
  return [
    SUMMARY_HEADING,
    '',
    `- Resources with policy violations: ${outputs.violations}`,
    `- Incomplete evaluation or coverage warnings: ${outputs.warnings}`,
    `- Annotations on the pull request: ${outputs.annotations}`,
    `- Check run: ${outputs.checkRunUrl || 'none published'}`,
  ].join('\n')
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
}
