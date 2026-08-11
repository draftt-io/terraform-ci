// GitHub's official toolkit handles Action inputs, masking, outputs, summaries, and failures.
import * as core from '@actions/core'
import { scanTerraformPlan } from './api.ts'
import { CheckPublisher, getHeadSha, isExternalFork } from './github-check.ts'
import { readInputs } from './inputs.ts'
import { completedConclusion, scanErrorConclusion } from './outcome.ts'
import { readAndSanitizePlan, serializeScanRequest } from './plan.ts'
import { buildScanReport } from './report.ts'
import { run } from './run.ts'
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
  createPublisher: (token, headSha) => new CheckPublisher(token, headSha),
  readInputs,
  readAndSanitizePlan,
  serializeScanRequest,
  inspectWorkspaceForSourceMapping,
  createSourceLocator: async (workspaceRoot, terraformRoot) => (
    await TerraformSourceLocator.create({ workspaceRoot, terraformRoot })
  ),
  scanTerraformPlan,
  buildScanReport,
  completedConclusion,
  scanErrorConclusion,
  workspaceRoot: () => process.env.GITHUB_WORKSPACE ?? process.cwd(),
})
