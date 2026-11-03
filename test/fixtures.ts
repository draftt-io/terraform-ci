import type { ScanResponse } from '../src/contracts.ts'

export function scanResponse(overrides: Partial<ScanResponse> = {}): ScanResponse {
  return {
    components: [{
      address: 'aws_db_instance.primary',
      tfType: 'aws_db_instance',
      technology: 'RDS',
      type: 'postgres',
      currentVersion: '14',
      policyComponents: [{
        policyName: 'Supported version',
        status: 'outdated',
        recommendedVersion: '16',
      }],
    }],
    evaluation: {
      unevaluatedPolicies: [],
      componentsWithGaps: [],
    },
    coverage: { unmappedResources: [] },
    ...overrides,
  }
}
