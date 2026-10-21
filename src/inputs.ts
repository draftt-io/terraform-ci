import path from 'node:path'

export interface ActionInputs {
  planJson: string
  apiUrl: string
  apiKey: string
  terraformRoot: string
  policyIds?: string[]
  failOnScanError: boolean
}

export interface InputReader {
  getInput(name: string, options?: { required?: boolean }): string
}

export function readInputs(core: InputReader): ActionInputs {
  const policyIds = parsePolicyIds(core.getInput('policy-ids'))
  const failOnScanError = core.getInput('fail-on-scan-error')
  if (failOnScanError !== 'true' && failOnScanError !== 'false') throw new Error('fail-on-scan-error must be true or false')
  return {
    planJson: core.getInput('plan-json', { required: true }),
    apiUrl: parseApiUrl(core.getInput('api-url', { required: true })),
    apiKey: core.getInput('api-key', { required: true }),
    terraformRoot: core.getInput('terraform-root', { required: true }),
    ...(policyIds === undefined ? {} : { policyIds }),
    failOnScanError: failOnScanError === 'true',
  }
}

const SCANS_PATH = '/ci/scans'

// The Draftt CI scans endpoint, over HTTPS and without credentials; a trailing slash is tolerated.
// Checked with the other inputs, before the plan is read.
function parseApiUrl(value: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new Error('api-url must be a valid URL')
  }
  if (endpoint.protocol !== 'https:') throw new Error('api-url must use HTTPS')
  if (endpoint.username || endpoint.password) throw new Error('api-url must not contain credentials')
  if (!endpoint.pathname.replace(/\/+$/, '').endsWith(SCANS_PATH)) {
    throw new Error(`api-url must be the Draftt CI scans endpoint, ending in ${SCANS_PATH} (for example https://api.draftt.io${SCANS_PATH})`)
  }
  return value
}

const SCAN_KEY = /^[A-Za-z0-9._/-]{1,200}$/

// terraform-root as the server's scan key: one check and one comment per root module.
// Equivalent spellings map to one key ('./modules//eks/' -> 'modules/eks', './' -> '.'). An absolute
// root (e.g. ${{ github.workspace }}) is made relative to `workspace`
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
