import { isRecord, requireBoolean, requireNumber, requireString } from './objects.ts'

export interface PolicyHit {
  policyId: string
  policyName: string
  status: string
  currentVersion: string
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
  tfName: string
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
    evaluatedPolicies: Array<{ policyId: string; name: string }>
    unevaluatedPolicies: Array<{ policyId: string; name?: string; reason: string }>
    componentsFullyEvaluated: number
    componentsWithGaps: Array<{
      address: string
      sourceAddress?: string
      tfType: string
      tfName: string
      policyGaps: Array<{ policyId: string; policyName: string; reason: string; fields?: string[] }>
    }>
  }
  coverage: {
    unmappedResources: Array<{ address: string; tfType: string; reason: string }>
    mergedResources: Array<{ address: string; tfType: string; mergedInto: string | string[] }>
    skippedResources: Array<{ address: string; tfType: string; action: string }>
  }
}

export function parseScanResponse(value: unknown): ScanResponse {
  if (!isRecord(value)) invalid('root')
  const summary = record(value.summary, 'summary')
  const evaluation = record(value.evaluation, 'evaluation')
  const coverage = record(value.coverage, 'coverage')
  const components = array(value.components, 'components').map(parseFlaggedComponent)
  const hasPolicyViolations = requireBoolean(summary.hasPolicyViolations, 'summary.hasPolicyViolations')
  if (hasPolicyViolations !== (components.length > 0)) invalid('summary.hasPolicyViolations')

  return {
    summary: {
      managedResourcesInPlan: nonNegativeInteger(summary.managedResourcesInPlan, 'summary.managedResourcesInPlan'),
      componentsMapped: nonNegativeInteger(summary.componentsMapped, 'summary.componentsMapped'),
      hasPolicyViolations,
    },
    components,
    evaluation: {
      evaluatedPolicies: array(evaluation.evaluatedPolicies, 'evaluation.evaluatedPolicies').map((item, index) => {
        const policy = record(item, `evaluation.evaluatedPolicies.${index}`)
        return { policyId: requireString(policy.policyId, 'policyId'), name: requireString(policy.name, 'name') }
      }),
      unevaluatedPolicies: array(evaluation.unevaluatedPolicies, 'evaluation.unevaluatedPolicies').map((item, index) => {
        const policy = record(item, `evaluation.unevaluatedPolicies.${index}`)
        return {
          policyId: requireString(policy.policyId, 'policyId'),
          ...(typeof policy.name === 'string' ? { name: policy.name } : {}),
          reason: requireString(policy.reason, 'reason'),
        }
      }),
      componentsFullyEvaluated: nonNegativeInteger(evaluation.componentsFullyEvaluated, 'evaluation.componentsFullyEvaluated'),
      componentsWithGaps: array(evaluation.componentsWithGaps, 'evaluation.componentsWithGaps').map((item, index) => {
        const component = record(item, `evaluation.componentsWithGaps.${index}`)
        return {
          ...terraformFields(component),
          policyGaps: array(component.policyGaps, 'policyGaps').map((gapValue) => {
            const gap = record(gapValue, 'policyGap')
            const fields = gap.fields === undefined ? undefined : array(gap.fields, 'fields').map((field) => requireString(field, 'field'))
            return {
              policyId: requireString(gap.policyId, 'policyId'),
              policyName: requireString(gap.policyName, 'policyName'),
              reason: requireString(gap.reason, 'reason'),
              ...(fields ? { fields } : {}),
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
          tfType: requireString(resource.tfType, 'tfType'),
          reason: requireString(resource.reason, 'reason'),
        }
      }),
      mergedResources: array(coverage.mergedResources, 'coverage.mergedResources').map((item) => {
        const resource = record(item, 'mergedResource')
        const mergedInto = typeof resource.mergedInto === 'string'
          ? resource.mergedInto
          : array(resource.mergedInto, 'mergedInto').map((address) => requireString(address, 'mergedInto'))
        return {
          address: requireString(resource.address, 'address'),
          tfType: requireString(resource.tfType, 'tfType'),
          mergedInto,
        }
      }),
      skippedResources: array(coverage.skippedResources, 'coverage.skippedResources').map((item) => {
        const resource = record(item, 'skippedResource')
        return {
          address: requireString(resource.address, 'address'),
          tfType: requireString(resource.tfType, 'tfType'),
          action: requireString(resource.action, 'action'),
        }
      }),
    },
  }
}

function parseFlaggedComponent(value: unknown, index: number): FlaggedComponent {
  const component = record(value, `components.${index}`)
  return {
    ...terraformFields(component),
    technology: requireString(component.technology, 'technology'),
    type: requireString(component.type, 'type'),
    currentVersion: requireString(component.currentVersion, 'currentVersion'),
    policyComponents: array(component.policyComponents, 'policyComponents').map((item) => {
      const policy = record(item, 'policyComponent')
      return {
        policyId: requireString(policy.policyId, 'policyId'),
        policyName: requireString(policy.policyName, 'policyName'),
        status: requireString(policy.status, 'status'),
        currentVersion: requireString(policy.currentVersion, 'currentVersion'),
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

function terraformFields(value: Record<string, unknown>): Pick<FlaggedComponent, 'address' | 'sourceAddress' | 'tfType' | 'tfName'> {
  return {
    address: requireString(value.address, 'address'),
    ...(typeof value.sourceAddress === 'string' ? { sourceAddress: value.sourceAddress } : {}),
    tfType: requireString(value.tfType, 'tfType'),
    tfName: requireString(value.tfName, 'tfName'),
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
