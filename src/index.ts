// GitHub's official toolkit handles Action inputs, masking, outputs, summaries, and failures.
import { existsSync, readFileSync } from 'node:fs'
import * as core from '@actions/core'
import { scanTerraformPlan } from './api.ts'
import { readInputs } from './inputs.ts'
import { isRecord } from './objects.ts'
import { readAndSanitizePlan, serializeScanRequest } from './plan.ts'
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
  readInputs,
  readAndSanitizePlan,
  serializeScanRequest,
  inspectWorkspaceForSourceMapping,
  createSourceLocator: async (workspaceRoot, terraformRoot) => (
    await TerraformSourceLocator.create({ workspaceRoot, terraformRoot })
  ),
  buildSourceMap,
  buildGitHubContext,
  eventPayload: readEventPayload,
  env: () => process.env,
  scanTerraformPlan,
  workspaceRoot: () => process.env.GITHUB_WORKSPACE ?? process.cwd(),
})

// The webhook payload of the triggering event, which the runner writes to GITHUB_EVENT_PATH; {} without one.
function readEventPayload(): Record<string, unknown> {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !existsSync(eventPath)) return {}
  const payload: unknown = JSON.parse(readFileSync(eventPath, 'utf8'))
  return isRecord(payload) ? payload : {}
}
