// GitHub's official toolkit handles Action inputs, masking, outputs, summaries, and failures.
import * as core from '@actions/core'
import { run } from './run.ts'

const apiKey = core.getInput('api-key')
if (apiKey) core.setSecret(apiKey)
if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
  core.info('On pull_request_target the planned code runs with access to the Draftt key; prefer pull_request.')
}

const eventPath = process.env.GITHUB_EVENT_PATH
const result = await run({
  inputs: core,
  ...(eventPath === undefined ? {} : { eventPath }),
  env: process.env,
  workspaceRoot: process.env.GITHUB_WORKSPACE ?? process.cwd(),
  serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
})

for (const warning of result.warnings) core.warning(warning)
try {
  await core.summary.addRaw(result.summary).write()
} catch (error) {
  // Without a summary file (outside a workflow run) the outputs and the log still carry the result.
  core.warning(`The workflow summary could not be written: ${error instanceof Error ? error.message : 'unknown error'}`)
}
core.setOutput('scan-status', result.outputs.status)
core.setOutput('violation-count', result.outputs.violations)
core.setOutput('warning-count', result.outputs.warnings)
core.setOutput('annotation-count', result.outputs.annotations)
core.setOutput('check-run-url', result.outputs.checkRunUrl)
if (result.failure !== undefined) core.setFailed(result.failure)
