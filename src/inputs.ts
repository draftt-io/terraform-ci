export interface ActionInputs {
  planJson: string
  apiUrl: string
  apiKey: string
  githubToken: string
  terraformRoot: string
  policyIds?: string[]
  failOnViolations: boolean
  failOnScanError: boolean
}

export interface InputReader {
  getInput(name: string, options?: { required?: boolean }): string
}

export function readInputs(core: InputReader): ActionInputs {
  const policyIds = parsePolicyIds(core.getInput('policy-ids'))
  return {
    planJson: core.getInput('plan-json', { required: true }),
    apiUrl: core.getInput('api-url', { required: true }),
    apiKey: core.getInput('api-key', { required: true }),
    githubToken: core.getInput('github-token', { required: true }),
    terraformRoot: core.getInput('terraform-root', { required: true }),
    ...(policyIds === undefined ? {} : { policyIds }),
    failOnViolations: parseBoolean(core.getInput('fail-on-violations'), 'fail-on-violations'),
    failOnScanError: parseBoolean(core.getInput('fail-on-scan-error'), 'fail-on-scan-error'),
  }
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
