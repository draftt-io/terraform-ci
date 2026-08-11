import type { ScanResponse } from '../src/contracts.ts'

export function scanResponse(overrides: Partial<ScanResponse> = {}): ScanResponse {
  return {
    summary: { managedResourcesInPlan: 1, componentsMapped: 1, hasPolicyViolations: true },
    components: [{
      address: 'aws_db_instance.primary',
      tfType: 'aws_db_instance',
      tfName: 'primary',
      technology: 'RDS',
      type: 'postgres',
      currentVersion: '14',
      policyComponents: [{
        policyId: '10',
        policyName: 'Supported version',
        status: 'outdated',
        currentVersion: '14',
        recommendedVersion: '16',
      }],
    }],
    evaluation: {
      evaluatedPolicies: [{ policyId: '10', name: 'Supported version' }],
      unevaluatedPolicies: [],
      componentsFullyEvaluated: 1,
      componentsWithGaps: [],
    },
    coverage: { unmappedResources: [], mergedResources: [], skippedResources: [] },
    ...overrides,
  }
}
