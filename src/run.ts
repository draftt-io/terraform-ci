import { existsSync, readFileSync } from 'node:fs'
import { scanTerraformPlan } from './api.ts'
import type { ScanResponse } from './contracts.ts'
import { readInputs, scanKeyFromTerraformRoot, type InputReader } from './inputs.ts'
import { isRecord } from './objects.ts'
import { readAndSanitizePlan, serializeScanRequest, type SanitizedPlan } from './plan.ts'
import { buildScanSource, headShaOf, isExternalFork, type SourceMapEntry } from './request.ts'
import { TerraformSourceLocator } from './source-locator.ts'
import { inspectWorkspaceForSourceMapping, type WorkspaceSourceStatus } from './workspace.ts'

interface Outputs {
  status: 'completed' | 'skipped' | 'error'
  violations: number
  warnings: number
  annotations: number
  checkRunUrl: string
}

export interface ActionContext {
  inputs: InputReader
  /** The webhook payload file of the triggering event; absent outside a workflow run. */
  eventPath?: string
  env: NodeJS.ProcessEnv
  workspaceRoot: string
  /** The GitHub server; a check run URL on another host is not reported. */
  serverUrl: string
}

interface ActionResult {
  outputs: Outputs
  summary: string
  /** Problems that did not stop the scan, plus the scan error when fail-on-scan-error is off. */
  warnings: string[]
  /** The scan error the step fails with; set only with fail-on-scan-error. */
  failure?: string
}

const SUMMARY_HEADING = '## Draftt Terraform Policy Scan'
const FORK_SKIPPED = 'Draftt skipped this scan because repository secrets are unavailable to pull requests from external forks.'
const MAX_SOURCE_MAP_ENTRIES = 100_000
const MAPPED_ACTIONS = new Set(['create', 'update', 'no-op'])

// Uploads the scrubbed plan to Draftt CI and returns its answer as the outputs, the job summary and the warnings.
// On a pull request the Draftt CI App publishes the check and the PR comment; this Action never writes to GitHub.
export async function run(context: ActionContext): Promise<ActionResult> {
  const warnings: string[] = []
  let failOnScanError = context.inputs.getInput('fail-on-scan-error') === 'true'
  try {
    const payload = readEventPayload(context.eventPath)
    if (isExternalFork(payload)) {
      return { outputs: emptyOutputs('skipped'), summary: `${SUMMARY_HEADING}\n\n${FORK_SKIPPED}`, warnings }
    }
    const inputs = readInputs(context.inputs)
    failOnScanError = inputs.failOnScanError
    const headSha = headShaOf({ payload, env: context.env })
    const serverHost = new URL(context.serverUrl).host
    // An absolute terraform-root (e.g. ${{ github.workspace }}) is keyed relative to the same
    // workspace root the plan and source locator use.
    const scanKey = scanKeyFromTerraformRoot(inputs.terraformRoot, context.workspaceRoot)
    console.info(`Draftt scan: endpoint ${new URL(inputs.apiUrl).host}, scan key ${scanKey}`)
    const plan = await readAndSanitizePlan(inputs.planJson, context.workspaceRoot)

    const source = buildScanSource({ payload, env: context.env, headSha, scanKey })
    let sourceMap: Record<string, SourceMapEntry> | undefined
    if (source) {
      const mapped = await buildSourceMap({ plan, workspaceRoot: context.workspaceRoot, headSha, terraformRoot: inputs.terraformRoot })
      sourceMap = mapped.sourceMap
      if (mapped.warning !== undefined) warnings.push(mapped.warning)
    } else {
      console.info('Not a pull request event: Draftt CI scans the plan and publishes no check or PR comment.')
    }
    const { body, sourceMapDropped } = serializeScanRequest({
      plan,
      ...(inputs.policyIds === undefined ? {} : { policyIds: inputs.policyIds }),
      ...(source ? { source } : {}),
      ...(sourceMap ? { sourceMap } : {}),
    })
    if (sourceMapDropped) warnings.push('The source map was dropped to keep the upload under 50 MiB; findings will remain in the Check summary.')

    const response = await scanTerraformPlan(inputs.apiUrl, inputs.apiKey, body)
    const checkRunUrl = trustedCheckRunUrl(response.checkRunUrl, serverHost)
    if (response.publishError) {
      const outcome = checkRunUrl ? 'published the check but could not finish' : 'could not publish the check'
      warnings.push(`Draftt CI ${outcome} (${response.publishError.code}): ${response.publishError.message}`)
    } else if (source && !checkRunUrl) {
      warnings.push('No check was published: Draftt CI reported neither a published check nor a publish error.')
    }
    const outputs: Outputs = {
      status: 'completed',
      violations: response.components.length,
      warnings: warningCount(response, inputs.policyIds),
      annotations: response.annotationCount ?? 0,
      checkRunUrl,
    }
    const check = checkRunUrl ? `check published by Draftt CI: ${checkRunUrl}` : 'no check was published'
    console.info(`Draftt scan completed (violations ${outputs.violations}, warnings ${outputs.warnings}, annotations ${outputs.annotations}); ${check}`)
    return { outputs, summary: completedSummary(outputs), warnings }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Terraform policy scan failed'
    const summary = `${SUMMARY_HEADING}\n\nScan error: ${message}`
    if (failOnScanError) return { outputs: emptyOutputs('error'), summary, warnings, failure: message }
    return { outputs: emptyOutputs('error'), summary, warnings: [...warnings, message] }
  }
}

// The webhook payload the runner writes to GITHUB_EVENT_PATH; {} without one.
function readEventPayload(eventPath?: string): Record<string, unknown> {
  if (eventPath === undefined || !existsSync(eventPath)) return {}
  const payload: unknown = JSON.parse(readFileSync(eventPath, 'utf8'))
  return isRecord(payload) ? payload : {}
}

// Address to file and line for every resource the server might flag, for the App's annotations. The server resolves a
// flagged component by its plan address against these exact keys. Capped at the server's own limit.
async function buildSourceMap(input: {
  plan: SanitizedPlan
  workspaceRoot: string
  headSha: string
  terraformRoot: string
}): Promise<{ sourceMap?: Record<string, SourceMapEntry>; warning?: string }> {
  const workspaceStatus = await inspectWorkspaceForSourceMapping(input.workspaceRoot, input.headSha)
  if (workspaceStatus !== 'matched') return { warning: sourceMappingWarning(workspaceStatus) }
  let locator: TerraformSourceLocator
  try {
    locator = await TerraformSourceLocator.create({ workspaceRoot: input.workspaceRoot, terraformRoot: input.terraformRoot })
  } catch (error) {
    // The map is optional: without it the scan still runs and the findings stay in the check summary.
    const reason = error instanceof Error ? error.message : 'unknown error'
    return { warning: `Terraform source mapping is unavailable (${reason}); findings will remain in the Check summary.` }
  }
  const sourceMap: Record<string, SourceMapEntry> = {}
  let entries = 0
  for (const resource of input.plan.resource_changes) {
    if (resource.mode !== 'managed' || typeof resource.address !== 'string' || Object.hasOwn(sourceMap, resource.address)) continue
    const change = resource.change
    const actions = isRecord(change) && Array.isArray(change.actions) ? change.actions.filter((action): action is string => typeof action === 'string') : []
    if (!actions.some((action) => MAPPED_ACTIONS.has(action))) continue
    const mapping = await locator.locate({ address: resource.address })
    if (mapping.kind !== 'found') continue
    if (entries >= MAX_SOURCE_MAP_ENTRIES) {
      return { sourceMap, warning: `The source map was capped at ${MAX_SOURCE_MAP_ENTRIES} resources; findings for the rest will remain in the Check summary.` }
    }
    sourceMap[resource.address] = { path: mapping.location.path, startLine: mapping.location.startLine }
    entries += 1
  }
  return { sourceMap }
}

// The URL lands in the job summary and the check-run-url output, so only a GitHub check link is kept.
function trustedCheckRunUrl(value: string | undefined, serverHost: string): string {
  if (value === undefined) return ''
  const url = URL.parse(value)
  return url?.protocol === 'https:' && (url.host === 'github.com' || url.host === serverHost) ? value : ''
}

// Policies Draftt could not evaluate, per-resource evaluation gaps and unmapped resources, plus one for an empty
// policy-ids list, under which no policy is evaluated.
function warningCount(response: ScanResponse, policyIds: string[] | undefined): number {
  const gapCount = response.evaluation.componentsWithGaps.reduce((count, component) => count + component.policyGaps.length, 0)
  const noPoliciesSelected = policyIds?.length === 0 ? 1 : 0
  return response.evaluation.unevaluatedPolicies.length + gapCount + response.coverage.unmappedResources.length + noPoliciesSelected
}

function emptyOutputs(status: 'skipped' | 'error'): Outputs {
  return { status, violations: 0, warnings: 0, annotations: 0, checkRunUrl: '' }
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
