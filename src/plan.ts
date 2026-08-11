import { realpath, stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isRecord } from './objects.ts'

export const MAX_PLAN_BYTES = 50 * 1024 * 1024

const SECRET_FIELD_NAMES = new Set([
  'access_key',
  'access_token',
  'api_key',
  'api_token',
  'auth_token',
  'bearer_token',
  'client_certificate',
  'client_key',
  'client_secret',
  'connection_string',
  'connection_uri',
  'credential',
  'credentials',
  'event_source_token',
  'external_id',
  'id_token',
  'master_password',
  'master_password_wo',
  'master_user_secret',
  'oauth_token',
  'password',
  'password_data',
  'password_wo',
  'private_key',
  'private_key_data',
  'private_key_pem',
  'refresh_token',
  'secret',
  'secret_binary',
  'secret_key',
  'secret_string',
  'service_account_json',
  'service_account_key',
  'session_token',
  'token',
  'web_identity_token',
])

const CREDENTIAL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'PEM private key', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'credential URL', pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i },
]

const ABSENT = Symbol('absent')
const TERRAFORM_ACTIONS = new Set(['create', 'delete', 'forget', 'no-op', 'read', 'update'])

export interface SanitizedPlan {
  format_version: string
  resource_changes: Array<Record<string, unknown>>
  configuration?: Record<string, unknown>
  variables?: Record<string, unknown>
}

interface RetainedResource {
  change: Record<string, unknown>
  address: string
  configAddress: string
  sensitiveAttributes: Set<string>
}

export async function readAndSanitizePlan(planPath: string, workspaceRoot: string): Promise<SanitizedPlan> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(workspaceRoot)
  } catch {
    throw new Error('GitHub workspace could not be read')
  }
  const requestedPath = resolveInside(canonicalRoot, planPath)
  let absolutePath: string
  try {
    absolutePath = resolveInside(canonicalRoot, await realpath(requestedPath))
  } catch {
    throw new Error('Plan JSON could not be read')
  }
  const file = await stat(absolutePath)
  if (!file.isFile()) throw new Error('Plan JSON path is not a file')
  if (file.size > MAX_PLAN_BYTES) throw new Error('Plan JSON exceeds the 50 MiB input limit')

  let raw: string
  try {
    raw = await readFile(absolutePath, 'utf8')
  } catch {
    throw new Error('Plan JSON could not be read')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Plan JSON is not valid JSON')
  } finally {
    raw = ''
  }
  return sanitizePlan(parsed)
}

export function sanitizePlan(plan: unknown): SanitizedPlan {
  if (!isRecord(plan)) throw new Error('Terraform plan must be a JSON object')
  if (typeof plan.format_version !== 'string' || plan.format_version.split('.')[0] !== '1') {
    throw new Error('Terraform plan has an unsupported format_version')
  }
  if (!Array.isArray(plan.resource_changes)) throw new Error('Terraform plan is missing resource_changes')

  const retained: RetainedResource[] = []
  const resourceChanges: Array<Record<string, unknown>> = []
  for (const candidate of plan.resource_changes) {
    if (!isRecord(candidate)) continue
    const managed = candidate.mode === 'managed'
    const callerIdentity = candidate.mode === 'data' && candidate.type === 'aws_caller_identity'
    if (!managed && !callerIdentity) continue
    validateResourceChange(candidate)
    const projected = projectResourceChange(candidate)
    retained.push(projected)
    resourceChanges.push(projected.change)
  }

  const result: SanitizedPlan = {
    format_version: plan.format_version,
    resource_changes: resourceChanges,
  }

  const configuration = projectConfiguration(plan.configuration, retained)
  if (configuration) result.configuration = configuration.configuration
  const variables = projectVariables(plan.variables, configuration?.providerExpressions)
  if (variables && Object.keys(variables).length > 0) result.variables = variables

  assertNoRecognizedCredentials(result)
  return result
}

function validateResourceChange(resource: Record<string, unknown>): void {
  for (const field of ['address', 'mode', 'type', 'name'] as const) {
    if (typeof resource[field] !== 'string' || resource[field].length === 0) {
      throw new Error(`Terraform resource change has an invalid ${field}`)
    }
  }
  if (!isRecord(resource.change)) throw new Error('Terraform resource change is missing change data')
  const change = resource.change
  if (
    !Array.isArray(change.actions)
    || change.actions.length === 0
    || !change.actions.every((action) => typeof action === 'string' && TERRAFORM_ACTIONS.has(action))
  ) {
    throw new Error('Terraform resource change has invalid actions')
  }
  for (const field of ['before', 'after'] as const) {
    if (change[field] !== null && change[field] !== undefined && !isRecord(change[field])) {
      throw new Error(`Terraform resource change has invalid ${field} values`)
    }
  }
  if (!isRecord(change.after_unknown)) throw new Error('Terraform resource change has an invalid after_unknown mirror')
  validateBooleanMirror(change.after_unknown, 'after_unknown')
  for (const field of ['before_sensitive', 'after_sensitive'] as const) {
    const mirror = change[field]
    if (mirror !== undefined && typeof mirror !== 'boolean' && !isRecord(mirror)) {
      throw new Error(`Terraform resource change has an invalid ${field} mirror`)
    }
    if (mirror !== undefined) {
      validateBooleanMirror(mirror, field)
      validateExpectedSensitiveFields(mirror, field)
    }
  }
}

function validateBooleanMirror(value: unknown, path: string): void {
  if (typeof value === 'boolean' || value === null) return
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateBooleanMirror(child, `${path}.${index}`))
    return
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) validateBooleanMirror(child, `${path}.${key}`)
    return
  }
  throw new Error(`Terraform plan has an invalid value mirror at ${path}`)
}

function validateExpectedSensitiveFields(value: unknown, path: string, fieldName?: string): void {
  if (value === false || value === null) return
  if (value === true) {
    if (fieldName === undefined || !SECRET_FIELD_NAMES.has(fieldName.toLowerCase())) {
      throw new Error(`Terraform plan marks an unsupported sensitive field at ${path}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateExpectedSensitiveFields(child, `${path}.${index}`, fieldName))
    return
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) validateExpectedSensitiveFields(child, `${path}.${key}`, key)
  }
}

export function serializeScanRequest(plan: SanitizedPlan, policyIds: string[] | undefined): string {
  const request = policyIds === undefined ? { plan } : { plan, policyIds }
  const body = JSON.stringify(request)
  if (Buffer.byteLength(body) > MAX_PLAN_BYTES) throw new Error('Scrubbed scan request exceeds the 50 MiB request limit')
  return body
}

function projectResourceChange(resource: Record<string, unknown>): RetainedResource {
  const address = typeof resource.address === 'string' ? resource.address : ''
  const beforeSensitive = isRecord(resource.change) ? resource.change.before_sensitive : undefined
  const afterSensitive = isRecord(resource.change) ? resource.change.after_sensitive : undefined
  const mirrors = [beforeSensitive, afterSensitive]
  const sourceChange = isRecord(resource.change) ? resource.change : {}
  const projectedChange: Record<string, unknown> = {
    actions: Array.isArray(sourceChange.actions) ? structuredClone(sourceChange.actions) : [],
    before: scrubValue(sourceChange.before, mirrors, 'before'),
    after: scrubValue(sourceChange.after, mirrors, 'after'),
    after_unknown: scrubValue(sourceChange.after_unknown ?? {}, [], 'after_unknown'),
  }
  for (const key of ['before', 'after'] as const) {
    if (projectedChange[key] === ABSENT) projectedChange[key] = null
  }

  const output: Record<string, unknown> = {
    address,
    mode: resource.mode,
    type: typeof resource.type === 'string' ? resource.type : '',
    name: typeof resource.name === 'string' ? resource.name : '',
    change: projectedChange,
  }

  return {
    change: output,
    address,
    configAddress: stripInstanceKeys(address),
    sensitiveAttributes: topLevelSensitiveAttributes(mirrors),
  }
}

function scrubValue(value: unknown, mirrors: unknown[], pathPrefix: string): unknown | typeof ABSENT {
  if (mirrors.some((mirror) => mirror === true)) return ABSENT
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const itemMirrors = mirrors.map((mirror) => (Array.isArray(mirror) ? mirror[index] : undefined))
      const scrubbed = scrubValue(item, itemMirrors, `${pathPrefix}.${index}`)
      return scrubbed === ABSENT ? null : scrubbed
    })
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_FIELD_NAMES.has(key.toLowerCase())) continue
      const childMirrors = mirrors.map((mirror) => (isRecord(mirror) ? mirror[key] : undefined))
      const scrubbed = scrubValue(child, childMirrors, `${pathPrefix}.${key}`)
      if (scrubbed !== ABSENT) output[key] = scrubbed
    }
    return output
  }
  return value
}

function topLevelSensitiveAttributes(mirrors: unknown[]): Set<string> {
  const attributes = new Set<string>()
  for (const mirror of mirrors) {
    if (!isRecord(mirror)) continue
    for (const [key, value] of Object.entries(mirror)) {
      if (hasSensitiveMarker(value)) attributes.add(key)
    }
  }
  return attributes
}

function hasSensitiveMarker(value: unknown): boolean {
  if (value === true) return true
  if (Array.isArray(value)) return value.some(hasSensitiveMarker)
  return isRecord(value) && Object.values(value).some(hasSensitiveMarker)
}

interface ProjectedConfiguration {
  configuration: Record<string, unknown>
  providerExpressions: unknown[]
}

function projectConfiguration(value: unknown, retained: RetainedResource[]): ProjectedConfiguration | undefined {
  if (!isRecord(value)) return undefined
  const retainedAddresses = new Set(retained.map(({ configAddress }) => configAddress))
  const sensitiveByAddress = new Map<string, Set<string>>()
  for (const resource of retained) {
    const fields = sensitiveByAddress.get(resource.configAddress) ?? new Set<string>()
    for (const field of resource.sensitiveAttributes) fields.add(field)
    sensitiveByAddress.set(resource.configAddress, fields)
  }

  const providerKeys = new Set<string>()
  const rootModule = isRecord(value.root_module)
    ? projectConfigModule(value.root_module, '', retainedAddresses, sensitiveByAddress, providerKeys)
    : undefined
  const providerProjection = projectProviderConfiguration(value.provider_config, providerKeys)
  const configuration: Record<string, unknown> = {}
  if (rootModule) configuration.root_module = rootModule
  if (providerProjection.providerConfig) configuration.provider_config = providerProjection.providerConfig
  return Object.keys(configuration).length > 0
    ? { configuration, providerExpressions: providerProjection.expressions }
    : undefined
}

function projectConfigModule(
  module: Record<string, unknown>,
  prefix: string,
  retainedAddresses: Set<string>,
  sensitiveByAddress: Map<string, Set<string>>,
  providerKeys: Set<string>,
): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {}
  const resources: Array<Record<string, unknown>> = []
  if (Array.isArray(module.resources)) {
    for (const candidate of module.resources) {
      if (!isRecord(candidate) || typeof candidate.address !== 'string') continue
      const fullAddress = prefix ? `${prefix}.${candidate.address}` : candidate.address
      const configAddress = stripInstanceKeys(fullAddress)
      if (!retainedAddresses.has(configAddress)) continue
      const projected: Record<string, unknown> = {
        address: candidate.address,
        mode: candidate.mode,
        type: candidate.type,
        name: candidate.name,
      }
      if (typeof candidate.provider_config_key === 'string') {
        projected.provider_config_key = candidate.provider_config_key
        providerKeys.add(candidate.provider_config_key)
      }
      if (isRecord(candidate.expressions)) {
        const expressions: Record<string, unknown> = {}
        const sensitive = sensitiveByAddress.get(configAddress) ?? new Set<string>()
        for (const [key, expression] of Object.entries(candidate.expressions)) {
          if (sensitive.has(key) || SECRET_FIELD_NAMES.has(key.toLowerCase())) continue
          const scrubbed = scrubValue(expression, [], `configuration.${configAddress}.${key}`)
          if (scrubbed !== ABSENT) expressions[key] = scrubbed
        }
        projected.expressions = expressions
      }
      resources.push(projected)
    }
  }
  if (resources.length > 0) output.resources = resources

  const moduleCalls: Record<string, unknown> = {}
  if (isRecord(module.module_calls)) {
    for (const [name, call] of Object.entries(module.module_calls)) {
      if (!isRecord(call) || !isRecord(call.module)) continue
      const childPrefix = prefix ? `${prefix}.module.${name}` : `module.${name}`
      const child = projectConfigModule(call.module, childPrefix, retainedAddresses, sensitiveByAddress, providerKeys)
      if (child) moduleCalls[name] = { module: child }
    }
  }
  if (Object.keys(moduleCalls).length > 0) output.module_calls = moduleCalls
  return Object.keys(output).length > 0 ? output : undefined
}

function projectProviderConfiguration(value: unknown, providerKeys: Set<string>): {
  providerConfig?: Record<string, unknown>
  expressions: unknown[]
} {
  if (!isRecord(value)) return { expressions: [] }
  const output: Record<string, unknown> = {}
  const retainedExpressions: unknown[] = []
  const regionKeys = new Set([...providerKeys].map((key) => key.slice(key.lastIndexOf(':') + 1)))
  for (const key of new Set([...providerKeys, ...regionKeys])) {
    const provider = value[key]
    if (!isRecord(provider) || !isRecord(provider.expressions)) continue
    const expressions: Record<string, unknown> = {}
    if (regionKeys.has(key) && provider.expressions.region !== undefined) {
      expressions.region = structuredClone(provider.expressions.region)
      retainedExpressions.push(expressions.region)
    }
    if (providerKeys.has(key)) {
      for (const roleField of ['assume_role', 'assume_role_with_web_identity'] as const) {
        const roles = projectRoleExpressions(provider.expressions[roleField])
        if (roles !== undefined) {
          expressions[roleField] = roles
          retainedExpressions.push(roles)
        }
      }
    }
    if (Object.keys(expressions).length > 0) output[key] = { expressions }
  }
  return Object.keys(output).length > 0 ? { providerConfig: output, expressions: retainedExpressions } : { expressions: [] }
}

function projectRoleExpressions(value: unknown): unknown {
  const roles = Array.isArray(value) ? value : isRecord(value) ? [value] : []
  const projected = roles.flatMap((role) => {
    if (!isRecord(role) || role.role_arn === undefined) return []
    return [{ role_arn: structuredClone(role.role_arn) }]
  })
  return projected.length > 0 ? projected : undefined
}

function projectVariables(value: unknown, providerExpressions: unknown[] | undefined): Record<string, unknown> | undefined {
  if (!isRecord(value) || !providerExpressions) return undefined
  const references = new Set<string>()
  for (const expression of providerExpressions) collectVariableReferences(expression, references)
  const output: Record<string, unknown> = {}
  for (const name of references) {
    const variable = value[name]
    if (!isRecord(variable) || typeof variable.value !== 'string' || !isSafeProviderValue(variable.value)) continue
    output[name] = { value: variable.value }
  }
  return output
}

function collectVariableReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectVariableReferences(child, references)
    return
  }
  if (!isRecord(value)) return
  if (Array.isArray(value.references)) {
    for (const reference of value.references) {
      if (typeof reference === 'string' && reference.startsWith('var.') && reference.length > 4) references.add(reference.slice(4))
    }
  }
  for (const child of Object.values(value)) collectVariableReferences(child, references)
}

function isSafeProviderValue(value: string): boolean {
  const region = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(value)
  const roleArn = /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b):iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]+$/.test(value)
  return region || roleArn
}

function assertNoRecognizedCredentials(value: unknown, pathPrefix = 'plan'): void {
  if (typeof value === 'string') {
    for (const detector of CREDENTIAL_PATTERNS) {
      if (detector.pattern.test(value)) throw new Error(`Scrubbed plan still contains a recognized ${detector.name} at ${pathPrefix}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoRecognizedCredentials(child, `${pathPrefix}.${index}`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) assertNoRecognizedCredentials(child, `${pathPrefix}.${key}`)
}

function stripInstanceKeys(address: string): string {
  let result = ''
  let bracketDepth = 0
  let quoted = false
  let escaped = false
  for (const char of address) {
    if (bracketDepth > 0) {
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '[') bracketDepth += 1
      else if (char === ']') bracketDepth -= 1
      continue
    }
    if (char === '[') bracketDepth = 1
    else result += char
  }
  return result
}

function resolveInside(root: string, candidate: string): string {
  const absoluteRoot = path.resolve(root)
  const absolute = path.resolve(absoluteRoot, candidate)
  const relative = path.relative(absoluteRoot, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Plan JSON path must stay inside the workspace')
  return absolute
}
