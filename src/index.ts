// GitHub's official toolkit handles Action inputs, masking, outputs, summaries, and failures.
import * as core from '@actions/core'
import { scanTerraformPlan } from './api.ts'
import { CheckPublisher, getHeadSha, isExternalFork } from './github-check.ts'
import { readInputs } from './inputs.ts'
import { readAndSanitizePlan, serializeScanRequest } from './plan.ts'
import { buildScanReport } from './report.ts'
import { TerraformSourceLocator } from './source-locator.ts'
import { completedConclusion, scanErrorConclusion } from './outcome.ts'
import { workspaceMatchesCommit } from './workspace.ts'

export async function run(): Promise<void> {
  setOutputs('error', 0, 0, 0)

  if (isExternalFork()) {
    await skipExternalFork()
    return
  }

  const apiKey = core.getInput('api-key')
  if (apiKey) core.setSecret(apiKey)
  let failOnScanError = core.getInput('fail-on-scan-error') === 'true'
  let publisher: CheckPublisher | undefined
  let violationCount = 0
  let warningCount = 0

  try {
    const githubToken = core.getInput('github-token', { required: true })
    core.setSecret(githubToken)
    const headSha = getHeadSha()
    publisher = new CheckPublisher(githubToken, headSha)
    await publisher.start()

    const inputs = readInputs(core)
    failOnScanError = inputs.failOnScanError

    const workspaceRoot = process.env.GITHUB_WORKSPACE ?? process.cwd()
    const plan = await readAndSanitizePlan(inputs.planJson, workspaceRoot)
    const body = serializeScanRequest(plan, inputs.policyIds)

    let locator: TerraformSourceLocator | undefined
    if (await workspaceMatchesCommit(workspaceRoot, headSha)) {
      try {
        locator = await TerraformSourceLocator.create({ workspaceRoot, terraformRoot: inputs.terraformRoot })
      } catch {
        core.warning('Terraform source mapping is unavailable; findings will remain in the Check summary.')
      }
    } else {
      core.warning('The checked-out commit does not match the Check revision; findings will remain in the Check summary.')
    }

    const response = await scanTerraformPlan(inputs.apiUrl, inputs.apiKey, body)
    const report = await buildScanReport(
      response,
      locator,
      inputs.failOnViolations ? 'failure' : 'warning',
      inputs.policyIds?.length === 0,
    )
    violationCount = report.violationCount
    warningCount = report.warningCount

    await publisher.publishAnnotations(report.annotations)
    const shouldFail = report.violationCount > 0 && inputs.failOnViolations
    const conclusion = completedConclusion(report.violationCount, inputs.failOnViolations)
    await publisher.finish(conclusion, report.title, report.summary)
    await writeWorkflowSummary(report.summary)
    setOutputs('completed', report.violationCount, report.warningCount, publisher.annotationCount)

    if (shouldFail) core.setFailed(`Draftt found policy violations in ${report.violationCount} Terraform resources.`)
  } catch (error) {
    const message = safeErrorMessage(error)
    const annotationCount = publisher?.annotationCount ?? 0
    setOutputs('error', violationCount, Math.max(warningCount, 1), annotationCount)
    if (publisher) {
      try {
        await publisher.finish(
          scanErrorConclusion(failOnScanError),
          'Terraform policy scan could not complete',
          `Draftt could not produce a reliable policy result.\n\n${message}`,
        )
      } catch {
        core.warning('The Draftt GitHub Check could not be finalized.')
      }
    }
    await writeWorkflowSummary(`## Draftt Terraform Policy Scan\n\nScan error: ${message}`)
    if (failOnScanError) core.setFailed(message)
    else core.warning(message)
  }
}

async function skipExternalFork(): Promise<void> {
  const summary = 'Draftt skipped this scan because repository secrets are unavailable to pull requests from external forks.'
  const githubToken = core.getInput('github-token')
  if (githubToken) {
    try {
      const publisher = new CheckPublisher(githubToken)
      await publisher.start()
      await publisher.finish('skipped', 'Terraform policy scan skipped', summary)
    } catch {
      core.info('A skipped Check Run could not be published for this fork pull request.')
    }
  }
  await writeWorkflowSummary(`## Draftt Terraform Policy Scan\n\n${summary}`)
  setOutputs('skipped', 0, 0, 0)
}

async function writeWorkflowSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown).write()
  } catch {
    core.info('The workflow summary could not be written.')
  }
}

function setOutputs(status: 'completed' | 'skipped' | 'error', violations: number, warnings: number, annotations: number): void {
  core.setOutput('scan-status', status)
  core.setOutput('violation-count', violations)
  core.setOutput('warning-count', warnings)
  core.setOutput('annotation-count', annotations)
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Terraform policy scan failed'
}

void run()
