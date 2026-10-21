// GitHub's official toolkit handles Action inputs, masking, outputs, summaries, and failures.
import * as core from '@actions/core'
import { context } from '@actions/github'
import { scanTerraformPlan } from './api.ts'
import { CheckPublisher, getHeadSha, isExternalFork } from './github-check.ts'
import { readInputs } from './inputs.ts'
import { scanErrorConclusion, violationConclusion } from './outcome.ts'
import { readAndSanitizePlan, serializeScanRequest } from './plan.ts'
import { buildScanReport } from './report.ts'
import { buildGitHubContext } from './request.ts'
import { run } from './run.ts'
import { buildSourceMap } from './source-map.ts'
import { TerraformSourceLocator } from './source-locator.ts'
import { inspectWorkspaceForSourceMapping } from './workspace.ts'

void run({
  runtime: {
    getInput: core.getInput,
    setSecret: core.setSecret,
    setOutput: core.setOutput,
    setFailed: core.setFailed,
    warning: core.warning,
    info: core.info,
    writeSummary: async (markdown) => {
      await core.summary.addRaw(markdown).write()
    },
  },
  isExternalFork,
  getHeadSha,
  createPublisher: (input) => new CheckPublisher(input),
  readInputs,
  readAndSanitizePlan,
  serializeScanRequest,
  inspectWorkspaceForSourceMapping,
  createSourceLocator: async (workspaceRoot, terraformRoot) => (
    await TerraformSourceLocator.create({ workspaceRoot, terraformRoot })
  ),
  buildSourceMap,
  buildGitHubContext,
  eventPayload: () => context.payload,
  env: () => process.env,
  scanTerraformPlan,
  buildScanReport,
  violationConclusion,
  scanErrorConclusion,
  workspaceRoot: () => process.env.GITHUB_WORKSPACE ?? process.cwd(),
})
