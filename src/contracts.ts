import { isRecord, requireBoolean, requireNumber, requireString } from './objects.ts'

export interface PolicyHit {
  policyId?: string
  policyName: string
  name?: string
  status: string
  currentVersion?: string
  desiredVersion?: string
  recommendedVersion?: string
  hasForceUpgrade?: boolean
  impendingDate?: string
  outdatedDate?: string
  dueDate?: string
}

export interface FlaggedComponent {
  address: string
  sourceAddress?: string
  tfType: string
  technology: string
  type: string
  currentVersion: string
  policyComponents: PolicyHit[]
}

export interface ScanResponse {
  summary: {
    managedResourcesInPlan: number
    componentsMapped: number
    hasPolicyViolations: boolean
  }
  components: FlaggedComponent[]
  evaluation: {
    evaluatedPolicies?: Array<{ policyId: string; name: string; policyUrl?: string }>
    unevaluatedPolicies: Array<{ policyId: string; name?: string; reason: string }>
    componentsWithGaps: Array<{
      address: string
      policyGaps: Array<{ policyName: string; reason: string; missingAttributes?: string[] }>
    }>
    // Set only when the server applied the repository's exclusions.
    excludedPolicyCount?: number
    excludedEvaluatedPolicyCount?: number
  }
  coverage: {
    unmappedResources: Array<{ address: string; reason: string }>
    mergedResources: unknown[]
    skippedResources: unknown[]
  }
  checkRunUrl?: string
  annotationCount?: number
  publishError?: { code: string; message: string }
}

export function parseScanResponse(value: unknown): ScanResponse {
  if (!isRecord(value)) invalid('root')
  const summary = record(value.summary, 'summary')
  const evaluation = record(value.evaluation, 'evaluation')
  const coverage = record(value.coverage, 'coverage')
  const components = array(value.components, 'components').map(parseFlaggedComponent)
  const hasPolicyViolations = requireBoolean(summary.hasPolicyViolations, 'summary.hasPolicyViolations')
  if (hasPolicyViolations !== (components.length > 0)) invalid('summary.hasPolicyViolations')
  const excludedPolicyCount = optionalCount(evaluation.excludedPolicyCount)
  const excludedEvaluatedPolicyCount = optionalCount(evaluation.excludedEvaluatedPolicyCount)

  const parsed: ScanResponse = {
    summary: {
      managedResourcesInPlan: nonNegativeInteger(summary.managedResourcesInPlan, 'summary.managedResourcesInPlan'),
      componentsMapped: nonNegativeInteger(summary.componentsMapped, 'summary.componentsMapped'),
      hasPolicyViolations,
    },
    components,
    evaluation: {
      ...optionalEvaluatedPolicies(evaluation.evaluatedPolicies),
      unevaluatedPolicies: array(evaluation.unevaluatedPolicies, 'evaluation.unevaluatedPolicies').map((item, index) => {
        const policy = record(item, `evaluation.unevaluatedPolicies.${index}`)
        return {
          policyId: requireString(policy.policyId, 'policyId'),
          ...(typeof policy.name === 'string' ? { name: policy.name } : {}),
          reason: requireString(policy.reason, 'reason'),
        }
      }),
      componentsWithGaps: array(evaluation.componentsWithGaps, 'evaluation.componentsWithGaps').map((item, index) => {
        const component = record(item, `evaluation.componentsWithGaps.${index}`)
        return {
          address: requireString(component.address, 'address'),
          policyGaps: array(component.policyGaps, 'policyGaps').map((gapValue) => {
            const gap = record(gapValue, 'policyGap')
            return {
              policyName: requireString(gap.policyName, 'policyName'),
              reason: requireString(gap.reason, 'reason'),
              ...(Array.isArray(gap.missingAttributes)
                ? { missingAttributes: gap.missingAttributes.filter((name): name is string => typeof name === 'string') }
                : {}),
            }
          }),
        }
      }),
      ...(excludedPolicyCount === undefined ? {} : { excludedPolicyCount }),
      ...(excludedEvaluatedPolicyCount === undefined ? {} : { excludedEvaluatedPolicyCount }),
    },
    coverage: {
      unmappedResources: array(coverage.unmappedResources, 'coverage.unmappedResources').map((item) => {
        const resource = record(item, 'unmappedResource')
        return {
          address: requireString(resource.address, 'address'),
          reason: requireString(resource.reason, 'reason'),
        }
      }),
      mergedResources: array(coverage.mergedResources, 'coverage.mergedResources'),
      skippedResources: array(coverage.skippedResources, 'coverage.skippedResources'),
    },
  }

  const serverHost = safeHost(process.env.GITHUB_SERVER_URL ?? 'https://github.com')
  const checkRunUrl = typeof value.checkRunUrl === 'string' && isTrustedCheckRunUrl(value.checkRunUrl, serverHost) ? value.checkRunUrl : undefined
  const annotationCount = optionalCount(value.annotationCount)
  // The server sends publishError: null when publishing succeeded; only a well-formed object is an error.
  const publishError = isRecord(value.publishError) && typeof value.publishError.code === 'string' && typeof value.publishError.message === 'string'
    ? { code: value.publishError.code, message: value.publishError.message }
    : undefined
  return {
    ...parsed,
    ...(checkRunUrl ? { checkRunUrl } : {}),
    ...(annotationCount === undefined ? {} : { annotationCount }),
    ...(publishError ? { publishError } : {}),
  }
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

function isTrustedCheckRunUrl(value: string, serverHost: string | undefined): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.host === 'github.com' || url.host === serverHost)
  } catch {
    return false
  }
}

function parseFlaggedComponent(value: unknown, index: number): FlaggedComponent {
  const component = record(value, `components.${index}`)
  return {
    address: requireString(component.address, 'address'),
    ...(typeof component.sourceAddress === 'string' ? { sourceAddress: component.sourceAddress } : {}),
    tfType: requireString(component.tfType, 'tfType'),
    technology: requireString(component.technology, 'technology'),
    type: requireString(component.type, 'type'),
    currentVersion: requireString(component.currentVersion, 'currentVersion'),
    policyComponents: array(component.policyComponents, 'policyComponents').map((item) => {
      const policy = record(item, 'policyComponent')
      return {
        ...(typeof policy.policyId === 'string' ? { policyId: policy.policyId } : {}),
        policyName: requireString(policy.policyName, 'policyName'),
        ...(typeof policy.name === 'string' ? { name: policy.name } : {}),
        status: requireString(policy.status, 'status'),
        ...(typeof policy.currentVersion === 'string' ? { currentVersion: policy.currentVersion } : {}),
        ...(typeof policy.desiredVersion === 'string' ? { desiredVersion: policy.desiredVersion } : {}),
        ...(typeof policy.recommendedVersion === 'string' ? { recommendedVersion: policy.recommendedVersion } : {}),
        ...(typeof policy.hasForceUpgrade === 'boolean' ? { hasForceUpgrade: policy.hasForceUpgrade } : {}),
        ...(typeof policy.impendingDate === 'string' ? { impendingDate: policy.impendingDate } : {}),
        ...(typeof policy.outdatedDate === 'string' ? { outdatedDate: policy.outdatedDate } : {}),
        ...(typeof policy.dueDate === 'string' ? { dueDate: policy.dueDate } : {}),
      }
    }),
  }
}

// Read when present and dropped entry by entry when malformed: a response without the field
// (an older server) still parses, and the report falls back to "N components checked".
// A policyUrl outside the Draftt console's policy pages is dropped, never the policy.
function optionalEvaluatedPolicies(value: unknown): { evaluatedPolicies?: Array<{ policyId: string; name: string; policyUrl?: string }> } {
  if (!Array.isArray(value)) return {}
  const evaluatedPolicies = value.flatMap((item) =>
    isRecord(item) && typeof item.policyId === 'string' && typeof item.name === 'string'
      ? [
          {
            policyId: item.policyId,
            name: item.name,
            ...(typeof item.policyUrl === 'string' && isTrustedPolicyUrl(item.policyUrl) ? { policyUrl: item.policyUrl } : {}),
          },
        ]
      : [],
  )
  return { evaluatedPolicies }
}

const POLICY_PATH = /^\/policy\/[1-9][0-9]{0,18}$/

// The https-only copy of ui-backend's isTrustedPolicyUrl (src/services/githubDrafttCi/report/policyLinks.ts), which also accepts the
// dev console over http. The link must point at a Draftt console policy page and be canonical (href equals
// the input), so whitespace, control characters, an upper-case host, encoded digits and an empty `?` or
// `#` are rejected and the string the report renders is exactly what was checked.
function isTrustedPolicyUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.href === value &&
    // An empty `?` or `#` stays in href while search and hash read ''.
    parsed.href === `${parsed.origin}${parsed.pathname}` &&
    (parsed.hostname === 'draftt.io' || parsed.hostname.endsWith('.draftt.io')) &&
    POLICY_PATH.test(parsed.pathname)
  )
}

// An optional count: anything but a non-negative safe integer is dropped.
function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(field)
  return value
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field)
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field)
  if (!Number.isInteger(number) || number < 0) invalid(field)
  return number
}

function invalid(field: string): never {
  throw new Error(`Invalid API response: ${field}`)
}
