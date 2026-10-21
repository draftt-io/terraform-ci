import path from 'node:path'

export type PublishMode = 'server' | 'action'

export interface ActionInputs {
  planJson: string
  apiUrl: string
  apiKey: string
  githubToken?: string
  terraformRoot: string
  policyIds?: string[]
  // Deprecated and a no-op in every flow: true only prints the deprecation warning.
  failOnViolations: boolean
  failOnScanError: boolean
}

export interface InputReader {
  getInput(name: string, options?: { required?: boolean }): string
}

export function readInputs(core: InputReader): ActionInputs {
  const policyIds = parsePolicyIds(core.getInput('policy-ids'))
  const githubToken = core.getInput('github-token')
  const failOnViolations = parseOptionalBoolean(core.getInput('fail-on-violations'), 'fail-on-violations')
  const inputs: ActionInputs = {
    planJson: core.getInput('plan-json', { required: true }),
    apiUrl: core.getInput('api-url', { required: true }),
    apiKey: core.getInput('api-key', { required: true }),
    ...(githubToken === '' ? {} : { githubToken }),
    terraformRoot: core.getInput('terraform-root', { required: true }),
    ...(policyIds === undefined ? {} : { policyIds }),
    failOnViolations,
    failOnScanError: parseBoolean(core.getInput('fail-on-scan-error'), 'fail-on-scan-error'),
  }
  // Validated with the other inputs; run reads the mode itself to choose the flow before they are parsed.
  parsePublishMode(core.getInput('publish-mode'))
  return inputs
}

export function parsePublishMode(value: string): PublishMode {
  if (value === '' || value === 'server') return 'server'
  if (value === 'action') return 'action'
  throw new Error('publish-mode must be "server" or "action"')
}

const SCAN_KEY = /^[A-Za-z0-9._/-]{1,200}$/

// terraform-root as the server's scan key: one check and one comment per root module.
// Equivalent spellings map to one key ('./modules//eks/' -> 'modules/eks', './' -> '.'). An absolute
// root (e.g. ${{ github.workspace }}, which v0.1.1 accepts) is made relative to `workspace`
// (pass GITHUB_WORKSPACE); an absolute root outside it, or with no workspace given, is rejected.
export function scanKeyFromTerraformRoot(terraformRoot: string, workspace?: string): string {
  const relative = terraformRoot.startsWith('/') ? relativeToWorkspace(terraformRoot, workspace) : terraformRoot
  const normalized = path.posix.normalize(relative === '' ? '.' : relative).replace(/\/+$/, '')
  const key = normalized === '' ? '.' : normalized
  if (!SCAN_KEY.test(key) || key.startsWith('/') || key.split('/').includes('..')) throw new Error(RELATIVE_ROOT_ERROR)
  return key
}

const RELATIVE_ROOT_ERROR = 'terraform-root must be a relative path without ".." segments'

function relativeToWorkspace(absoluteRoot: string, workspace: string | undefined): string {
  if (!workspace || !workspace.startsWith('/')) throw new Error(RELATIVE_ROOT_ERROR)
  const relative = path.posix.relative(path.posix.normalize(workspace), path.posix.normalize(absoluteRoot))
  if (relative === '..' || relative.startsWith('../') || relative.startsWith('/')) throw new Error(RELATIVE_ROOT_ERROR)
  return relative === '' ? '.' : relative
}

export function parsePolicyIds(value: string): string[] | undefined {
  if (value.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('policy-ids must be a JSON array of decimal-string ids')
  }
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string' && /^(?:0|[1-9]\d*)$/.test(id))) {
    throw new Error('policy-ids must be a JSON array of decimal-string ids')
  }
  return parsed
}

// action.yml gives fail-on-violations no default, so '' is a valid, unset value (false).
function parseOptionalBoolean(value: string, name: string): boolean {
  return value === '' ? false : parseBoolean(value, name)
}

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}
