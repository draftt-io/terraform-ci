import { isRecord, requireBoolean, requireNumber, requireString } from './objects.ts'

export interface PolicyHit {
  policyName: string
  status: string
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
    unevaluatedPolicies: Array<{ policyId: string; name?: string; reason: string }>
    componentsWithGaps: Array<{
      address: string
      policyGaps: Array<{ policyName: string; reason: string }>
    }>
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

export function parseScanResponse(value: unknown, options: { serverUrl?: string } = {}): ScanResponse {
  if (!isRecord(value)) invalid('root')
  const summary = record(value.summary, 'summary')
  const evaluation = record(value.evaluation, 'evaluation')
  const coverage = record(value.coverage, 'coverage')
  const components = array(value.components, 'components').map(parseFlaggedComponent)
  const hasPolicyViolations = requireBoolean(summary.hasPolicyViolations, 'summary.hasPolicyViolations')
  if (hasPolicyViolations !== (components.length > 0)) invalid('summary.hasPolicyViolations')

  const parsed: ScanResponse = {
    summary: {
      managedResourcesInPlan: nonNegativeInteger(summary.managedResourcesInPlan, 'summary.managedResourcesInPlan'),
      componentsMapped: nonNegativeInteger(summary.componentsMapped, 'summary.componentsMapped'),
      hasPolicyViolations,
    },
    components,
    evaluation: {
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
            }
          }),
        }
      }),
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

  const serverHost = safeHost(options.serverUrl ?? process.env.GITHUB_SERVER_URL ?? 'https://github.com')
  const checkRunUrl = typeof value.checkRunUrl === 'string' && isTrustedCheckRunUrl(value.checkRunUrl, serverHost) ? value.checkRunUrl : undefined
  const annotationCount = Number.isSafeInteger(value.annotationCount) && (value.annotationCount as number) >= 0 ? (value.annotationCount as number) : undefined
  // The server sends publishError: null when publishing succeeded; only a well-formed object is an error.
  const publishError = isRecord(value.publishError) && typeof value.publishError.code === 'string' && typeof value.publishError.message === 'string'
    ? { code: value.publishError.code, message: value.publishError.message }
    : undefined
  return { ...parsed, ...(checkRunUrl ? { checkRunUrl } : {}), ...(annotationCount === undefined ? {} : { annotationCount }), ...(publishError ? { publishError } : {}) }
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
        policyName: requireString(policy.policyName, 'policyName'),
        status: requireString(policy.status, 'status'),
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
