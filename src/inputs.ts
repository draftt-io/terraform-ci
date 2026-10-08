export type PublishMode = 'server' | 'action'

export interface ActionInputs {
  planJson: string
  apiUrl: string
  apiKey: string
  githubToken?: string
  terraformRoot: string
  policyIds?: string[]
  failOnViolations: boolean
  failOnScanError: boolean
  publishMode: PublishMode
}

export interface InputReader {
  getInput(name: string, options?: { required?: boolean }): string
}

export function readInputs(core: InputReader): ActionInputs {
  const policyIds = parsePolicyIds(core.getInput('policy-ids'))
  const githubToken = core.getInput('github-token')
  return {
    planJson: core.getInput('plan-json', { required: true }),
    apiUrl: core.getInput('api-url', { required: true }),
    apiKey: core.getInput('api-key', { required: true }),
    ...(githubToken === '' ? {} : { githubToken }),
    terraformRoot: core.getInput('terraform-root', { required: true }),
    ...(policyIds === undefined ? {} : { policyIds }),
    failOnViolations: parseBoolean(core.getInput('fail-on-violations'), 'fail-on-violations'),
    failOnScanError: parseBoolean(core.getInput('fail-on-scan-error'), 'fail-on-scan-error'),
    publishMode: parsePublishMode(core.getInput('publish-mode')),
  }
}

function parsePublishMode(value: string): PublishMode {
  if (value === '' || value === 'server') return 'server'
  if (value === 'action') return 'action'
  throw new Error('publish-mode must be "server" or "action"')
}

const SCAN_KEY = /^[A-Za-z0-9._/-]{1,200}$/

// terraform-root as the server's scan key: one check and one comment per root module.
export function scanKeyFromTerraformRoot(terraformRoot: string): string {
  const trimmed = terraformRoot.replace(/^\.\//, '').replace(/\/+$/, '')
  const key = trimmed === '' || trimmed === '.' ? '.' : trimmed
  if (!SCAN_KEY.test(key) || key.split('/').includes('..')) throw new Error('terraform-root must be a relative path without ".." segments')
  return key
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

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}
